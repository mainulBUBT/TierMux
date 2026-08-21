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

  // ---- 2. Hedge never fires when the primary is alive: fast primary, healthy ----
  {
    cfg.hedging = true;
    cfg.hedgeDelayMs = 700;

    const router = makeRouter();
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
      const res = await router.route(msgs, { taskKind: 'chat', onChunk: () => {} });
      ok(`healthy primary: no hedge fired, primary served (${res.model})`, res.model === 'slow-model');
      ok(`healthy primary: exactly one request on the wire (${requestLog.length})`, requestLog.length === 1);
    } finally {
      globalThis.fetch = realFetch;
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
