/* Validate a quality dataset without running anything: schema, duplicate ids, and — the part
 * that actually rots — whether every ground-truth path still exists in the workspace.
 *
 * A separate entry point rather than a `require.main === module` block inside
 * qualityDataset.ts: esbuild bundles every module into one CommonJS file where that check is
 * true for non-entry modules too, so such a block hijacks whichever bundle imports it.
 *
 *   npm run bench:quality:dataset
 *   npm run bench:quality:dataset -- docs/bench/dataset.myproject.json --workspace ../myproject
 */
import * as path from 'path';
import { checkGroundTruth, loadQualityDataset } from './qualityDataset';

const argv = process.argv.slice(2);
const flagIndex = argv.indexOf('--workspace');
const workspace = path.resolve(flagIndex >= 0 ? argv[flagIndex + 1] : process.cwd());
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--workspace');
const file = path.resolve(process.cwd(), positional[0] ?? 'docs/bench/dataset.tiermux.json');

const ds = loadQualityDataset(file);
const byCat: Record<string, number> = {};
for (const q of ds.queries) byCat[q.category] = (byCat[q.category] ?? 0) + 1;
console.log(`${ds.queries.length} queries for project "${ds.project}"`);
for (const [c, n] of Object.entries(byCat)) console.log(`  ${c}: ${n}`);

const problems = checkGroundTruth(ds, workspace);
if (problems.length) {
  console.log(`\n⚠ ${problems.length} ground-truth path(s) not found in ${workspace}:`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log(`\nAll ground-truth paths exist in ${workspace}. ✓`);
