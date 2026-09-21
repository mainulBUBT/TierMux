/* exitPlanMode must not accept a plan that names files or lines that are not in the workspace —
 * that plan was written from memory, not from a read. Mechanical: existence + line count only.
 * Run: npm run test:e2e:plan-paths */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ProposedPlan } from '../src/shared/types';
import { createExitPlanModeTool } from '../src/agent/core/tools/v3/exitPlanMode';
import { checkPlanPaths } from '../src/agent/core/tools/v3/planPathCheck';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-plan-'));
fs.mkdirSync(path.join(root, 'src'));
fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'l1\nl2\nl3\n');

async function main() {
  const seen: ProposedPlan[] = [];
  const tool = createExitPlanModeTool((p) => { seen.push(p); }, checkPlanPaths) as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> };
  const submit = (steps: unknown) => runWithWorkspaceRoot(root, () => tool.execute({ outcome: 'plan', title: 't', interpretation: 'r', steps }, {}));
  const isError = (r: unknown) => typeof r === 'object' && r !== null && 'error' in r;
  const msg = (r: unknown) => String((r as { error?: string }).error ?? '');

  console.log('— a grounded plan is accepted —');
  const good = await submit([{ what: 'Edit a', files: ['src/a.ts'], evidence: 'src/a.ts:2 has the bug' }]);
  ok('existing file + line inside the file', !isError(good) && seen.length === 1, msg(good));

  console.log('\n— a NEW file in an existing folder is fine —');
  const created = await submit([{ what: 'Add b', files: ['src/b.ts'], evidence: 'src/a.ts:1 imports nothing yet' }]);
  ok('new file, existing parent dir', !isError(created), msg(created));

  console.log('\n— invented paths are rejected with a way out —');
  const before = seen.length;
  const ghostDir = await submit([{ what: 'Edit ghost', files: ['nowhere/deep/x.ts'], evidence: 'src/a.ts:1 ok' }]);
  ok('a file whose folder does not exist', isError(ghostDir) && msg(ghostDir).includes('nowhere/deep/x.ts'), msg(ghostDir).slice(0, 120));
  const ghostEvidence = await submit([{ what: 'Edit a', files: ['src/a.ts'], evidence: 'src/missing.ts:10 does it' }]);
  ok('evidence citing a file that does not exist', isError(ghostEvidence) && msg(ghostEvidence).includes('src/missing.ts'));
  const badLine = await submit([{ what: 'Edit a', files: ['src/a.ts'], evidence: 'src/a.ts:999 does it' }]);
  ok('evidence line beyond the end of the file', isError(badLine) && msg(badLine).includes('only 4 lines'), msg(badLine).slice(0, 140));
  ok('none of the rejected plans reached the host', seen.length === before);

  console.log('\n— evidence without a path:line is not this check’s business —');
  const prose = await submit([{ what: 'Edit a', files: ['src/a.ts'], evidence: 'the loop in a.ts never terminates' }]);
  ok('free-form evidence passes', !isError(prose), msg(prose));

  console.log('\n— no host check (e2e/headless) → unchanged —');
  const bare = createExitPlanModeTool(() => undefined) as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> };
  const r = await bare.execute({ outcome: 'plan', title: 't', interpretation: 'r', steps: [{ what: 'x', files: ['ghost/y.ts'], evidence: 'ghost/y.ts:5' }] }, {});
  ok('without checkPaths, invented paths pass as before', !isError(r));

  fs.rmSync(root, { recursive: true, force: true });
  console.log(bad === 0 ? '\nPlan paths are checked.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();
