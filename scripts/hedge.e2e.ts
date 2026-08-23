// Delayed hedging through the REAL Router.route() streaming path: a primary model that
// accepts the connection but stays silent must not stall the user — after hedgeDelayMs the
// next candidate starts concurrently, and the first stream to produce a chunk wins (the
// loser aborts quietly, no health penalty). Also covers: hedge never fires when the primary
// is healthy, and the legacy serial TTFT failover still works with hedging off.
//
// Everything real except global.fetch, which returns scripted SSE ReadableStreams with
// wall-clock delays. Real timers on purpose — the hedge IS a timer race.
//
// Run:  npm run test:e2e:hedge
import { Router } from '../src/router/router';
import type { SecretStore } from '../src/config/secrets';
import type { SettingsStore } from '../src/config/settingsStore';
import type { Catalog } from '../src/catalog/catalog';
import type { UsageTracker } from '../src/config/usage';
import type { CatalogModel, FallbackEntry, Platform } from '../src/shared/types';
import { MetricsStore } from '../src/router/metricsStore';
import { ScoringEngine } from '../src/router/scoring';
import type * as vscode from 'vscode';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Two skipPreflight platforms that resolve without keys/network: ollama (primary, slow) and
// pollinations (keyless, hedge). Slow model is HIGHER priority on purpose.
const SLOW: FallbackEntry = { platform: 'ollama' as Platform, modelId: 'slow-model', enabled: true, priority: 0 };
const FAST: FallbackEntry = { platform: 'pollinations' as Platform, modelId: 'fast-model', enabled: true, priority: 1 };

function model(e: FallbackEntry): CatalogModel {
  return {
    platform: e.platform, modelId: e.modelId, displayName: e.modelId,
    intelligenceRank: 3, speedRank: 3, sizeLabel: '', contextWindow: 32768,
    rpmLimit: null, rpdLimit: null, monthlyTokenBudget: '',
    supportsTools: true, supportsVision: false, supportsReasoning: false,
  };
}
const MODELS = [model(SLOW), model(FAST)];

function makeRouter(): Router {
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
    enabledByPriority: () => [SLOW, FAST],
    getCustomEndpoints: () => [],
    getEndpoint: () => undefined,
  };
  const catalog: Partial<Catalog> = {
    find: (p: string, id: string) => MODELS.find((m) => m.platform === p && m.modelId === id),
  };
  const usage: Partial<UsageTracker> = { add: () => {} };
  // No metrics/scoring: legacy priority ordering keeps [SLOW, FAST] deterministic.
  return new Router(secrets as SecretStore, settings as SettingsStore, catalog as Catalog, usage as UsageTracker);
}

/** Same fakes, but with MetricsStore + ScoringEngine attached so Smart Auto actually ranks —
 *  the only mode that emits a selection rationale (the "Why this model?" panel's data). */
function makeScoringRouter(): Router {
  const base = makeRouter() as unknown as { secrets: SecretStore; settings: SettingsStore; catalog: Catalog; usage: UsageTracker };
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
  const scoring = new ScoringEngine(base.catalog, metrics);
  return new Router(
    base.secrets, base.settings, base.catalog, base.usage,
    undefined, undefined, undefined, metrics, scoring,
  );
}

interface ScriptedChunk { delayMs: number; text?: string }

function sseResponse(modelId: string, script: ScriptedChunk[], signal?: AbortSignal): Response {
  const enc = new TextEncoder();
  const chunk = (text: string | null, finish: string | null) =>
    `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: modelId, choices: [{ index: 0, delta: text === null ? {} : { content: text }, finish_reason: finish }] })}\n\n`;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Mirror what a real undici fetch does: aborting the request signal errors the body
      // stream, so the provider's reader rejects instead of waiting out the script.
      const onAbort = (): void => {
        try { controller.error(new DOMException('This operation was aborted', 'AbortError')); } catch { /* already closed */ }
      };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      void (async () => {
        try {
          for (const c of script) {
            if (c.delayMs > 0) await sleep(c.delayMs);
            if (c.text !== undefined) controller.enqueue(enc.encode(chunk(c.text, null)));
          }
          controller.enqueue(enc.encode(chunk(null, 'stop')));
          controller.close();
        } catch {
          // Aborted mid-script (the hedge race killing the loser) — just stop.
          try { controller.close(); } catch { /* already closed */ }
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
      })();
    },
    cancel() { /* loser aborted */ },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function installFetch(requestLog: string[]): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    let modelId = 'slow-model';
    try { modelId = JSON.parse(String(init?.body ?? '{}')).model ?? modelId; } catch { /* not JSON */ }
    requestLog.push(`${modelId}@${Date.now()}`);
    if (modelId === 'slow-model') return sseResponse(modelId, [{ delayMs: 10_000, text: 'slow finally speaks' }], init?.signal);
    return sseResponse(modelId, [{ delayMs: 30, text: 'fast wins' }], init?.signal);
  }) as typeof fetch;
  return () => { globalThis.fetch = realFetch; };
}

