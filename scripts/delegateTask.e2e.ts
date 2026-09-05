// delegateTask e2e — minimal harness. See scenarios 1-6 below.
// Run: npm run test:e2e:delegate-task

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMockModel } from './mockModel';
import { runSubagent } from '../src/agent/core/subagent';
import { buildV3ToolSet, READ_ONLY_TOOLS } from '../src/agent/core/tools/v3/index';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';

let failures = 0;
let caseNo = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  caseNo++;
  const tag = cond ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${caseNo}. ${name}${cond ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
};

function makeWorkspace(): { root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-subagent-'));
  fs.writeFileSync(path.join(root, 'notes.txt'), 'alpha secret-token-123\nbeta\n');
  return { root };
}

async function main(): Promise<void> {
  const agent = buildV3ToolSet('agent');
  const plan = buildV3ToolSet('plan');
  const ask = buildV3ToolSet('ask');
  ok('1a. delegateTask offered in agent mode', 'delegateTask' in agent);
  ok('1b. delegateTask offered in plan mode', 'delegateTask' in plan);
  ok('1c. offered in ask mode', 'delegateTask' in ask);
  ok('1d. READ_ONLY', READ_ONLY_TOOLS.has('delegateTask'));

  // ── 2. Happy path: sub-agent investigates via real readFile, then synthesizes ──
  const ws = makeWorkspace();
  const model = createMockModel([
    { toolCalls: [{ toolName: 'readFile', input: { path: 'notes.txt' } }] },
    { text: 'The token is secret-token-123 in notes.txt:1.' },
  ], 'subagent-happy');
  const report = await runWithWorkspaceRoot(ws.root, () => runSubagent({
    task: 'Find the secret token in notes.txt and report it.',
    model: model as never,
    maxSteps: 4,
  }));
  ok('2a. ran 2 steps (tool call + synthesis)', report.stepsCount === 2, `steps=${report.stepsCount}`);
  ok('2b. synthesis reached the parent', report.summary.includes('secret-token-123'), report.summary.slice(0, 120));
  ok('2c. sub-agent saw the delegated task',
    JSON.stringify(model.calls[0]?.messages).includes('Find the secret token'));
  ok('2d. sub-agent toolset includes readFile', model.calls[0]?.tools.includes('readFile') === true);

  // ── 3. Isolation + read-only guarantee ────────────────────────────────────
  const SUB_MUTATING = ['editFile', 'writeFile', 'deleteFile', 'runCommand', 'delegateTask'];
  ok('3a. no mutating tools, no recursive delegateTask',
    !model.calls[0].tools.some((t) => SUB_MUTATING.includes(t)), JSON.stringify(model.calls[0].tools));

  // ── 4. Step cap: maxSteps=1 → one step, fallback summary ─────────────────
  const cappedModel = createMockModel([
    { toolCalls: [{ toolName: 'readFile', input: { path: 'notes.txt' } }] },
  ], 'subagent-capped');
  const capped = await runWithWorkspaceRoot(ws.root, () => runSubagent({
    task: 'List what you see.',
    model: cappedModel as never,
    maxSteps: 1,
  }));
  ok('4a. step cap holds (maxSteps=1 → 1 step)', capped.stepsCount === 1, `steps=${capped.stepsCount}`);
  ok('4b. capped run yields the no-notes fallback summary',
    capped.summary.includes('without additional notes'), capped.summary.slice(0, 100));

  // ── 5. Validation — no model call on an empty task ────────────────────────
  const tool = buildV3ToolSet('agent').delegateTask;
  const empty = await tool.execute!({ task: '   ' } as never, { tools: {} as never });
  ok('5a. empty task returns { error }', typeof empty === 'object' && empty !== null && 'error' in empty);

  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
  process.exit(failures ? 1 : 0);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
