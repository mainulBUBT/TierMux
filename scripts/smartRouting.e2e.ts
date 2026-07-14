// End-to-end proof that Smart Auto routing OVERCOMES slowness through the real
// Router.route() path — not the ScoringEngine in isolation (scoring.e2e.ts does
// that) but the full loop: route() streams a real (faked) response, captures
// latency into the real MetricsStore, and a later auto route() calls the real
// ScoringEngine to demote the slow model below a fast one — even though the slow
// model is HIGHER priority in settings.
//
// Everything real except global.fetch (faked) and Date.now (a mutable virtual
// clock the fake fetch advances by each model's latency, so "20s" costs 0s wall).
//
// Run:  npm run test:e2e:smart-routing
import { Router } from '../src/router/router';
import { MetricsStore } from '../src/router/metricsStore';
import { ScoringEngine } from '../src/router/scoring';
import type { SecretStore } from '../src/config/secrets';
import type { SettingsStore } from '../src/config/settingsStore';
import type { Catalog } from '../src/catalog/catalog';
import type { UsageTracker } from '../src/config/usage';
import type { CatalogModel, FallbackEntry, Platform } from '../src/shared/types';
import type * as vscode from 'vscode';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// ---- virtual clock: fake fetch advances it; Date.now reads it ----
let clock = 1_000_000;
const realNow = Date.now;
Date.now = () => clock;

// slow model on a skipPreflight platform (no preflight fetch to reason about),
// fast model on another skipPreflight platform. Equal catalog fitness so RUNTIME
// (learned latency) is the only thing that can separate them.
const SLOW: FallbackEntry = { platform: 'ollama' as Platform, modelId: 'slow-model', enabled: true, priority: 0 };
const FAST: FallbackEntry = { platform: 'github' as Platform, modelId: 'fast-model', enabled: true, priority: 1 };
const LATENCY: Record<string, number> = { 'slow-model': 20_000, 'fast-model': 800 };

function model(e: FallbackEntry): CatalogModel {
  return {
    platform: e.platform, modelId: e.modelId, displayName: e.modelId,
    intelligenceRank: 3, speedRank: 3, sizeLabel: '', contextWindow: 32768,
    rpmLimit: null, rpdLimit: null, monthlyTokenBudget: '',
    supportsTools: true, supportsVision: false, supportsReasoning: false,
  };
}
const MODELS = [model(SLOW), model(FAST)];

function makeRouter(): { router: Router; metrics: MetricsStore } {
  const secrets: Partial<SecretStore> = {
    cooldownRemaining: () => 0,
    getModelKey: async () => undefined,
    resolveKey: async () => 'fake-key',
    isToolIncompatible: () => false,
    isDeprecated: () => false,
    setStatus: () => {},
    setCooldownForKey: () => {},
    setCooldown: () => {},
    keyCooldownRemaining: () => 0,
    getKeys: async () => ['fake-key'],
    markToolIncompatible: () => {},
    markDeprecated: () => {},
  };
  const settings: Partial<SettingsStore> = {
    enabledByPriority: () => [SLOW, FAST], // slow model is HIGHER priority on purpose
    getCustomEndpoints: () => [],
    getEndpoint: () => undefined,
  };
  const catalog: Partial<Catalog> = {
    find: (p: string, id: string) => MODELS.find((m) => m.platform === p && m.modelId === id),
  };
  const usage: Partial<UsageTracker> = { add: () => {} };

  const mem: vscode.Memento = (() => {
    const data: Record<string, unknown> = {};
    return {
      get<T>(k: string, d?: T): T { return (data[k] as T) ?? (d as T); },
      keys: () => Object.keys(data),
      update(k: string, v: unknown) { data[k] = v; return Promise.resolve(); },
      setKeysForSync() {},
    } as vscode.Memento;
  })();
  const metrics = new MetricsStore(mem);
  const scoring = new ScoringEngine(catalog as Catalog, metrics);
  const router = new Router(
    secrets as SecretStore, settings as SettingsStore, catalog as Catalog, usage as UsageTracker,
    undefined, undefined, undefined, metrics, scoring,
  );
  return { router, metrics };
}

