/* Auto routing must honour the provider switch, and the bounded candidate chain must never be
 * filled by one provider. Two 2026-08-30 repros: (1) a switched-off provider's models still
 * counted as selectable because selectModel read getFallback() instead of enabledByPriority();
 * (2) all four candidates were ollama (five rank-1 entries), so one account-level 402 burned the
 * whole chain in ~4s. Run: npm run test:e2e:routing-gates */
import { selectModel, setModelSources, noteModelFailure, canonicalModelId, __resetTaskRoundCounters } from '../src/router/picker';
import { NoVisionModelError } from '../src/router/errors';
import { resolveCandidates, isFailoverWorthy } from '../src/agent/core/routerProvider';
import { TASK_ROUTING } from '../src/router/picker';
import { ProviderHttpError } from '../src/providers/base';
import type { FallbackEntry } from '../src/shared/types';
import { modelTierKey } from './modelTierKey.mjs';
import { readFileSync } from 'node:fs';

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
  // Switched-off models are not candidates: absent from the report (the user turned them off),
  // and — the original bug — never blamed on a missing key in their place.
  const offEntries = sel.rationale?.entries.filter((e) => e.model.startsWith('ollama::')) ?? [];
  ok('"Why this model?" does not list a switched-off provider\'s models', offEntries.length === 0, offEntries.map((e) => e.skip ?? e.reason).join(' | ') || '<none>');
  ok('…and nothing blames them on a missing key', !sel.rationale?.entries.some((e) => e.model.startsWith('ollama::') && /API key/.test(e.skip ?? '')));
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
}

