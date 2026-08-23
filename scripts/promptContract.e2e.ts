// Prompt-contract lock for the asking rules (behavior.md / ask-format.md / the
// AGENT_MODE_TAIL in promptBuilder.ts). These files are shipped as editable scaffolding, so
// nothing type-checks their content — a stray edit can silently drop the "never ask in plain
// prose" rule and bring back the exact weak-model failure it exists to prevent (the model asks
// in prose, no interactive card renders, the user concludes the ask mechanism is broken).
//
// Asserts, per mode, against the REAL buildSystemPrompt() output:
// - Plan mode: ask-format.md IS loaded — askQuestions rules, the no-permission-asking rule,
//   and the turn-ending discipline ("ends with askQuestions or the plan").
// - Agent mode: ask-format.md is NOT loaded (the existing per-mode skip), but the `question`
//   tool discipline from AGENT_MODE_TAIL and behavior.md's tool-routed ask line ARE present.
// - No <!-- weak-only --> scaffolding markers ever leak into a prompt, weak or strong.
//
// Run: npm run test:e2e:prompt-contract
import * as fs from 'fs';
import * as path from 'path';
import { buildSystemPrompt, setExtensionPath } from '../src/agent/promptBuilder';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  const root = fs.realpathSync(process.cwd());
  // buildSystemPrompt reads .tiermux/agent/*.md relative to the extension path — point it at
  // this repo checkout so the assertions run against the real shipped scaffolding.
  setExtensionPath(root);
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: root, path: root } }];

  const plan = await buildSystemPrompt('plan', 'coding', 'contract-test', 'add a dark mode toggle', true);
  const agent = await buildSystemPrompt('agent', 'coding', 'contract-test', 'add a dark mode toggle', true);
  const agentStrong = await buildSystemPrompt('agent', 'coding', 'contract-test', 'add a dark mode toggle', false);

  // ── Shared scaffolding: behavior.md routes asks to the tool, in every mode ──
  for (const [label, p] of [['plan', plan], ['agent', agent]] as const) {
    ok(`${label}: behavior.md routes ambiguous asks to the question tool ("never plain prose")`,
      p.includes('never plain prose'));
    ok(`${label}: behavior.md names both per-mode ask tools (askQuestions / question)`,
      p.includes('askQuestions') && p.includes('question'));
  }

  // ── Plan mode: ask-format.md contract ──
  ok('plan: ask-format.md loaded (askQuestions tool documented)', plan.includes('`askQuestions`'));
  ok('plan: no-permission-asking rule present', plan.includes('NEVER ask permission to proceed'));
  ok('plan: turn-ending discipline present (ask tool or the plan)', plan.includes('exactly one of two ways'));
  ok('plan: options guidance present (recommended first)', plan.toLowerCase().includes('recommended one first'));

  // ── Agent mode: ask-format skipped, question-tool discipline still present ──
  ok('agent: ask-format.md skipped (no plan-only turn discipline leaked)', !agent.includes('exactly one of two ways'));
  ok('agent: question-tool discipline in the mode tail (never a plain-prose question)',
    agent.includes('never a plain-prose question'));
  ok('agent: never ask permission to proceed (tail rule)', agent.includes('never ask permission to proceed'));

  // ── Weak-only scaffolding markers must never leak into any prompt ──
  ok('weak prompt: no weak-only markers leak', !agent.includes('weak-only'));
  ok('strong prompt: no weak-only markers leak', !agentStrong.includes('weak-only'));
  // The stripping mechanism is content-conditional: no shipped .md currently declares a
  // weak-only section, so strong == weak is the CORRECT outcome today. The contract is only
  // "when a section exists, it must actually strip" — checked by reading the real files.
  const agentDir = path.join(root, '.tiermux', 'agent');
  const mdContents = fs.readdirSync(agentDir).filter((f) => f.endsWith('.md'))
    .map((f) => fs.readFileSync(path.join(agentDir, f), 'utf8'));
  const hasWeakSections = mdContents.some((c) => c.includes('weak-only'));
  ok('weak-only stripping applies when a section exists (none shipped today → strong==weak is correct)',
    !hasWeakSections || agent !== agentStrong);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
