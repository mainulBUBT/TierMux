/* A catalog refresh that suddenly drops most models — or empties a provider the Worker still lists
 * as enabled — is held back until a second refresh shows the same list: a bad sync must not
 * replace a good catalog on the first try, and a real shrink must not be refused forever.
 * Run: npm run test:e2e:catalog-shrink */
import { catalogShrinkDecision } from '../src/catalog/catalog';
import type { CatalogModel } from '../src/shared/types';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };
const rows = (platform: string, n: number) => Array.from({ length: n }, (_, i) => ({ platform, modelId: `${platform}-m${i}` }) as CatalogModel);

const before = [...rows('groq', 10), ...rows('opencode', 30), ...rows('kilo', 20)];

console.log('— ordinary changes pass —');
ok('same size passes', catalogShrinkDecision(before, before, [], undefined).accept);
ok('a few models gone passes', catalogShrinkDecision(before, before.slice(0, 55), [], undefined).accept);
ok('growth passes', catalogShrinkDecision(before, [...before, ...rows('new', 40)], [], undefined).accept);
ok('nothing accepted before (bundled baseline) passes', catalogShrinkDecision(undefined, before.slice(0, 10), [], undefined).accept);

console.log('\n— a sudden shrink is held once, then accepted when it repeats —');
const shrunk = before.slice(0, 30);
const first = catalogShrinkDecision(before, shrunk, [], undefined);
ok('first sight is held back', !first.accept && /60 → 30/.test(first.reason ?? ''), first.reason);
const second = catalogShrinkDecision(before, shrunk, [], first.fingerprint);
ok('the same list again is accepted', second.accept);
const other = catalogShrinkDecision(before, before.slice(0, 25), [], first.fingerprint);
ok('a different shrunken list starts over', !other.accept);

console.log('\n— a provider emptied while still enabled is held —');
const noKilo = [...rows('groq', 10), ...rows('opencode', 30)];
const emptied = catalogShrinkDecision(before, noKilo, [], undefined);
ok('kilo losing every model is held', !emptied.accept && /kilo/.test(emptied.reason ?? ''), emptied.reason);
ok('unless the Worker marks kilo disabled', catalogShrinkDecision(before, noKilo, ['kilo'], undefined).accept);

console.log(bad === 0 ? '\nCatalog shrink guard holds.' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
