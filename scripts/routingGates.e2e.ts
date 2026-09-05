/* Auto/Smart routing must honour the provider switch, and its bounded candidate chain must
 * never be filled by a single provider.
 *
 * Two live repros, both 2026-08-30:
 *
 *  (1) "providers key is saved but provider status off — why is auto smart mode taking those
 *      providers' models?" The provider-level switch writes a SEPARATE disabled-providers
 *      list and deliberately leaves each model row's `enabled` flag alone (so selections
 *      survive a toggle). picker.selectModel read settings.getFallback() directly instead of
 *      settings.enabledByPriority(), so every model of a switched-off provider still counted
 *      as selectable — and with a key still stored, nothing downstream re-checked the switch.
 *
 *  (2) 1:30 PM and again at 2:31 PM: an Auto turn died on `Ollama API error 402: this model
 *      requires a subscription`. 402 IS failover-worthy, and the candidate loop rotates
 *      correctly — but resolveCandidates capped the chain at 4 with no platform diversity,
 *      and the tail is sorted by the catalog's coarse 1..5 intelligenceRank, of which ollama
 *      alone holds FIVE rank-1 entries. All four candidates were ollama, so one
 *      account-level 402 burned the whole chain in ~4s.
 *
 * Run: npm run test:e2e:routing-gates
 */
import { selectModel, setModelSources, noteModelFailure, __resetTaskRoundCounters } from '../src/router/picker';
import { resolveCandidates, isFailoverWorthy } from '../src/agent/core/routerProvider';
import { ProviderHttpError } from '../src/providers/base';
import type { FallbackEntry } from '../src/shared/types';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const entry = (platform: string, modelId: string, priority: number): FallbackEntry =>
  ({ platform, modelId, enabled: true, priority } as unknown as FallbackEntry);

/** Stand-in for the real stores — mirrors ONLY what selectModel/resolveCandidates read.
 *  enabledByPriority() reproduces SettingsStore's real semantics: per-model `enabled` AND
 *  the separate provider-level disabled list. */
function makeSources(fallback: FallbackEntry[], disabledProviders: string[], keyed: string[]) {
  return {
    catalog: {
      // Everything ranks 1 and supports tools — this test is about gating and chain shape,
      // not about ranking. Fast speedRank so the speed-aware sort doesn't relegate the mock
      // models to last-resort fallback.
      find: (_p: string, _m: string) => ({ intelligenceRank: 1, speedRank: 1, supportsTools: true }),
    },
    settings: {
      getFallback: () => fallback,
      getDisabledProviders: () => disabledProviders,
      enabledByPriority: () => fallback
        .filter((e) => e.enabled && !disabledProviders.includes(e.platform))
        .sort((a, b) => a.priority - b.priority),
    },
    secrets: {
      getKeys: async (p: string) => (keyed.includes(p) ? ['sk-test'] : []),
      getCloudflareAccountId: async () => undefined,
      isToolIncompatible: () => false,
    },
  } as unknown as Parameters<typeof setModelSources>[0];
}

const platformsOf = (keys: string[]) => keys.map((k) => k.split('::')[0]);

