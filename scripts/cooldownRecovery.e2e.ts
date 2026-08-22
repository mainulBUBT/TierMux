// End-to-end proof that Auto routing SURVIVES platform rate-limit cooldowns instead of dying
// with "All N configured models are unavailable" while most of the enabled chain sits in a
// seconds-long cooldown.
//
// Reproduces the reported failure shape: many models enabled across two providers, ONE 429
// puts the whole big provider into cooldown, the old candidates() dropped it entirely, and the
// tiny ready remainder failing ended the turn. The fix keeps cooling providers at the tail of
// the candidate list, waits out SHORT cooldowns before attempting them (< COOLDOWN_WAIT_CAP_MS),
// attempts long-cooling ones immediately (old nothing-ready behavior), and never wastes a
// request on cooling providers while a healthy ready one can serve.
//
// Everything real except global.fetch (faked) and SecretStore (per-platform cooldown map).
// Run:  npm run test:e2e:cooldown-recovery
import { Router } from '../src/router/router';
import { MetricsStore } from '../src/router/metricsStore';
import { ScoringEngine } from '../src/router/scoring';
import { AllModelsFailedError } from '../src/router/router';
import type { SecretStore } from '../src/config/secrets';
import type { SettingsStore } from '../src/config/settingsStore';
import type { Catalog } from '../src/catalog/catalog';
import type { UsageTracker } from '../src/config/usage';
import type { CatalogModel, FallbackEntry, Platform } from '../src/shared/types';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const READY: FallbackEntry = { platform: 'groq' as Platform, modelId: 'ready-model', enabled: true, priority: 0 };
const COOL_A: FallbackEntry = { platform: 'ollama' as Platform, modelId: 'cool-a', enabled: true, priority: 1 };
const COOL_B: FallbackEntry = { platform: 'ollama' as Platform, modelId: 'cool-b', enabled: true, priority: 2 };
const COOL_C: FallbackEntry = { platform: 'ollama' as Platform, modelId: 'cool-c', enabled: true, priority: 3 };
const ALL = [READY, COOL_A, COOL_B, COOL_C];

function model(e: FallbackEntry): CatalogModel {
  return {
    platform: e.platform, modelId: e.modelId, displayName: e.modelId,
    intelligenceRank: 3, speedRank: 3, sizeLabel: '', contextWindow: 32768,
    rpmLimit: null, rpdLimit: null, monthlyTokenBudget: '',
    supportsTools: true, supportsVision: false, supportsReasoning: false,
  };
}
const MODELS = ALL.map(model);

/** Per-platform cooldown left in ms — mutated per scenario. */
let coolMs: Record<string, number> = {};
/** What the fake fetch saw, in order. */
let requested: string[] = [];
/** Behavior override per model id: 'fail500' | 'ratelimit429' | default success. */
let behavior: Record<string, 'fail500' | 'ratelimit429'> = {};

function makeRouter(): Router {
  const secrets: Partial<SecretStore> = {
    cooldownRemaining: (p: string) => coolMs[p] ?? 0,
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
    snapshot: async () => [],
  };
  const settings: Partial<SettingsStore> = {
    enabledByPriority: () => ALL,
    getCustomEndpoints: () => [],
    getEndpoint: () => undefined,
  };
  const catalog: Partial<Catalog> = {
    find: (p: string, id: string) => MODELS.find((m) => m.platform === p && m.modelId === id),
  };
  const usage: Partial<UsageTracker> = { add: () => {} };

  const mem: import('vscode').Memento = (() => {
    const data: Record<string, unknown> = {};
    return {
      get<T>(k: string, d?: T): T { return (data[k] as T) ?? (d as T); },
      keys: () => Object.keys(data),
      update(k: string, v: unknown) { data[k] = v; return Promise.resolve(); },
      setKeysForSync() {},
    } as import('vscode').Memento;
  })();
  const metrics = new MetricsStore(mem);
  const scoring = new ScoringEngine(catalog as Catalog, metrics);
  return new Router(
    secrets as SecretStore, settings as SettingsStore, catalog as Catalog, usage as UsageTracker,
    undefined, undefined, undefined, metrics, scoring,
  );
}

