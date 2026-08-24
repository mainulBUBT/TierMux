// Prompt-contract lock for the SIMPLE system prompt (2026-08-24 reset). buildSimpleSystemPrompt
// is string-built in TypeScript, so a stray edit can silently drop a mode's grounding rule or
// re-import the judgment-era scaffolding. Asserts, per mode, against the REAL
// buildSimpleSystemPrompt() output:
// - Identity + mode tail + today's date present in every mode.
// - Mode-specific capabilities: agent (question tool, verify-or-untested), plan (read-only,
//   askQuestions before planning, numbered plan), ask (read-only Q&A, webSearch, Agent-mode handoff).
// - The judgment-era prompt tower is GONE from the live prompt: no behavior.md rules, no
//   research methodology, no terse-replies instruction, no skills index.
//
// Run: npm run test:e2e:prompt-contract
import * as fs from 'fs';
import { buildSimpleSystemPrompt } from '../src/agent/promptBuilder';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  const root = fs.realpathSync(process.cwd());
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: root, path: root } }];

  const agent = await buildSimpleSystemPrompt('agent');
  const plan = await buildSimpleSystemPrompt('plan');
  const ask = await buildSimpleSystemPrompt('ask');

  // ── Every mode: identity, mode section, today's date ──
  for (const [label, p] of [['agent', agent], ['plan', plan], ['ask', ask]] as const) {
    ok(`${label}: identity present`, p.includes('You are TierMux'));
    ok(`${label}: mode section present`, p.includes(`## ${label === 'agent' ? 'Agent' : label === 'plan' ? 'Plan' : 'Ask'} mode`));
    ok(`${label}: today's date grounds the cutoff`, /Today's date is \w+, (January|February|March|April|May|June|July|August|September|October|November|December) \d+, \d{4}/.test(p));
  }

  // ── Mode-specific contract ──
  ok('agent: `question` tool is the only ask path', agent.includes('`question` tool'));
  ok('agent: grounding rule (claims from what was read this turn)', agent.includes('read this turn'));
  ok('agent: verify-or-untested honesty rule', agent.includes('how you verified it'));
  ok('plan: read-only contract', plan.includes('READ-ONLY'));
  ok('plan: `askQuestions` before planning when approach-changing', plan.includes('`askQuestions` tool'));
  ok('plan: numbered plan discipline', plan.includes('numbered plan'));
  ok('ask: read-only Q&A', ask.includes('Read-only Q&A'));
  ok('ask: webSearch for current/outside info', ask.includes('`webSearch`'));
  ok('ask: suggests Agent mode for edits', ask.includes('Agent mode'));

  // ── The judgment-era prompt tower must NOT be in the live prompt ──
  for (const [label, p] of [['agent', agent], ['plan', plan], ['ask', ask]] as const) {
    ok(`${label}: no behavior.md scaffolding ("Under 4 lines")`, !p.includes('Under 4 lines'));
    ok(`${label}: no research.md methodology ("Researching the project")`, !p.includes('Researching the project'));
    ok(`${label}: no terse-replies instruction ("Answer tersely")`, !p.includes('Answer tersely'));
    ok(`${label}: no skills index`, !p.includes('skill'));
    ok(`${label}: no weak-only scaffolding markers`, !p.includes('weak-only'));
  }

  // ── Pure visual-describe turns: repo profile OUT, attachment guard IN ──
  // The profile's "Stack: …" / "layout: …" lines are what a weak model fuses into an image
  // answer (2026-08-24 trip-screen incident). buildSimpleSystemPrompt(pureVisualDescribe=true)
  // must remove them and add the explicit answer-from-the-attachment guard instead.
  const visual = await buildSimpleSystemPrompt('agent', true);
  ok('visual: no auto-detected project profile ("## This project")', !visual.includes('## This project'));
  ok('visual: attachment guard present', visual.includes('## About the attachment'));
  ok('visual: guard says to ignore workspace code', visual.includes("Ignore this workspace's code"));
  ok('non-visual keeps the profile (control)', agent.includes('## This project'));
  ok('non-visual has no attachment guard (control)', !agent.includes('## About the attachment'));

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