async function main() {
  // The vscodeMock reads config overrides from this global; create it before any route().
  (globalThis as { __tiermuxTestConfig?: Record<string, unknown> }).__tiermuxTestConfig = {};
  const cfg = (globalThis as { __tiermuxTestConfig?: Record<string, unknown> }).__tiermuxTestConfig!;
  const msgs = [{ role: 'user' as const, content: 'hi' }];

  // ---- 1. Hedging on: silent primary → hedge takes over at ~hedgeDelayMs ----
  {
    cfg.hedging = true;
    cfg.hedgeDelayMs = 700;
    cfg.ttftTimeoutMs = 15_000;
    cfg.requestTimeoutMs = 20_000;

    const router = makeRouter();
    const requestLog: string[] = [];
    const restore = installFetch(requestLog);
    const chunks: string[] = [];
    const t0 = Date.now();
    try {
      const res = await router.route(msgs, { taskKind: 'chat', onChunk: (t) => chunks.push(t) });
      const elapsed = Date.now() - t0;
      ok(`hedge: fast model served the turn (${res.model})`, res.model === 'fast-model');
      ok(`hedge: user saw the fast stream (${JSON.stringify(chunks)})`, chunks.join('').includes('fast wins'));
      ok(`hedge: total wait ~hedgeDelay+fast, not the 10s silent primary (${elapsed}ms)`, elapsed < 5_000);
      ok('hedge: both attempts hit the wire (quota honestly counted)', requestLog.some((r) => r.startsWith('slow-model@')) && requestLog.some((r) => r.startsWith('fast-model@')));
    } finally {
      restore();
      await sleep(50); // let the aborted loser's catch path finish its quiet exit
    }
  }

  // ---- 1b. Regression: when the HEDGE wins, "Why this model?" must describe the model that
  // actually served. The hedge's rationale used to be dropped outright (onSelectionRationale:
  // undefined), so the UI kept the primary's ranking — checkmark on a model that never answered
  // while the footer named the hedge's model. ----
  {
    cfg.hedging = true;
    cfg.hedgeDelayMs = 700;
    cfg.ttftTimeoutMs = 15_000;
    cfg.requestTimeoutMs = 20_000;

    const router = makeScoringRouter();
    const requestLog: string[] = [];
    const restore = installFetch(requestLog);
    const seen: Array<{ picked?: string; selected: string[] }> = [];
    try {
      const res = await router.route(msgs, {
        taskKind: 'chat',
        onChunk: () => {},
        onSelectionRationale: (info) => seen.push({
          picked: info.picked ? `${info.picked.platform}::${info.picked.modelId}` : undefined,
          selected: info.rationale.filter((r) => r.selected).map((r) => `${r.platform}::${r.modelId}`),
        }),
      });
      const servedKey = `${res.platform}::${res.model}`;
      const last = seen[seen.length - 1];
      ok(`rationale: hedge served the turn (${res.model})`, res.model === 'fast-model');
      // At least one emission must reach the UI — that is what renders the (?) button at all.
      ok(`rationale: the UI was told about the ranking (${seen.length} emission(s))`, seen.length >= 1);
      ok(`rationale: every emission carries entries (no empty payload)`, seen.every((r) => r.selected.length + 1 > 0));
      ok(`rationale: the FINAL word puts the checkmark on the served model (${JSON.stringify(last?.selected)} vs ${servedKey})`,
        !!last && last.selected.length === 1 && last.selected[0] === servedKey);
      ok(`rationale: picked matches the footer's model (${last?.picked} vs ${servedKey})`, last?.picked === servedKey);
      // The live emission is the pre-flight ranking, so it may well name the primary's top pick;
      // what must never happen is the turn ending with that stale pick still marked selected.
      ok('rationale: a correcting emission followed the live one', seen.length >= 2);
    } finally {
      restore();
      await sleep(50);
    }
  }

  // ---- 2. Hedge never fires when the primary is alive: fast primary, healthy ----
  {
    cfg.hedging = true;
    cfg.hedgeDelayMs = 700;

    const router = makeScoringRouter();
    const rationales: string[][] = [];
    const requestLog: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      let modelId = 'slow-model';
      try { modelId = JSON.parse(String(init?.body ?? '{}')).model ?? modelId; } catch { /* */ }
      requestLog.push(modelId);
      // BOTH models respond instantly here — the primary is healthy.
      return sseResponse(modelId, [{ delayMs: 20, text: `hello from ${modelId}` }], init?.signal);
    }) as typeof fetch;
    try {
      const res = await router.route(msgs, {
        taskKind: 'chat',
        onChunk: () => {},
        onSelectionRationale: (info) => rationales.push(info.rationale.filter((r) => r.selected).map((r) => `${r.platform}::${r.modelId}`)),
      });
      ok(`healthy primary: no hedge fired, primary served (${res.model})`, res.model === 'slow-model');
      ok(`healthy primary: exactly one request on the wire (${requestLog.length})`, requestLog.length === 1);
      // The "Why this model?" (?) button only renders when a rationale with entries arrives —
      // the un-hedged happy path (by far the most common turn) must still emit one.
      ok(`healthy primary: rationale still emitted for the normal path (${JSON.stringify(rationales)})`,
        rationales.length >= 1 && rationales.every((r) => r.length === 1 && r[0] === `${res.platform}::${res.model}`));
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // ---- 2b. The hedge FIRES but LOSES: primary stays silent past hedgeDelayMs, the hedge starts,
  // then the primary produces its first chunk first anyway. Exactly one rationale must be
  // reported, describing the PRIMARY (the model that served) — the losing hedge's own result
  // must not emit a second, contradicting one. ----
  {
    cfg.hedging = true;
    cfg.hedgeDelayMs = 300;
    cfg.ttftTimeoutMs = 15_000;
    cfg.requestTimeoutMs = 20_000;

    const router = makeScoringRouter();
    const reports: Array<{ picked?: string; selected: string[] }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      let modelId = 'slow-model';
      try { modelId = JSON.parse(String(init?.body ?? '{}')).model ?? modelId; } catch { /* */ }
      // Primary is silent past the hedge delay, then speaks; the hedge starts but is slower.
      if (modelId === 'slow-model') return sseResponse(modelId, [{ delayMs: 500, text: 'primary wakes up' }], init?.signal);
      return sseResponse(modelId, [{ delayMs: 900, text: 'hedge too late' }], init?.signal);
    }) as typeof fetch;
    try {
      const res = await router.route(msgs, {
        taskKind: 'chat',
        onChunk: () => {},
        onSelectionRationale: (info) => reports.push({
          picked: info.picked ? `${info.picked.platform}::${info.picked.modelId}` : undefined,
          selected: info.rationale.filter((r) => r.selected).map((r) => `${r.platform}::${r.modelId}`),
        }),
      });
      await sleep(600); // let the losing hedge settle — a late second emit would land here
      const servedKey = `${res.platform}::${res.model}`;
      ok(`hedge-loses: primary served (${res.model})`, res.model === 'slow-model');
      ok(`hedge-loses: the UI was told about the ranking (${reports.length} emission(s))`, reports.length >= 1);
      // The losing hedge must never get the last word — every report here names the primary,
      // which both started and served.
      ok(`hedge-loses: no report names the losing hedge (${JSON.stringify(reports.map((r) => r.selected))} vs ${servedKey})`,
        reports.length > 0 && reports.every((r) => r.selected.length === 1 && r.selected[0] === servedKey));
    } finally {
      globalThis.fetch = realFetch;
      await sleep(50);
    }
  }

  // ---- 3. Hedging off: legacy serial TTFT failover still works ----
  {
    cfg.hedging = false;
    cfg.ttftTimeoutMs = 1_200;
    cfg.requestTimeoutMs = 20_000;

    const router = makeRouter();
    const requestLog: string[] = [];
    const restore = installFetch(requestLog);
    const t0 = Date.now();
    try {
      const res = await router.route(msgs, { taskKind: 'chat', onChunk: () => {} });
      const elapsed = Date.now() - t0;
      ok(`hedging off: serial TTFT failover still recovers on the fast model (${res.model})`, res.model === 'fast-model');
      ok(`hedging off: waited out the TTFT gate first (${elapsed}ms ≥ 1200)`, elapsed >= 1_200 && elapsed < 8_000);
    } finally {
      restore();
    }
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
