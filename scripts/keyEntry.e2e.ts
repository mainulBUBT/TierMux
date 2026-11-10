/* "Set key" for OpenCode Zen did nothing: the panel drew the button (it already knew `keyOptional`
 * — main.ts:3245) but the command behind it answered "OpenCode Zen is keyless — no API key needed",
 * because it read `keyless` alone. `keyless` and `keyOptional` are opposites where it matters: the
 * first means no key can be used at all, the second means the anonymous tier works AND a stored key
 * is the better path. Getting that wrong made the one route past Zen's free-tier gate unconfigurable.
 * Run: npm run test:e2e:key-entry */
import { acceptsKey, allPlatformInfo } from '../src/providers';
import { getApiKeysFor, setModelSources } from '../src/router/picker';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

function sourcesWith(keys: Record<string, string[]>) {
  return {
    catalog: { find: () => undefined },
    settings: { getFallback: () => [], getDisabledProviders: () => [], enabledByPriority: () => [] },
    secrets: { getKeys: async (p: string) => keys[p] ?? [], getCloudflareAccountId: async () => undefined },
  } as unknown as Parameters<typeof setModelSources>[0];
}

async function main() {
  console.log('— a key CAN be stored on a keyless-but-keyOptional provider —');
  ok('OpenCode Zen accepts a key', acceptsKey('opencode'));
  ok('...and the catalog agrees it is the keyOptional kind', !!allPlatformInfo().find((p) => p.platform === 'opencode')?.keyOptional);

  console.log('\n— providers where a key is genuinely pointless still refuse one —');
  for (const p of ['kilo', 'pollinations', 'ovh']) {
    const info = allPlatformInfo().find((x) => x.platform === p);
    ok(`${p} stays keyless-only`, !!info && !acceptsKey(p as never), `keyless=${info?.keyless} keyOptional=${info?.keyOptional}`);
  }

  console.log('\n— ordinary keyed providers are untouched —');
  for (const p of ['groq', 'cerebras', 'openrouter', 'mistral']) {
    ok(`${p} accepts a key`, acceptsKey(p as never));
  }

  console.log('\n— every keyOptional platform is reachable, not just opencode —');
  const optional = allPlatformInfo().filter((p) => p.keyOptional);
  ok('there is at least one', optional.length > 0, optional.map((p) => p.platform).join(', '));
  ok('and all of them accept a key', optional.every((p) => acceptsKey(p.platform)));

  console.log('\n— a stored Zen key is what the request actually carries —');
  setModelSources(sourcesWith({ opencode: ['sk-zen-live'] }));
  ok('the keyed pool wins over the anonymous lane', (await getApiKeysFor('opencode')).join(',') === 'sk-zen-live');
  setModelSources(sourcesWith({}));
  ok('and with no key it falls back to the anonymous lane', (await getApiKeysFor('opencode')).join(',') === '');
  setModelSources(sourcesWith({ kilo: ['sk-ignored'] }));
  ok('a keyless-only platform never gets handed one', (await getApiKeysFor('kilo')).join(',') === '');

  console.log(bad === 0 ? '\nKey entry is reachable.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();
