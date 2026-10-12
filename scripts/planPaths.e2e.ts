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

  console.log('\n— evidence must come from something seen this turn, not from the file list —');
  // Plan mode's prompt now lists every file NAME (context/fileMap.ts); existence + line count alone
  // would pass a `path:line` the model never opened.
  const call = (id: string, toolName: string, input: unknown) => ({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName, input }] });
  const result = (id: string, toolName: string, value: string) => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName, output: { type: 'text', value } }] });
  const withMsgs = (messages: unknown[]) => runWithWorkspaceRoot(root, () => tool.execute(
    { outcome: 'plan', title: 't', interpretation: 'r', steps: [{ what: 'Edit a', files: ['src/a.ts'], evidence: 'src/a.ts:2 has the bug' }] }, { messages }));
  const unread = await withMsgs([{ role: 'user', content: 'fix the bug' }, call('g', 'glob', { pattern: '**/*.ts' }), result('g', 'glob', 'src/b.ts')]);
  ok('a cited file never opened or found is rejected', isError(unread) && msg(unread).includes('src/a.ts:2'), msg(unread));
  ok('the rejection says to read it', /read/i.test(msg(unread)), msg(unread));
  ok('a readFile of the cited path counts', !isError(await withMsgs([call('r', 'readFile', { path: 'src/a.ts' }), result('r', 'readFile', '<file path="src/a.ts">\n1\tl1\n</file>')])));
  ok('a multi-path readFile counts', !isError(await withMsgs([call('r', 'readFile', { path: ['src/b.ts', './src/a.ts'] }), result('r', 'readFile', '…')])));
  ok('a grep hit naming the file counts', !isError(await withMsgs([call('g', 'grep', { pattern: 'bug' }), result('g', 'grep', 'src/a.ts:2: bug here')])));
  ok('an aged read still counts (its call stays in the transcript)', !isError(await withMsgs([call('r', 'readFile', { path: 'src/a.ts' }), result('r', 'readFile', '[readFile src/a.ts — elided]')])));
  ok('a file the user attached counts', !isError(await withMsgs([{ role: 'user', content: 'Context — file `src/a.ts` (lines 1-3):\n```\nl1\nl2\n```' }])));
  ok('a path merely named in the request does not', isError(await withMsgs([{ role: 'user', content: 'fix the bug in src/a.ts' }])));
  ok('no transcript, no check (sub-agent / bare tool)', !isError(await submit([{ what: 'Edit a', files: ['src/a.ts'], evidence: 'src/a.ts:2' }])));

  fs.rmSync(root, { recursive: true, force: true });
  console.log(bad === 0 ? '\nPlan paths are checked.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();
