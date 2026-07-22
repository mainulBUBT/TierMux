

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { loadUserMemory } from '../context/userMemory';
import { loadProjectRules } from '../context/projectRules';
import { skillIndexPrompt } from '../context/skills';

let extensionPath: string | undefined;
/** Set once at activation so buildSystemPrompt can locate `.tiermux/agent/*.md`. */
export function setExtensionPath(p: string): void {
  extensionPath = p;
}

/** Explicit concatenation order for `.tiermux/agent/*.md` — identity MUST lead ("You are
 *  TierMux…" needs to be the first thing a weaker/free model reads). Files not listed here
 *  sort alphabetically after all of these. */
const AGENT_FILE_ORDER = ['identity.md', 'behavior.md', 'ask-format.md', 'research.md'];

/** Loads `.tiermux/agent/*.md` scaffolding + project rules/memory/skills index, reading fresh
 *  every call (no caching) — editing `.tiermux/memory.md` takes effect on the very next turn. */
async function loadAgentInstructions(extPath: string, workspaceRoot?: string): Promise<{ agentPrompt: string; instructions: string }> {
  const agentDir = path.join(extPath, '.tiermux', 'agent');
  let base: string;
  try {
    const files = fs.readdirSync(agentDir)
      .filter((f) => f.endsWith('.md'))
      .sort((a, b) => {
        const ia = AGENT_FILE_ORDER.indexOf(a);
        const ib = AGENT_FILE_ORDER.indexOf(b);
        if (ia === -1 && ib === -1) return a.localeCompare(b);
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });
    if (!files.length) throw new Error('no .md files found');
    base = files
      .map((f) => { try { return fs.readFileSync(path.join(agentDir, f), 'utf8').trim(); } catch { return ''; } })
      .filter(Boolean)
      .join('\n\n');
  } catch {
    base = '# Identity\nYou are TierMux, an AI coding assistant.';
  }
  const memory = await loadUserMemory().catch(() => '');
  const rules = await loadProjectRules().catch(() => '');
  const skills = skillIndexPrompt(extPath, workspaceRoot);
  return { agentPrompt: base, instructions: [rules, memory, skills].filter(Boolean).join('\n\n') };
}

/**
 * Short mode-specific tails appended to the shared `.tiermux/agent` scaffolding — the bulk of
 * behavior lives in the editable `.tiermux/agent/*.md` files; these only encode what THIS mode is.
 */
const AGENT_MODE_TAIL =
  '\n\n## Agent mode\n'
  + 'You can edit/write files and run commands. First check what the message actually asks: '
  + 'if it is only a question or a greeting, answer in text — do NOT edit files just because '
  + 'you can. Only modify files when the user asks you to change, fix, add, remove, or '
  + 'implement something.';

const PLAN_MODE_TAIL =
  '\n\n## Plan mode\n'
  + 'You are in READ-ONLY plan mode: you cannot edit files or run commands.\n\n'
  + '**If the message is a question, explanation request, or discussion** (e.g. "why does X work?", '
  + '"how does Y work?", "what is Z?", "explain …"): answer directly in flowing prose paragraphs. '
  + 'Do NOT use bullet points or numbered lists for these conversational replies — prose only. '
  + 'This ensures your answer is displayed as plain text, not misread as an executable plan.\n\n'
  + '**If the message is a real task or change request** (e.g. "add dark mode", "fix the bug in X", '
  + '"implement Y"): investigate the relevant files first using your read tools, then reply with a '
  + 'concise plan using numbered or bulleted steps — each step naming the file/symbol it touches. '
  + 'If the work splits into priority tiers (quick wins vs larger changes), group steps under short '
  + 'headings, but keep the actual steps as a numbered/bulleted list under each heading so they can '
  + 'be reviewed and approved individually.\n\n'
  + 'For a trivial message (a greeting like "hi", small talk), just reply briefly and directly.\n\n'
  + 'If you need to ask the user something before you can plan, use ONLY the '
  + '???QUESTIONS???...???END??? text block (see the ask-format instructions) — do NOT call '
  + 'an interactive question tool for this.';

const ASK_MODE_TAIL =
  '\n\n## Ask mode\n'
  + 'You are in Ask mode: a pure conversational Q&A mode with no file or tool access at all. '
  + "Answer the user's question directly from the conversation so far and your general "
  + "knowledge. If it needs grounding in this project's actual files, say so plainly instead "
  + 'of guessing — the user can switch to Agent or Plan mode for that. '
  + 'Do not propose a plan or list steps to execute; just answer.';

function modeTail(mode: 'agent' | 'plan' | 'ask'): string {
  return mode === 'plan' ? PLAN_MODE_TAIL : mode === 'ask' ? ASK_MODE_TAIL : AGENT_MODE_TAIL;
}

/** Grounds the model against its training cutoff — without this, free/local models guess
 *  a "today" from training data and produce date-confused answers (e.g. claiming "today is
 *  2024" while citing a 2026 event in the same breath). */
function todayLine(): string {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return `Today's date is ${today}.`;
}

export async function buildSystemPrompt(mode: 'agent' | 'plan' | 'ask'): Promise<string> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!extensionPath) {
    return '# Identity\nYou are TierMux, an AI coding assistant.' + modeTail(mode) + `\n\n${todayLine()}`;
  }
  const { agentPrompt, instructions } = await loadAgentInstructions(extensionPath, workspaceRoot);
  return [agentPrompt + modeTail(mode), todayLine(), instructions].filter(Boolean).join('\n\n');
}