function installFetch(): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    let modelId = 'ready-model';
    try { modelId = JSON.parse(String(init?.body ?? '{}')).model ?? modelId; } catch { /* ping */ }
    if (modelId.startsWith('cool')) requested.push(modelId);
    const b = behavior[modelId];
    if (b === 'fail500') {
      return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'upstream exploded', json: async () => ({}) } as unknown as Response;
    }
    if (b === 'ratelimit429') {
      return { ok: false, status: 429, headers: { get: () => null }, text: async () => 'rate limited', json: async () => ({}) } as unknown as Response;
    }
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

const MSGS = [{ role: 'user' as const, content: 'hi' }];

async function main() {
  const restore = installFetch();

  try {
    // ---- Scenario 1: happy path — a cooling provider must NOT be contacted at all ----
    {
      requested = []; behavior = {}; coolMs = { ollama: 120_000 };
      const r = makeRouter();
      const res = await r.route(MSGS, { taskKind: 'chat' });
      ok('S1: route succeeds on the ready model', res.model === 'ready-model');
      ok('S1: no request wasted on the cooling provider', requested.length === 0);
    }

    // ---- Scenario 2: short cooldown — ready fails, router WAITS OUT the cooldown and
    // recovers on the previously-cooling provider (the old code died here) ----
    {
      requested = []; behavior = { 'ready-model': 'fail500' }; coolMs = { ollama: 60 };
      const r = makeRouter();
      const t0 = Date.now();
      const res = await r.route(MSGS, { taskKind: 'chat' });
      ok('S2: recovers on the cooling provider after the ready one failed', res.model === 'cool-a');
      ok(`S2: waited out the short cooldown (~60ms, took ${Date.now() - t0}ms)`, Date.now() - t0 >= 40);
      ok('S2: exactly one cooling model attempted', requested.filter((m) => m.startsWith('cool')).length === 1);
    }

    // ---- Scenario 3: honest accounting — when EVERYTHING fails, the failure report must
    // include the cooling providers too (old message claimed only the ready ones existed) ----
    {
      requested = [];
      behavior = { 'ready-model': 'fail500', 'cool-a': 'ratelimit429', 'cool-b': 'ratelimit429', 'cool-c': 'ratelimit429' };
      coolMs = { ollama: 600_000 }; // longer than the wait cap → attempted immediately
      const r = makeRouter();
      let err: AllModelsFailedError | undefined;
      try { await r.route(MSGS, { taskKind: 'chat' }); } catch (e) { err = e as AllModelsFailedError; }
      ok('S3: turn fails with AllModelsFailedError', !!err);
      const n = err?.failures.length ?? 0;
      ok(`S3: failure report covers ALL configured models, not just the ready ones (${n}/4)`, n === 4);
      const rl = err?.failures.filter((f) => f.reason === 'rate_limited').length ?? 0;
      ok(`S3: cooling models reported as rate_limited (${rl})`, rl === 3);
      ok('S3: message names every attempted model count', (err?.message ?? '').includes('All 4 configured models'));
    }

    // ---- Scenario 4: ordering — after Smart-Auto re-ranking, ready candidates stay ahead
    // of cooling ones (the scorer doesn't know about provider cooldowns) ----
    {
      requested = []; behavior = {}; coolMs = { ollama: 30_000 };
      const r = makeRouter();
      const res = await r.route(MSGS, { taskKind: 'agent' }); // requireTools-ish heavy kind
      ok('S4: serves from the ready provider even with smart scoring active', res.model === 'ready-model');
      ok('S4: zero requests to the cooling provider', requested.length === 0);
    }
  } finally {
    restore();
  }

  console.log(failures === 0 ? '\nALL PASS' : `\nFAILED: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
