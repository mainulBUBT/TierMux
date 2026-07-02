// Deterministic test of the circuit-breaker hardening in router.ts (markHealth /
// healthOf / cooldownFor / markProbing). Two layers:
//   - White-box: the breaker state machine itself, via (router as any), with
//     Date.now() monkey-patched for deterministic timing (no real waiting).
//   - Black-box: a real Router.route() call against a fake global.fetch, to prove
//     the breaker is actually wired into (and correctly bypassed for) selection.
//
// Run:  npm run test:e2e:breaker
// (bundles to dist/circuitBreaker.e2e.cjs — gitignored — and runs it)
import { Router, AllModelsFailedError } from '../src/router/router';
import type { SecretStore } from '../src/config/secrets';
import type { SettingsStore } from '../src/config/settingsStore';
import type { Catalog } from '../src/catalog/catalog';
import type { UsageTracker } from '../src/config/usage';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

function withTime<T>(ts: number, fn: () => T): T {
  const real = Date.now;
  Date.now = () => ts;
  try { return fn(); } finally { Date.now = real; }
}

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
    enabledByPriority: () => [],
    getCustomEndpoints: () => [],
    getEndpoint: () => undefined,
  };
  const catalog: Partial<Catalog> = { find: () => undefined };
  const usage: Partial<UsageTracker> = { add: () => {} };
  return new Router(secrets as SecretStore, settings as SettingsStore, catalog as Catalog, usage as UsageTracker);
}

async function main() {
  // --- Scenario 1: first failure → cooldown 60s -----------------------------
  {
    const r = makeRouter() as any;
    const t = 1_000_000;
    withTime(t, () => r.markHealth('groq', 'm1', 'bad', 'network'));
    ok('S1: bad right after first failure', withTime(t + 1_000, () => r.healthOf('groq', 'm1')) === 'bad');
    ok('S1: still bad just under 60s', withTime(t + 59_999, () => r.healthOf('groq', 'm1')) === 'bad');
    ok('S1: half-open once 60s elapses', withTime(t + 60_001, () => r.healthOf('groq', 'm1')) === 'half-open');
  }

  // --- Scenario 2: consecutive failures → 60s → 120s → 240s → 480s → 600s (cap) --
  {
    const r = makeRouter() as any;
    const t = 2_000_000;
    const cooldowns: number[] = [];
    for (let i = 1; i <= 6; i++) {
      withTime(t, () => r.markHealth('groq', 'm2', 'bad', 'network'));
      cooldowns.push(r.cooldownFor(r.health.get('groq::m2').failureStreak));
    }
    ok(
      'S2: cooldown grows 60s→120s→240s→480s→600s and caps at 600s',
      JSON.stringify(cooldowns) === JSON.stringify([60_000, 120_000, 240_000, 480_000, 600_000, 600_000]),
    );
  }

  // --- Scenario 3: success resets failureStreak to 0 ------------------------
  {
    const r = makeRouter() as any;
    const t = 3_000_000;
    withTime(t, () => {
      r.markHealth('groq', 'm3', 'bad', 'network');
      r.markHealth('groq', 'm3', 'bad', 'network');
      r.markHealth('groq', 'm3', 'bad', 'network');
    });
    const streakBefore = r.health.get('groq::m3').failureStreak;
    withTime(t, () => r.markHealth('groq', 'm3', 'ok'));
    const streakAfter = r.health.get('groq::m3').failureStreak;
    ok('S3: streak reaches 3 after 3 failures', streakBefore === 3);
    ok('S3: a success resets failureStreak to 0', streakAfter === 0);
  }

  // --- Scenario 4 & 5: exactly one concurrent caller gets the half-open probe --
  {
    const r = makeRouter() as any;
    const t = 4_000_000;
    withTime(t, () => r.markHealth('groq', 'm4', 'bad', 'network'));
    const afterCooldown = t + 61_000;
    const firstCaller = withTime(afterCooldown, () => r.healthOf('groq', 'm4'));
    ok('S4: first caller after cooldown sees half-open (may probe)', firstCaller === 'half-open');
    withTime(afterCooldown, () => r.markProbing('groq', 'm4'));
    const secondCaller = withTime(afterCooldown, () => r.healthOf('groq', 'm4'));
    ok('S5: second concurrent caller sees bad (skips, does not double-probe)', secondCaller === 'bad');
  }

  // --- Scenario 6: skipPreflight providers bypass the breaker entirely ------
  // 'github' is registered with skipPreflight: true (src/providers/index.ts).
  {
    const r = makeRouter() as any;
    (r as Router as any).markHealth('github', 'test-model', 'bad', 'network'); // simulate a very recent failure
    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'x', object: 'chat.completion', created: 0, model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as unknown as Response;
    }) as typeof fetch;
    try {
      const result = await (r as Router).route([{ role: 'user', content: 'hello' }], { model: 'github::test-model' });
      ok('S6: skipPreflight provider still attempted despite cached "bad" state', fetchCalls === 1);
      ok('S6: request succeeded', result.model === 'test-model');
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // --- Scenario 7: existing routing behavior is unchanged -------------------
  // 'groq' has no skipPreflight (default false) — a cached "bad" state should
  // still skip the model entirely (0 fetch calls), same as pre-hardening.
  {
    const r = makeRouter() as any;
    (r as Router as any).markHealth('groq', 'm7', 'bad', 'network');
    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { fetchCalls++; return { ok: true, status: 200, json: async () => ({}) } as unknown as Response; }) as typeof fetch;
    try {
      let threw: unknown;
      try {
        await (r as Router).route([{ role: 'user', content: 'hello' }], { model: 'groq::m7' });
      } catch (e) { threw = e; }
      ok('S7: cached-bad non-skipPreflight model is skipped (no fetch)', fetchCalls === 0);
      ok('S7: route() surfaces AllModelsFailedError when the only candidate is skipped', threw instanceof AllModelsFailedError);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // --- Scenario 7b: a fresh (never-seen) model still preflights + requests, --
  // exactly like before this change (undefined health → probe → request).
  {
    const r = makeRouter() as any;
    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'x', object: 'chat.completion', created: 0, model: 'm7b',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as unknown as Response;
    }) as typeof fetch;
    try {
      const result = await (r as Router).route([{ role: 'user', content: 'hello' }], { model: 'groq::m7b' });
      ok('S7b: fresh model does a preflight ping + the real request (2 fetch calls)', fetchCalls === 2);
      ok('S7b: request succeeded', result.model === 'm7b');
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
