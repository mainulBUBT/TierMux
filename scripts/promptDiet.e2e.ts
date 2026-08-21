// Prompt diet + cache-boundary assembly, against the REAL repo scaffolding files:
// - agent-mode stable core (scaffolding + mode tail) is materially slimmer than the old ~19.7K
// - two builds with the same session inputs are byte-identical (prefix-cache contract)
// - volatile content (date, findings) sits AFTER the stable core + instructions
// - weak-only sections are stripped for strong models, kept for weak ones
//
// Run:  npm run test:e2e:prompt-diet
import { buildSystemPrompt, setExtensionPath } from '../src/agent/promptBuilder';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path') as typeof import('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');

let failures = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failures++;
};

async function main() {
  const repoRoot = path.resolve(__dirname, '..');
  setExtensionPath(repoRoot);
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: repoRoot, path: repoRoot } }];

  const agent = await buildSystemPrompt('agent', 'agent', 'sess-diet', 'add a flag to the cli');
  const ask = await buildSystemPrompt('ask', 'chat', 'sess-diet', 'what does x do');

  // Stable core = everything before the "Today's date" boundary (instructions included: they
  // are session-stable). The OLD layout interleaved the date mid-prompt.
  const dateIdx = agent.indexOf("Today's date is");
  ok('agent prompt has the date line', dateIdx > 0);
  const core = agent.slice(0, dateIdx);

  // Diet, apples-to-apples: the OLD stable prefix was 12,752 scaffolding + 6,862 tail ≈ 19.6K
  // (rules/skills excluded). This repo's core includes its rules + skills index, so measure the
  // comparable number from a BLANK workspace (no CLAUDE.md/memory) as well.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const scratchWs = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'tiermux-diet-ws-'));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: scratchWs, path: scratchWs } }];
  const blank = await buildSystemPrompt('agent', 'agent', 'sess-blank', 'add a flag to the cli');
  const blankCore = blank.slice(0, blank.indexOf("Today's date is"));
  ok('agent stable core shrank materially (< 15.5K vs old ~19.6K scaffolding+tail)', blankCore.length < 15_500, `${blankCore.length} chars`);
  require('fs').rmSync(scratchWs, { recursive: true, force: true });
  // Restore the repo workspace BEFORE later builds — agent2 below must see the same rules.
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: repoRoot, path: repoRoot } }];

  // Cache contract: same session inputs → byte-identical prompt.
  const agent2 = await buildSystemPrompt('agent', 'agent', 'sess-diet', 'add a flag to the cli');
  ok('same-session rebuild is byte-identical (prefix cache holds)', agent === agent2);

  // Volatile ordering: instructions (AGENTS.md/CLAUDE.md/rules) before the date line.
  const rulesIdx = Math.max(agent.lastIndexOf('## CLAUDE.md'), agent.lastIndexOf('## AGENTS.md'));
  ok('repo rules sit inside the stable prefix (before the date line)', rulesIdx > -1 && rulesIdx < dateIdx);

  // Mode variation still works.
  ok('ask-mode prompt differs from agent-mode (mode tails applied)', ask !== agent && ask.includes('## Ask mode'));

  // Volatile-last: with no findings recorded for a fresh session id, the DATE line is the
  // prompt's final content — everything stable sits before it.
  ok('volatile content (date) is the final block of the prompt', /Today's date is [^\n]+$/.test(agent.trimEnd()));

  // Weak-only marker stripping: with a section wrapped in the markers on disk? (repo has none —
  // verify the mechanism via a scratch extension path instead.)
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-diet-'));
  fs.mkdirSync(path.join(scratch, '.tiermux', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(scratch, '.tiermux', 'agent', 'identity.md'),
    '# Identity\nYou are TierMux.\n\n<!-- weak-only -->\nExtra hand-holding for weak models only.\n<!-- /weak-only -->\n');
  setExtensionPath(scratch);
  const strong = await buildSystemPrompt('agent', 'agent', 's2', 'hi', false);
  const weak = await buildSystemPrompt('agent', 'agent', 's2', 'hi', true);
  ok('weak-only section stripped for strong models', !strong.includes('Extra hand-holding'));
  ok('weak-only section kept for weak models', weak.includes('Extra hand-holding'));
  ok('markers never reach the model on either path',
    !strong.includes('weak-only') && !weak.includes('<!--'));
  fs.rmSync(scratch, { recursive: true, force: true });

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