// Fake fetch: reads the request body's `model`, advances the virtual clock by that
// model's latency, and returns a successful non-streaming completion.
function installFetch(): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    let modelId = 'fast-model';
    try { modelId = JSON.parse(String(init?.body ?? '{}')).model ?? modelId; } catch { /* ping etc. */ }
    clock += LATENCY[modelId] ?? 50; // advance the virtual clock = observed latency
    return {
      ok: true, status: 200,
      json: async () => ({
        id: 'x', object: 'chat.completion', created: 0, model: modelId,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as unknown as Response;
  }) as typeof fetch;
  return () => { globalThis.fetch = realFetch; };
}

async function main() {
  const { router, metrics } = makeRouter();
  const restore = installFetch();
  const msgs = [{ role: 'user' as const, content: 'hi' }];

  try {
    // ---- Warm-up: sample BOTH models through the real route() capture path ----
    // Force each model a few times so its real latency lands in MetricsStore via
    // the router's own success-recording code (not a synthetic seed()).
    for (let i = 0; i < 5; i++) {
      await router.route(msgs, { model: 'github::fast-model', taskKind: 'chat' });
      await router.route(msgs, { model: 'ollama::slow-model', taskKind: 'chat' });
    }

    const slowAgg = metrics.modelAgg('ollama', 'slow-model', 'chat');
    const fastAgg = metrics.modelAgg('github', 'fast-model', 'chat');
    ok('warm-up: slow model latency learned (~20s baseline)', metrics.totalBaseline(slowAgg) > 10_000);
    ok('warm-up: fast model latency learned (~0.8s baseline)', metrics.totalBaseline(fastAgg) < 3_000);
    ok('warm-up: both models sampled >= minSamples', metrics.sampleCount(slowAgg) >= 3 && metrics.sampleCount(fastAgg) >= 3);

    // ---- The real test: an AUTO route (smartScoring default-on, no forced model).
    // The slow model is higher priority; smart routing must still pick the fast one.
    let ordered: FallbackEntry[] = [];
    let pickedFirst = '';
    const res = await router.route(msgs, {
      taskKind: 'chat',
      onSelectionRationale: (info) => {
        ordered = info.rationale.map((r) => `${r.platform}::${r.modelId}`) as unknown as FallbackEntry[];
        pickedFirst = info.picked ? `${info.picked.platform}::${info.picked.modelId}` : '';
      },
    });

    ok('AUTO route ranks the FAST model first despite the slow one being higher priority',
      pickedFirst === 'github::fast-model');
    ok('AUTO route actually completed on the fast model', res.model === 'fast-model');
    console.log('   rationale order:', ordered.join('  >  '));

    // ---- Control: with a genuine cold catalog (no metrics), priority order holds. Margin-gated
    // exploration perturbs a cold tie a minority of the time, so assert the MODAL outcome over N
    // fresh cold routers rather than a single flaky draw. ----
    const N = 15;
    let slowFirst = 0;
    for (let i = 0; i < N; i++) {
      const { router: cold } = makeRouter();
      let coldFirst = '';
      await cold.route(msgs, {
        taskKind: 'chat',
        onSelectionRationale: (info) => { coldFirst = info.picked ? `${info.picked.platform}::${info.picked.modelId}` : ''; },
      });
      if (coldFirst === 'ollama::slow-model') slowFirst++;
    }
    ok(`cold start (no learned metrics) keeps priority order — slow model first in the majority (${slowFirst}/${N})`,
      slowFirst > N / 2);
  } finally {
    restore();
    Date.now = realNow;
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { Date.now = realNow; console.error('FATAL', err); process.exit(1); });
