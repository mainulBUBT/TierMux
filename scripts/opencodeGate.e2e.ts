/* OpenCode v2's anonymous free tier refuses any client it does not recognise ("429 Free usage limit
 * reached", the successor of "403 FreeTierError"). It is the GATE's verdict on the request, not
 * this account's quota — so it must condemn the whole keyless lane once, instead of costing one
 * round-trip per model and then surfacing a bare 429 that reads like a transient rate limit.
 * Run: npm run test:e2e:opencode-gate */
import { selectModel, setModelSources, noteFreeTierExhausted, isLaneExhausted, laneExhaustedMs, isFreeTierRefusal, __resetTaskRoundCounters } from '../src/router/picker';
import { freeTierRemedy } from '../src/agent/core/routerProvider';
import { sessionHeaderFor } from '../src/providers';
import type { FallbackEntry } from '../src/shared/types';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const entry = (platform: string, modelId: string, priority: number): FallbackEntry =>
  ({ platform, modelId, enabled: true, priority } as unknown as FallbackEntry);

function makeSources(fallback: FallbackEntry[], keyed: string[]) {
  return {
    catalog: {
      find: (_p: string, _m: string) => ({ intelligenceRank: 1, speedRank: 1, supportsTools: true }),
    },
    settings: {
      getFallback: () => fallback,
      getDisabledProviders: () => [] as string[],
      enabledByPriority: () => fallback.filter((e) => e.enabled).sort((a, b) => a.priority - b.priority),
    },
    secrets: {
      getKeys: async (p: string) => (keyed.includes(p) ? ['sk-test'] : []),
      getCloudflareAccountId: async () => undefined,
      isToolIncompatible: () => false,
    },
  } as unknown as Parameters<typeof setModelSources>[0];
}

/** What the user actually saw, verbatim. */
const V2_REFUSAL =
  'OpenCode Zen API error 429: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go';

console.log('— the gate\'s refusal is recognised, a plain 429 is not —');
ok('the v2 429 text', isFreeTierRefusal(V2_REFUSAL));
ok('the v1 403 text', isFreeTierRefusal("OpenCode Zen API error 403: FreeTierError: OpenCode's free tier can only be used from within OpenCode"));
ok('the type name alone', isFreeTierRefusal('FreeUsageLimitError'));
ok('an ordinary per-model 429 is NOT one', !isFreeTierRefusal('Groq API error 429: Rate limit reached for model gpt-oss-120b'));
ok('nor is a spent credit balance', !isFreeTierRefusal('Cerebras API error 402: out of credit'));
ok('nor is silence', !isFreeTierRefusal(undefined));

console.log('\n— the quarantine is per PLATFORM, because the pool is —');
ok('the lane starts open', !isLaneExhausted('opencode'));
noteFreeTierExhausted('opencode');
ok('after one refusal the lane is shut', isLaneExhausted('opencode'));
ok('and reports a real window', laneExhaustedMs('opencode') > 0 && laneExhaustedMs('opencode') <= 30 * 60_000, `${Math.round(laneExhaustedMs('opencode') / 1000)}s`);
ok('another provider is untouched', !isLaneExhausted('groq'));
ok('it lifts on its own, it is not forever', !isLaneExhausted('opencode', Date.now() + 31 * 60_000));

async function main() {
  const fallback = [
    entry('opencode', 'big-pickle', 0),
    entry('opencode', 'nemotron-3-ultra-free', 1),
    entry('groq', 'openai/gpt-oss-120b', 2),
  ];
  setModelSources(makeSources(fallback, ['groq']));

  console.log('\n— selection skips the whole lane, and says why —');
  __resetTaskRoundCounters();
  const after = await selectModel([{ role: 'user', content: 'fix the bug in src/agent/agent.ts' }], { taskKind: 'agent' });
  const chain = [after.model, ...after.fallbackChain].filter(Boolean);
  ok('no opencode model is offered', chain.every((k) => !k.startsWith('opencode::')), chain.join(', '));
  ok('the chain still has a live provider', chain.some((k) => k.startsWith('groq::')), chain.join(', '));
  const reasons = (after.rationale?.entries ?? []).map((e) => `${e.model} ${e.skip ?? ''}`).join(' | ');
  ok('the skip reason names the refused client, not a spent quota', /refuses outside clients/.test(reasons), reasons);

  console.log('\n— a pinned model keeps its exemption (explicit choice, never silently rerouted) —');
  const pinned = await selectModel([{ role: 'user', content: 'hi' }], { taskKind: 'agent', pinnedModel: 'opencode::big-pickle' });
  ok('the pinned opencode model still runs alone', pinned.model === 'opencode::big-pickle', pinned.model);
  ok('with no failover padding', pinned.fallbackChain.length === 0, pinned.fallbackChain.join(', '));

  console.log('\n— the advice matches whether a key was actually sent —');
  const anon = freeTierRemedy(new Error(V2_REFUSAL), { anonymous: true, keyed: false }) ?? '';
  const keyed = freeTierRemedy(new Error(V2_REFUSAL), { anonymous: false, keyed: true }) ?? '';
  ok('anonymous refuses → names bun/Go/paid, never "add a key"', /bun\.sh/.test(anon) && /opencode\.ai\/go/.test(anon) && /key alone does not unlock/.test(anon) && !/add a Zen key/.test(anon), anon.slice(0, 120));
  ok('keyed refuses → acknowledges the key was sent', /key was sent/.test(keyed) && !/not a key/.test(keyed), keyed.slice(0, 120));
  ok('the two remedies differ', anon !== keyed);
  ok('a non-refusal gets no advice', freeTierRemedy(new Error('Groq API error 429: rate limited'), { anonymous: false, keyed: false }) === undefined);

  console.log('\n— OpenCode Go is open to other agents: it needs a session id, not a disguise —');
  ok('a Go base URL gets the session header', sessionHeaderFor('https://opencode.ai/inference/go/openai/v1') === 'x-opencode-session');
  ok('Zen\'s base URL gets it too', sessionHeaderFor('https://opencode.ai/zen/v1') === 'x-opencode-session');
  ok('another provider does not', sessionHeaderFor('https://api.groq.com/openai/v1') === undefined);
  ok('a lookalike host does not', sessionHeaderFor('https://opencode.ai.evil.tld/v1') === undefined);
  ok('a non-URL does not throw', sessionHeaderFor('not a url') === undefined);

  console.log(bad === 0 ? '\nThe free-tier gate is handled.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();
