// Proof for the LLM task-classifier (classifyTaskSmart) and its model chain
// (Router.pickClassifierModel):
//   1. Chain order — user setting wins, then the keyless favorites opencode → kilo → ovh,
//      then any ready enabled model on those platforms; none available → undefined (regex only).
//   2. Fail-safety — unavailable classifier model, unparseable reply, and an invalid kind all
//      fall back to the regex classification; a valid {"kind": ...} reply is honored.
//
// Everything real except the Router's network path (a structural fake route() for the LLM call,
// the same shape createRouterProvider consumes) — no model, no quota.
//
// Run:  npm run test:e2e:smart-classify
import { Router } from '../src/router/router';
import { classifyTaskSmart } from '../src/agent/core/loop';
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

function model(e: FallbackEntry): CatalogModel {
  return {
    platform: e.platform, modelId: e.modelId, displayName: e.modelId,
    intelligenceRank: 3, speedRank: 3, sizeLabel: '', contextWindow: 32768,
    rpmLimit: null, rpdLimit: null, monthlyTokenBudget: '',
    supportsTools: true, supportsVision: false, supportsReasoning: false,
  };
}

function makeRouter(entries: FallbackEntry[]): Router {
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
    enabledByPriority: () => entries,
    getCustomEndpoints: () => [],
    getEndpoint: () => undefined,
  };
  const catalog: Partial<Catalog> = {
    find: (p: string, id: string) => entries.filter((e) => e.platform === p && e.modelId === id).map(model)[0],
  };
  const usage: Partial<UsageTracker> = { add: () => {} };
  return new Router(
    secrets as SecretStore, settings as SettingsStore, catalog as Catalog, usage as UsageTracker,
    undefined, undefined, undefined, undefined, undefined,
  );
}

const OC: FallbackEntry = { platform: 'opencode' as Platform, modelId: 'deepseek-v4-flash-free', enabled: true, priority: 0 };
const KILO: FallbackEntry = { platform: 'kilo' as Platform, modelId: 'kilo-auto/free', enabled: true, priority: 1 };
const OVH: FallbackEntry = { platform: 'ovh' as Platform, modelId: 'gpt-oss-120b', enabled: true, priority: 2 };
const OTHER: FallbackEntry = { platform: 'groq' as Platform, modelId: 'fast-model', enabled: true, priority: 0 };

async function main() {
  console.log('— pickClassifierModel chain order —');
  ok('all three enabled → opencode favorite', (await makeRouter([OC, KILO, OVH, OTHER]).pickClassifierModel()) === 'opencode::deepseek-v4-flash-free');
  ok('opencode absent → kilo favorite', (await makeRouter([KILO, OVH, OTHER]).pickClassifierModel()) === 'kilo::kilo-auto/free');
  ok('only kilo+ovh, kilo disabled-by-absence… → ovh favorite', (await makeRouter([OVH, OTHER]).pickClassifierModel()) === 'ovh::gpt-oss-120b');
  ok('none of the chain enabled → undefined (regex only)', (await makeRouter([OTHER]).pickClassifierModel()) === undefined);
  ok('favorites absent but platform models enabled → first ready on opencode', (await makeRouter([{ platform: 'opencode' as Platform, modelId: 'other-model', enabled: true, priority: 0 }, OTHER]).pickClassifierModel()) === 'opencode::other-model');

  console.log('\n— classifyTaskSmart fail-safety —');
  const regexFallback = 'debug' as const;
  // No classifier model available → regex kind stands, no throw:
  const noModel = await classifyTaskSmart({ pickClassifierModel: async () => undefined } as unknown as Router, 'login kaj korche na', [], regexFallback);
  ok('no classifier model → regex kind', noModel === regexFallback);

  // Structural fake Router whose route() replies with the given content — the exact shape
  // createRouterProvider's doGenerate consumes.
  const fakeLlmRouter = (content: string): Router => ({
    pickClassifierModel: async () => 'opencode::deepseek-v4-flash-free',
    route: async () => ({
      platform: 'opencode', model: 'deepseek-v4-flash-free',
      response: {
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    }),
  }) as unknown as Router;

  const debug = await classifyTaskSmart(fakeLlmRouter('Sure!\n{"kind":"debug"}'), 'login kaj korche na', [], 'chat' as const);
  ok('valid {"kind":"debug"} reply → debug (overrides regex chat)', debug === 'debug');
  const garbage = await classifyTaskSmart(fakeLlmRouter('I think this is probably a bug report of some sort.'), 'login kaj korche na', [], regexFallback);
  ok('prose reply without JSON → regex kind', garbage === regexFallback);
  const invalidKind = await classifyTaskSmart(fakeLlmRouter('{"kind":"banana"}'), 'login kaj korche na', [], regexFallback);
  ok('invalid kind → regex kind', invalidKind === regexFallback);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
