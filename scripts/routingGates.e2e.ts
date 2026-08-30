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
import { selectModel, setModelSources } from '../src/router/picker';
import { resolveCandidates } from '../src/agent/core/routerProvider';
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
      // not about ranking.
      find: (_p: string, _m: string) => ({ intelligenceRank: 1, supportsTools: true }),
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
  const fallback = [entry('ollama', 'glm-5.2', 0), entry('groq', 'openai/gpt-oss-120b', 1)];
  setModelSources(makeSources(fallback, [], ['ollama', 'groq']));
  const sel = await selectModel([{ role: 'user', content: 'hello' } as never], {});
  ok('a switched-on provider is selectable again',
    [sel.model, ...sel.fallbackChain].includes('ollama::glm-5.2'));
}

console.log('\n— the bounded chain is never all one provider —');
{
  // Six ollama models ahead of two other platforms: exactly the 402 repro's shape.
  const fallback = [
    entry('ollama', 'glm-5.2', 0),
    entry('ollama', 'kimi-k2.6', 1),
    entry('ollama', 'kimi-k2.7-code', 2),
    entry('ollama', 'qwen3.5:397b', 3),
    entry('ollama', 'nemotron-3-ultra', 4),
    entry('ollama', 'gpt-oss:120b', 5),
    entry('groq', 'openai/gpt-oss-120b', 6),
    entry('cerebras', 'gpt-oss-120b', 7),
  ];
  setModelSources(makeSources(fallback, [], ['ollama', 'groq', 'cerebras']));
  const cands = await resolveCandidates({});
  const plats = cands.map((c) => c.platform);
  ok('the chain still fills to the bound', cands.length === 4, `${cands.length}`);
  ok('no provider owns more than half the chain',
    plats.filter((p) => p === 'ollama').length <= 2, plats.join(', '));
  ok('a provider-wide failure cannot burn the whole chain',
    new Set(plats).size >= 2, plats.join(', '));
  ok('the other platforms actually made it in',
    plats.includes('groq') && plats.includes('cerebras'), plats.join(', '));
}

console.log('\n— one usable provider still gets a full-length chain —');
{
  // The diversity cap must not shorten the chain for a user who enabled only one provider.
  const fallback = [
    entry('ollama', 'glm-5.2', 0),
    entry('ollama', 'kimi-k2.6', 1),
    entry('ollama', 'kimi-k2.7-code', 2),
    entry('ollama', 'qwen3.5:397b', 3),
    entry('groq', 'openai/gpt-oss-120b', 4), // enabled, but NO stored key
  ];
  setModelSources(makeSources(fallback, [], ['ollama']));
  const cands = await resolveCandidates({});
  ok('overflow refills the held-back slots', cands.length === 4, `${cands.length}`);
  ok('and keeps the original order',
    cands.map((c) => c.modelId).join(',') === 'glm-5.2,kimi-k2.6,kimi-k2.7-code,qwen3.5:397b',
    cands.map((c) => c.modelId).join(','));
}

console.log(bad === 0 ? '\nAll routing gates hold.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();
