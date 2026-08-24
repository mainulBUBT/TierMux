// Prompt-diet lock for the SIMPLE system prompt (2026-08-24 reset): the live prompt stays
// small by construction — identity + mode tail + date (+ profile/memory/rules when present).
// This suite pins an upper bound so a future edit cannot quietly grow the prompt tower back
// (the exact regression that motivated the reset: weak free models follow short prompts far
// more reliably than long contracts).
//
// Run: npm run test:e2e:prompt-diet
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSimpleSystemPrompt } from '../src/agent/promptBuilder';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  // An empty temp workspace: no profile, no memory, no rules — the FLOOR of the prompt.
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-diet-'));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: emptyRoot, path: emptyRoot } }];

  const agent = await buildSimpleSystemPrompt('agent');
  const plan = await buildSimpleSystemPrompt('plan');
  const ask = await buildSimpleSystemPrompt('ask');

  ok('agent: empty-workspace prompt stays under 2.5K chars', agent.length < 2_500);
  ok('plan: empty-workspace prompt stays under 2.5K chars', plan.length < 2_500);
  ok('ask: empty-workspace prompt stays under 2.5K chars', ask.length < 2_500);
  ok('all three modes are roughly the same size (no mode carries a hidden tower)',
    Math.max(agent.length, plan.length, ask.length) - Math.min(agent.length, plan.length, ask.length) < 600);

  fs.rmSync(emptyRoot, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
