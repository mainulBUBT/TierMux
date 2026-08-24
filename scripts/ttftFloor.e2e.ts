// Regression lock for the uncapped local/custom-endpoint timing policy.
//
// Captured live 2026-08-23: a user's custom OpenAI-compatible endpoint
// (`custom/c_…::prism-ml/bonsai-27b`, a 27B model on local-class hardware) failed on EVERY
// attempt with `ttft timeout: This operation was aborted` — the router's cloud-tuned 8s TTFT
// fast-failover gate aborted the stream before the model's first token, and the 10-minute
// request cap could still cut long local generations mid-answer. Per user direction, custom
// endpoints now run with NO request timeout and NO TTFT gate: a local model takes as long as
// it takes, and the Stop button is the only brake. Cloud providers keep the global rules, and
// a positive provider floor remains supported for future slow-cloud providers.
//
// Run: npm run test:e2e:ttft-floor
import { Router } from '../src/router/router';
import { resolveProvider } from '../src/providers/index';
import type { SecretStore } from '../src/config/secrets';
import type { SettingsStore } from '../src/config/settingsStore';
import type { Catalog } from '../src/catalog/catalog';
import type { UsageTracker } from '../src/config/usage';
import type { CustomEndpoint } from '../src/shared/types';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

function makeRouter(): Router {
  const secrets: Partial<SecretStore> = {
    cooldownRemaining: () => 0, getModelKey: async () => undefined, resolveKey: async () => 'k',
    isToolIncompatible: () => false, isDeprecated: () => false, setStatus: () => {},
    setCooldownForKey: () => {}, setCooldown: () => {}, keyCooldownRemaining: () => 0,
    getKeys: async () => ['k'], markToolIncompatible: () => {}, markDeprecated: () => {},
  };
  const settings: Partial<SettingsStore> = {
    enabledByPriority: () => [], getCustomEndpoints: () => [], getEndpoint: () => undefined,
  };
  const catalog: Partial<Catalog> = { find: () => undefined };
  const usage: Partial<UsageTracker> = { add: () => {} };
  return new Router(secrets as SecretStore, settings as SettingsStore, catalog as Catalog, usage as UsageTracker);
}

const ENDPOINT: CustomEndpoint = {
  id: 'c_test1', name: 'Local server', baseUrl: 'http://127.0.0.1:1234/v1',
  models: [{ id: 'prism-ml/bonsai-27b' }] as CustomEndpoint['models'],
};

async function main() {
  const cfg = (globalThis as any).__tiermuxTestConfig ?? {};

  // ── Provider wiring: the REAL custom-endpoint provider declares "no caps".
  const provider = resolveProvider('custom', 'c_test1::prism-ml/bonsai-27b', [ENDPOINT])!;
  ok('custom provider resolves', !!provider);
  ok('custom provider declares NO TTFT gate (ttftTimeoutMs === 0)', provider.ttftTimeoutMs === 0);
  ok('custom provider declares NO request cap (timeoutMs === 0 at runtime)', (provider as any).timeoutMs === 0);

  // ── Router gate math (private methods via `any`, same contract-test pattern as circuitBreaker.e2e).
  const r = makeRouter() as any;

  // Custom provider: both caps fully disabled — the model takes as long as it takes.
  (globalThis as any).__tiermuxTestConfig = { ...cfg };
  ok('custom provider: TTFT gate disabled end-to-end', r.ttftTimeoutMsFor(provider) === 0);
  ok('custom provider: request timeout disabled (0, not lifted to the 30s global)', r.timeoutMsFor(provider) === 0);

  // Cloud providers: the global rules are unchanged.
  ok('no-floor provider: global 8s TTFT default applies', r.ttftTimeoutMsFor({}) === 8_000);
  ok('no-floor provider: global 90s request timeout default applies', r.timeoutMsFor({}) === 90_000);

  // A positive provider floor remains supported (future slow-cloud providers).
  ok('positive floor within its own request budget survives',
    r.ttftTimeoutMsFor({ ttftTimeoutMs: 60_000, timeoutMs: 600_000 }) === 60_000);
  ok('positive floor clamped to the provider request budget when tighter',
    r.ttftTimeoutMsFor({ ttftTimeoutMs: 120_000 }) === 90_000);

  // A globally-disabled TTFT gate (user set 0) stays disabled for floor providers.
  (globalThis as any).__tiermuxTestConfig = { ...cfg, ttftTimeoutMs: 0 };
  ok('global 0 disables the gate even for a floor provider', r.ttftTimeoutMsFor({ ttftTimeoutMs: 60_000 }) === 0);

  // A user-tuned lower global value never overrides a provider's explicit 0 (disabled) policy.
  (globalThis as any).__tiermuxTestConfig = { ...cfg, ttftTimeoutMs: 4_000 };
  ok('user-tuned 4s global never re-caps a custom endpoint', r.ttftTimeoutMsFor(provider) === 0);

  (globalThis as any).__tiermuxTestConfig = cfg;

  // Pinned (non-Auto) models: the user explicitly chose to wait for THAT model — there is no
  // failover the caps would unblock, so a fast abort could only manufacture a "failed
  // (timeout)". Same policy as custom endpoints: no request cap, no TTFT gate; Stop is the brake.
  ok('pinned model: request cap lifted (0, not the 90s global)', r.requestCapMs({}, true) === 0);
  ok('pinned model: explicit caller cap still honored when pinned', r.requestCapMs({}, true, 15_000) === 15_000);
  ok('pinned model: TTFT gate skipped even while streaming', r.ttftGateMs({}, true, true) === 0);
  ok('auto keeps the 90s global request cap', r.requestCapMs({}, false) === 90_000);
  ok('auto streaming keeps the 8s TTFT gate', r.ttftGateMs({}, true, false) === 8_000);
  ok('non-streaming turns never get a TTFT gate', r.ttftGateMs({}, false, false) === 0);
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