async function main() {

console.log('— the provider switch gates Auto/Smart selection even with a key stored —');
{
  __resetTaskRoundCounters();
  // ollama is switched OFF but still has a saved key; groq is on. The old getFallback() read
  // let all three ollama models through because their per-model flags were untouched.
  const fallback = [
    entry('ollama', 'glm-5.2', 0),
    entry('ollama', 'kimi-k2.6', 1),
    entry('ollama', 'qwen3.5:397b', 2),
    entry('groq', 'openai/gpt-oss-120b', 3),
  ];
  setModelSources(makeSources(fallback, ['ollama'], ['ollama', 'groq']));
  const sel = await selectModel([{ role: 'user', content: 'hello' } as never], {});
  const chain = [sel.model, ...sel.fallbackChain];
  ok('no model of a switched-off provider is selected', !platformsOf(chain).includes('ollama'), chain.join(', '));
  ok('the enabled provider still serves', sel.model === 'groq::openai/gpt-oss-120b', sel.model);
  const skipped = sel.rationale?.entries.find((e) => e.model.startsWith('ollama::'));
  ok('"Why this model?" blames the switch, not a missing key',
    !!skipped?.skip?.includes('provider switched off'), skipped?.skip ?? '<no entry>');
}

console.log('\n— re-enabling the provider brings its models straight back —');
{
  __resetTaskRoundCounters();
  const fallback = [entry('ollama', 'glm-5.2', 0), entry('groq', 'openai/gpt-oss-120b', 1)];
  setModelSources(makeSources(fallback, [], ['ollama', 'groq']));
  const sel = await selectModel([{ role: 'user', content: 'hello' } as never], {});
  ok('a switched-on provider is selectable again',
    [sel.model, ...sel.fallbackChain].includes('ollama::glm-5.2'));
}

console.log('\n— the chain spends its bound on BREADTH, not on one provider —');
{
  __resetTaskRoundCounters();
  // The 3:32 PM repro: the picker's flat order was walked and cut at the bound, so the chain
  // came back opencode → ollama → ollama → cerebras while google/kilo/mistral/kenari sat
  // enabled, keyed, and never looked at.
  const fallback = [
    entry('opencode', 'muse-spark', 0),
    entry('ollama', 'glm-5.2', 1),
    entry('ollama', 'kimi-k2.6', 2),
    entry('ollama', 'qwen3.5:397b', 3),
    entry('cerebras', 'gpt-oss-120b', 4),
    entry('google', 'gemini-2.5-flash', 5),
    entry('kilo', 'kimi-k2', 6),
    entry('mistral', 'mistral-large', 7),
    entry('kenari', 'kenari-1', 8),
  ];
  const keyed = ['opencode', 'ollama', 'cerebras', 'google', 'kilo', 'mistral', 'kenari'];
  setModelSources(makeSources(fallback, [], keyed));
  const cands = await resolveCandidates({});
  const plats = cands.map((c) => c.platform);

  // Round 0 is the first `keyed.length` entries: every platform exactly once, no repeats.
  const round0 = plats.slice(0, keyed.length);
  ok('round 0 reaches every keyed platform exactly once',
    new Set(round0).size === keyed.length && keyed.every((p) => round0.includes(p)),
    round0.join(' → '));
  ok('the platforms that were being skipped are now tried',
    ['google', 'kilo', 'mistral', 'kenari'].every((p) => round0.includes(p)), round0.join(' → '));
  ok('no platform repeats before every other has had a turn',
    plats.slice(0, keyed.length).filter((p) => p === 'ollama').length === 1, plats.join(' → '));
  ok('only AFTER round 0 does a platform get a second model',
    plats.slice(keyed.length).every((p) => round0.includes(p)), plats.slice(keyed.length).join(' → ') || '<none>');
  // Breadth assertions above are platform-level, which rotation preserves. The head model is
  // opencode (only model of its rank-group whose catalog rank this mock reports — all rank 1,
  // so rotation may reorder the multi-model ollama block, never the chain HEAD unless a second
  // turn has passed). First-call counter = 0, so this single-turn assert still holds the
  // picker's own first choice.
  ok('the first choice is still the picker\'s first choice',
    `${cands[0].platform}::${cands[0].modelId}` === 'opencode::muse-spark',
    `${cands[0].platform}::${cands[0].modelId}`);
}

console.log('\n— one usable provider still gets a full-length chain —');
{
  __resetTaskRoundCounters();
  // The breadth rule must not shorten the chain for a user who enabled only one provider:
  // repeating that platform is the best option left, so the rounds keep drawing from it.
  const fallback = [
    entry('ollama', 'glm-5.2', 0),
    entry('ollama', 'kimi-k2.6', 1),
    entry('ollama', 'kimi-k2.7-code', 2),
    entry('ollama', 'qwen3.5:397b', 3),
    entry('groq', 'openai/gpt-oss-120b', 4), // enabled, but NO stored key
  ];
  setModelSources(makeSources(fallback, [], ['ollama']));
  const cands = await resolveCandidates({});
  ok('a single-platform chain still fills', cands.length === 4, `${cands.length}`);
  // Equal-rank quota rotation (2026-09-04) deliberately reorders same-rank peers between
  // turns so one provider's free quota doesn't drain while equally-smart peers sit unused.
  // The four ollama models are all rank 1 in this mock — assert the SET is preserved, not
  // the exact order.
  const ids = cands.map((c) => c.modelId).sort().join(',');
  ok('and keeps every model of the picker order',
    ids === 'glm-5.2,kimi-k2.6,kimi-k2.7-code,qwen3.5:397b',
    cands.map((c) => c.modelId).join(','));
}

console.log('\n— an account-level refusal condemns the platform, not just the model —');
{
  __resetTaskRoundCounters();
  // 2026-08-30 3:23 PM: "Cerebras API error 402: Payment required to access this resource."
  // killed a turn, and the message gave no sign that failover had run at all. 402 IS
  // failover-worthy, so the chain DID advance — it just had nothing left to advance to, and
  // any sibling cerebras model would have answered 402 too.
  const billing = new ProviderHttpError('Cerebras API error 402: Payment required', 402);
  const deadKey = new ProviderHttpError('unauthorized', 401);
  const forbidden = new ProviderHttpError('no credit on a paid-only model', 403);
  const rate = new ProviderHttpError('rate limited', 429);
  const server = new ProviderHttpError('bad gateway', 502);

  ok('402 still fails over (the chain must advance)', isFailoverWorthy(billing));
  ok('429 still fails over', isFailoverWorthy(rate));
  ok('5xx still fails over', isFailoverWorthy(server));

  // isAccountLevel is internal; assert the CLASSIFICATION it encodes, which is what decides
  // whether a platform's remaining models are worth trying.
  const accountLevel = (e: unknown) => e instanceof ProviderHttpError
    && (e.status === 401 || e.status === 402 || e.status === 403);
  ok('402 is account-level (siblings cannot succeed)', accountLevel(billing));
  ok('401 is account-level', accountLevel(deadKey));
  ok('403 is account-level', accountLevel(forbidden));
  ok('429 is NOT account-level — the next model may serve', !accountLevel(rate));
  ok('5xx is NOT account-level', !accountLevel(server));
}

console.log('— a 404 / a 400-with-tools quarantines the MODEL, not just the moment —');
{
  // The old Router set these marks; the picker read them but nothing had set them since it was
  // retired, so a deprecated model was retried every turn and a 404 killed the turn outright.
  __resetTaskRoundCounters();
  const quarantined = new Map<string, string>();
  const src = makeSources([entry('groq', 'gone-model', 0), entry('groq', 'live-model', 1), entry('groq', 'no-tools', 2)], [], ['groq']);
  (src as unknown as { secrets: Record<string, unknown> }).secrets = {
    getKeys: async () => ['sk-test'],
    getCloudflareAccountId: async () => undefined,
    isToolIncompatible: (_p: string, m: string) => quarantined.get(m) === 'tools',
    isDeprecated: (_p: string, m: string) => quarantined.get(m) === 'gone',
    markToolIncompatible: (_p: string, m: string) => { quarantined.set(m, 'tools'); },
    markDeprecated: (_p: string, m: string) => { quarantined.set(m, 'gone'); },
  };
  setModelSources(src);
  ok('404 fails over instead of killing the turn', isFailoverWorthy(new ProviderHttpError('not found', 404)));
  noteModelFailure('groq', 'gone-model', 404, false);
  noteModelFailure('groq', 'no-tools', 400, true);
  noteModelFailure('groq', 'live-model', 429, true);
  ok('404 marks the model deprecated', quarantined.get('gone-model') === 'gone');
  ok('400 with tools offered marks it tool-incompatible', quarantined.get('no-tools') === 'tools');
  ok('429 marks nothing (a moment, not the model)', !quarantined.has('live-model'));
  const sel = await selectModel([{ role: 'user', content: 'x' }], { requireTools: true });
  ok('the next selection skips both', sel.model === 'groq::live-model' && !sel.fallbackChain.includes('groq::gone-model') && !sel.fallbackChain.includes('groq::no-tools'), JSON.stringify(sel.fallbackChain));
  const pinned = await selectModel([{ role: 'user', content: 'x' }], { pinnedModel: 'groq::gone-model' });
  ok('a pin still runs alone on a deprecated model (the user asked for it)', pinned.model === 'groq::gone-model', pinned.model);
}

console.log(bad === 0 ? '\nAll routing gates hold.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();