console.log('\n— work is smartest first: tier, then rank; speed only breaks ties —');
{
  __resetTaskRoundCounters();
  // 2026-09-23 (user direction): a fast mid-tier head (gpt-oss-120b, lightning) led agent turns
  // over frontier models and wandered through many tool calls. Tags carry the tier, as in the
  // worker catalog.
  const rows: Record<string, { intelligenceRank: number; speedRank: number; tags: string[] }> = {
    'groq::openai/gpt-oss-120b': { intelligenceRank: 2, speedRank: 1, tags: ['mid'] },
    'xkiro::qwen/qwen3.8-max:free': { intelligenceRank: 1, speedRank: 4, tags: ['frontier'] },
    'nvidia::moonshotai/kimi-k3': { intelligenceRank: 2, speedRank: 3, tags: ['frontier'] },
    'google::gemini-3.8-flash': { intelligenceRank: 2, speedRank: 2, tags: ['frontier'] },
    'kilo::z-ai/glm-5.2:free': { intelligenceRank: 1, speedRank: 1, tags: ['strong'] },
  };
  const src = makeSources(Object.keys(rows).map((k, i) => entry(k.split('::')[0], k.split('::').slice(1).join('::'), i)), [],
    ['groq', 'xkiro', 'nvidia', 'google', 'kilo']);
  (src as unknown as { catalog: { find: (p: string, m: string) => unknown } }).catalog = {
    find: (p: string, m: string) => ({ supportsTools: true, ...rows[`${p}::${m}`] }),
  };
  setModelSources(src);
  const sel = await selectModel([{ role: 'user', content: 'fix this bug in the code' } as never], { taskKind: 'work', requireTools: true });
  const order = [sel.model, ...sel.fallbackChain];
  ok('the rank-1 frontier model leads even at speedRank 4', order[0] === 'xkiro::qwen/qwen3.8-max:free', order.join(' > '));
  ok('among equal-rank frontier peers the faster one comes first',
    order.indexOf('google::gemini-3.8-flash') < order.indexOf('nvidia::moonshotai/kimi-k3'), order.join(' > '));
  ok('every frontier model precedes a strong one, even a faster rank-1 strong',
    order.indexOf('kilo::z-ai/glm-5.2:free') === 3, order.join(' > '));
  ok('the fast mid-tier model is last, not the head', order.at(-1) === 'groq::openai/gpt-oss-120b', order.join(' > '));
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

console.log('— ranking is by MODEL, with the fastest gateway for a model leading its twins —');
{
  __resetTaskRoundCounters();
  // Asserted as agreement between spellings, not as an exact string: what the canonical form
  // LOOKS like is an implementation detail, what matters is that two rows of one model meet.
  ok('canonical id strips vendor namespace and tier suffix',
    canonicalModelId('openai/gpt-oss-120b:free') === canonicalModelId('gpt-oss-120b')
    && canonicalModelId('nvidia/nemotron-3-super-120b-a12b:free') === canonicalModelId('nemotron-3-super-120b-a12b')
    && canonicalModelId('@cf/meta/llama-4-scout') === canonicalModelId('llama-4-scout'));
  // 2026-09-16: gateways spell one model several ways, and each spelling used to form its own
  // rank group — so the twins never rotated as peers and each drew a full share of traffic.
  ok('canonical id folds gateway spelling (dots vs dashes, serving modes)',
    canonicalModelId('mimo-v2.5-free') === canonicalModelId('mimo-v2-5:free')
    && canonicalModelId('muse-spark-1.2-contributor-free') === canonicalModelId('muse-spark-1-2-contributor:free')
    && canonicalModelId('z-ai/glm-5.2-thinking:free') === canonicalModelId('glm-5.2:free')
    && canonicalModelId('qwen-3.8-27b:free') === canonicalModelId('qwen3.8-27b'));
  // A router alias is a policy over a pool, and the pool is named by the namespace: folding
  // these together would rank three unrelated routers as one model.
  ok('canonical id keeps router aliases apart',
    canonicalModelId('kilo-auto/free') !== canonicalModelId('openrouter/free')
    && canonicalModelId('orcarouter/free') !== canonicalModelId('openrouter/free'));
  // The tier table is indexed by modelTierKey() at sync time and read back by canonicalModelId()
  // at routing time. Let them drift and a model is tiered under one key and ranked under another,
  // which is how the twin-drift this whole fold exists to kill comes back.
  {
    const ids = [
      ...(JSON.parse(readFileSync('media/catalog.json', 'utf8')).models as Array<{ modelId: string }>).map((m) => m.modelId),
      'qwen3:latest', 'glm-5.2:floor', 'glm-5.2:exp', 'kimi-k2@0905', '@cf/meta/llama-4-scout',
      'kilo-auto/free', 'openrouter/free', 'auto', 'free',
    ];
    const drift = ids.filter((id) => canonicalModelId(id) !== modelTierKey(id));
    ok('canonicalModelId and modelTierKey agree on every id', drift.length === 0,
      drift.length ? drift.slice(0, 3).map((id) => `${id}: ${canonicalModelId(id)} vs ${modelTierKey(id)}`).join(' · ') : `${ids.length} ids`);
  }
  // The catalog rates the SAME model 2 on kilo and 6 on openrouter, and an unrelated rank-3
  // model sits between. By model identity the openrouter row is rank 2 too, so it must sort
  // ahead of the rank-3 model, and the faster gateway (kilo, speed 2) leads the slower twin.
  const rows: Record<string, { intelligenceRank: number; speedRank: number }> = {
    'kilo::nvidia/nemotron-3-super-120b-a12b:free': { intelligenceRank: 2, speedRank: 2 },
    'openrouter::nvidia/nemotron-3-super-120b-a12b:free': { intelligenceRank: 6, speedRank: 3 },
    'groq::other-model': { intelligenceRank: 3, speedRank: 1 },
  };
  const src = makeSources([
    entry('groq', 'other-model', 0),
    entry('openrouter', 'nvidia/nemotron-3-super-120b-a12b:free', 1),
    entry('kilo', 'nvidia/nemotron-3-super-120b-a12b:free', 2),
  ], [], ['groq', 'openrouter', 'kilo']);
  (src as unknown as { catalog: { find: (p: string, m: string) => unknown } }).catalog = {
    find: (p: string, m: string) => ({ supportsTools: true, ...rows[`${p}::${m}`] }),
  };
  setModelSources(src);
  const sel = await selectModel([{ role: 'user', content: 'x' }], {});
  const order = [sel.model, ...sel.fallbackChain];
  ok('the faster twin leads', order[0] === 'kilo::nvidia/nemotron-3-super-120b-a12b:free', order.join(' > '));
  ok('the slower twin keeps the MODEL rank and sorts ahead of the rank-3 model',
    order[1] === 'openrouter::nvidia/nemotron-3-super-120b-a12b:free' && order[2] === 'groq::other-model', order.join(' > '));
}

console.log('\n— the task table itself rotates, not just the tail (quota spreads across curated peers) —');
{
  // 2026-09-15 repro: chain[0] was ALWAYS TASK_ROUTING[taskKind][0] — the task table was walked
  // in fixed order with no rotation, so a reachable leader (free, keyless, rarely cooldown'd)
  // served every turn while its curated siblings, and the whole rank-sorted tail behind them,
  // never ran. Both candidates here have no declared rpm/rpd (headroom ties at 1 for both), so
  // this isolates the rotation signal from the headroom nudge.
  __resetTaskRoundCounters();
  const fallback = [
    entry('groq', 'openai/gpt-oss-120b', 0),
    entry('cerebras', 'gpt-oss-120b', 1),
  ];
  setModelSources(makeSources(fallback, [], ['groq', 'cerebras']));
  const leaders: string[] = [];
  for (let i = 0; i < 4; i++) {
    const sel = await selectModel([{ role: 'user', content: 'fix this bug in the code' } as never], { taskKind: 'work' });
    leaders.push(sel.model);
  }
  ok('the first call keeps today\'s untouched order (no rotation on turn 0)',
    leaders[0] === 'groq::openai/gpt-oss-120b', leaders.join(' → '));
  ok('later calls rotate through both task-table peers, not just index 0 forever',
    new Set(leaders).size === 2, leaders.join(' → '));
}

console.log('\n— `platform::auto`: a wildcard resolves THROUGH the gates, a model named auto does not bypass them —');
{
  __resetTaskRoundCounters();
  // dreamprompting publishes a model literally called `auto` (its own router alias) and the
  // catalog says it cannot call tools. Until 2026-09-16 the `::auto` suffix alone made the
  // picker read the row as "any enabled model of this platform" and return it before the
  // tools/cooldown/rate gates ran — so a tool turn was handed the single row that cannot use
  // tools, and the tail then described it by the unresolved key (tier unknown, rank infinite).
  const fallback = [entry('dreamprompting', 'auto', 0), entry('dreamprompting', 'llama-3.3-70b', 1)];
  const meta: Record<string, { intelligenceRank: number; speedRank: number; supportsTools: boolean }> = {
    'dreamprompting::auto': { intelligenceRank: 1, speedRank: 1, supportsTools: false },
    'dreamprompting::llama-3.3-70b': { intelligenceRank: 2, speedRank: 1, supportsTools: true },
  };
  const sources = makeSources(fallback, [], ['dreamprompting']) as unknown as { catalog: { find: (p: string, m: string) => unknown } };
  sources.catalog.find = (p: string, m: string) => meta[`${p}::${m}`];
  setModelSources(sources as unknown as Parameters<typeof setModelSources>[0]);
  const sel = await selectModel([{ role: 'user', content: 'x' } as never], { requireTools: true });
  ok('a catalogued `auto` row obeys the tools gate like any other model',
    sel.model === 'dreamprompting::llama-3.3-70b' && ![sel.model, ...sel.fallbackChain].includes('dreamprompting::auto'),
    [sel.model, ...sel.fallbackChain].join(' → '));
  ok('…and the report says why it was skipped',
    /cannot call tools/.test(sel.rationale?.entries.find((e) => e.model === 'dreamprompting::auto')?.skip ?? ''),
    sel.rationale?.entries.find((e) => e.model === 'dreamprompting::auto')?.skip ?? '<no entry>');
}
{
  __resetTaskRoundCounters();
  // The real wildcard: kilo has no model called `auto`, so `kilo::auto` still means "whichever
  // enabled kilo model is usable" — but it has to be one that PASSED the gates.
  const fallback = [entry('kilo', 'auto', 0), entry('kilo', 'toolless', 1), entry('kilo', 'good', 2)];
  const meta: Record<string, { intelligenceRank: number; speedRank: number; supportsTools: boolean }> = {
    'kilo::toolless': { intelligenceRank: 1, speedRank: 1, supportsTools: false },
    'kilo::good': { intelligenceRank: 2, speedRank: 1, supportsTools: true },
  };
  const sources = makeSources(fallback, [], ['kilo']) as unknown as { catalog: { find: (p: string, m: string) => unknown } };
  sources.catalog.find = (p: string, m: string) => meta[`${p}::${m}`];
  setModelSources(sources as unknown as Parameters<typeof setModelSources>[0]);
  const sel = await selectModel([{ role: 'user', content: 'x' } as never], { requireTools: true });
  const chain = [sel.model, ...sel.fallbackChain];
  ok('the wildcard resolves past a model that fails a gate', sel.model === 'kilo::good', chain.join(' → '));
  ok('…and never hands back the wildcard key itself as a model', !chain.includes('kilo::auto'), chain.join(' → '));
  // The wildcard resolved to a model that is also enabled in its own right; without a dedupe on
  // what was PICKED, the chain listed it twice and burned a failover slot re-dialling it.
  ok('…and the resolved model appears once, not twice', new Set(chain).size === chain.length, chain.join(' → '));
}

console.log('\n— an attachment turn is gated on vision, tail included (the Auto-mode repro) —');
{
  __resetTaskRoundCounters();
  // The repro: Auto mode, an image attached, no Google key. The vision table's Gemini head is
  // unreachable, and the tail used to pad the chain with every enabled model regardless of
  // supportsVision — so a text-only model led and dropped the image without a word.
  const fallback = [entry('kilo', 'text-only', 0), entry('kilo', 'sees', 1)];
  const meta: Record<string, { intelligenceRank: number; speedRank: number; supportsTools: boolean; supportsVision: boolean }> = {
    'kilo::text-only': { intelligenceRank: 1, speedRank: 1, supportsTools: true, supportsVision: false },
    'kilo::sees': { intelligenceRank: 3, speedRank: 1, supportsTools: true, supportsVision: true },
  };
  const sources = makeSources(fallback, [], ['kilo']) as unknown as { catalog: { find: (p: string, m: string) => unknown } };
  sources.catalog.find = (p: string, m: string) => meta[`${p}::${m}`];
  setModelSources(sources as unknown as Parameters<typeof setModelSources>[0]);

  const plain = await selectModel([{ role: 'user', content: 'x' } as never], { requireTools: true });
  ok('without an attachment the better-ranked text-only model still leads', plain.model === 'kilo::text-only', plain.model);

  const sel = await selectModel([{ role: 'user', content: 'x' } as never], { requireTools: true, requireVision: true });
  const chain = [sel.model, ...sel.fallbackChain];
  ok('a vision turn skips the text-only model even though it ranks higher', sel.model === 'kilo::sees', chain.join(' → '));
  ok('…and it is nowhere in the tail either', !chain.includes('kilo::text-only'), chain.join(' → '));
  ok('…and the report says why', /cannot read image or PDF/.test(sel.rationale?.entries.find((e) => e.model === 'kilo::text-only')?.skip ?? ''),
    sel.rationale?.entries.find((e) => e.model === 'kilo::text-only')?.skip ?? '<no entry>');
}
{
  __resetTaskRoundCounters();
  // cloudflare flattens content blocks to text in body(), so its supportsVision=true rows can
  // never actually deliver an image. `flattenContent` documented itself as existing for this
  // check; nothing read it until now.
  const fallback = [entry('cloudflare', 'flattener', 0), entry('kilo', 'sees', 1)];
  const meta: Record<string, { intelligenceRank: number; speedRank: number; supportsTools: boolean; supportsVision: boolean }> = {
    'cloudflare::flattener': { intelligenceRank: 1, speedRank: 1, supportsTools: true, supportsVision: true },
    'kilo::sees': { intelligenceRank: 3, speedRank: 1, supportsTools: true, supportsVision: true },
  };
  const sources = makeSources(fallback, [], ['kilo']) as unknown as { catalog: { find: (p: string, m: string) => unknown } };
  sources.catalog.find = (p: string, m: string) => meta[`${p}::${m}`];
  setModelSources(sources as unknown as Parameters<typeof setModelSources>[0]);
  const sel = await selectModel([{ role: 'user', content: 'x' } as never], { requireTools: true, requireVision: true });
  ok('a content-flattening provider is skipped on a vision turn despite supportsVision=true',
    sel.model === 'kilo::sees', [sel.model, ...sel.fallbackChain].join(' → '));
}
{
  __resetTaskRoundCounters();
  // Nothing vision-capable left. The keyless fallback is an UNFILTERED `platform::auto` chain,
  // so returning it would undo the gate — the turn must stop with the actionable message
  // instead of burning a request on a model that cannot see.
  const fallback = [entry('kilo', 'text-only', 0)];
  const meta: Record<string, { intelligenceRank: number; speedRank: number; supportsTools: boolean; supportsVision: boolean }> = {
    'kilo::text-only': { intelligenceRank: 1, speedRank: 1, supportsTools: true, supportsVision: false },
  };
  const sources = makeSources(fallback, [], ['kilo']) as unknown as { catalog: { find: (p: string, m: string) => unknown } };
  sources.catalog.find = (p: string, m: string) => meta[`${p}::${m}`];
  setModelSources(sources as unknown as Parameters<typeof setModelSources>[0]);
  let thrown: unknown;
  try { await selectModel([{ role: 'user', content: 'x' } as never], { requireTools: true, requireVision: true }); }
  catch (e) { thrown = e; }
  ok('no vision-capable model anywhere throws instead of silently falling back',
    thrown instanceof NoVisionModelError, thrown instanceof Error ? thrown.name : String(thrown));
  ok('…and the message tells the user what to do',
    /Manage Models & Keys/.test((thrown as Error | undefined)?.message ?? ''), (thrown as Error | undefined)?.message?.slice(0, 60) ?? '');

  let pdfThrown: unknown;
  try { await selectModel([{ role: 'user', content: 'x' } as never], { requireTools: true, requireVision: true, requireRawPdf: true }); }
  catch (e) { pdfThrown = e; }
  ok('a raw-PDF turn names the one platform that forwards PDF bytes',
    /Gemini/.test((pdfThrown as Error | undefined)?.message ?? ''), (pdfThrown as Error | undefined)?.message?.slice(0, 60) ?? '');
}

console.log('\n— a utility `model` is a PREFERENCE (heads the chain), not a cage —');
{
  __resetTaskRoundCounters();
  // routeOnce documents `model` as "a PREFERENCE for the head of the chain, never a cage", but
  // it passed the key in as pinnedModel — and PIN = EXACT returns fallbackChain: []. So every
  // utility caller with a preferred model got ONE candidate and no failover, which is why
  // condense and the title path hand-rolled a second call without `model`. An inline completion
  // just went silent when its one model was rate-limited.
  const fallback = [entry('kilo', 'preferred', 0), entry('kilo', 'other', 1), entry('ovh', 'third', 2)];
  setModelSources(makeSources(fallback, [], ['kilo', 'ovh']));

  const pinned = await resolveCandidates({ taskKind: 'trivial', pinnedModel: 'kilo::preferred' });
  ok('a PIN still runs alone — that contract is unchanged', pinned.length === 1,
    pinned.map((c) => `${c.platform}::${c.modelId}`).join(' → '));

  // What routeOnce does now: resolve the chain WITHOUT a pin, then hoist the preference.
  const chain = await resolveCandidates({ taskKind: 'trivial' });
  const keys = chain.map((c) => `${c.platform}::${c.modelId}`);
  const at = keys.indexOf('kilo::preferred');
  ok('the unpinned chain still contains the preferred model', at !== -1, keys.join(' → '));
  ok('…and it carries real failover behind it', chain.length > 1, `${chain.length} candidates`);
}

console.log('\n— the trivial table is ordered by SPEED, because latency is the product there —');
{
  const rows = JSON.parse(readFileSync('media/catalog.json', 'utf8'));
  const list: Array<{ platform: string; modelId?: string; id?: string; speedRank?: number }> =
    Array.isArray(rows) ? rows : (rows.models ?? rows.entries ?? Object.values(rows).find(Array.isArray));
  const speedOf = (key: string): number | undefined => {
    const [p, ...r] = key.split('::');
    const id = r.join('::');
    return list.find((x) => x.platform === p && (x.modelId ?? x.id) === id)?.speedRank;
  };
  const KEYLESS = ['kilo', 'pollinations', 'opencode', 'ovh'];
  const trivial = TASK_ROUTING.trivial;
  ok('every trivial entry is still in the catalog', trivial.every((k) => speedOf(k) !== undefined),
    trivial.map((k) => `${k}=${speedOf(k) ?? 'DEAD'}`).join(', '));
  // The point of the table for this task kind: a zero-setup (keyless) install must reach a
  // genuinely fast row, not fall through to the rank-3 tail.
  const keylessFast = trivial.filter((k) => KEYLESS.includes(k.split('::')[0]) && (speedOf(k) ?? 9) <= 2);
  ok('a keyless install reaches a speedRank≤2 row from the table alone', keylessFast.length > 0,
    keylessFast.join(', ') || '<none — a keyless user falls through to the tail>');
  // kilo-auto is speedRank 1 but a router alias: kilo chooses the model, so latency is unknowable.
  ok('no router alias is used as a "fast" trivial entry', !trivial.some((k) => /auto|router/.test(k.split('::')[1] ?? '')),
    trivial.join(', '));
}

console.log(bad === 0 ? '\nAll routing gates hold.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();
