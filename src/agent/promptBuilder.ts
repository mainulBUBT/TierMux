

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { loadUserMemory } from '../context/userMemory';
import { loadProjectRules } from '../context/projectRules';
import { skillIndexPrompt } from '../context/skills';
import type { TaskKind } from './routing';

/** Scaffolding files that are irrelevant for a lightweight turn and safe to skip — every model
 *  call pays for the full system prompt in prefill time, and a "hi"/small-talk turn (trivial) or
 *  a plain Q&A (chat) never needs project-research methodology. identity/behavior/ask-format
 *  stay in always: they're small and govern tone/interaction-format regardless of task weight. */
const SKIP_FILES_FOR_TASK_KIND: Partial<Record<TaskKind, string[]>> = {
  trivial: ['research.md'],
  chat: ['research.md'],
};

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
async function loadAgentInstructions(extPath: string, workspaceRoot?: string, taskKind?: TaskKind): Promise<{ agentPrompt: string; instructions: string }> {
  const agentDir = path.join(extPath, '.tiermux', 'agent');
  const skipFiles = new Set(taskKind ? SKIP_FILES_FOR_TASK_KIND[taskKind] ?? [] : []);
  let base: string;
  try {
    const files = fs.readdirSync(agentDir)
      .filter((f) => f.endsWith('.md') && !skipFiles.has(f))
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
  // Skill index is only useful when the model might reach for a /slash-command skill — never for
  // a trivial (greeting/small-talk) turn.
  const skills = taskKind === 'trivial' ? '' : skillIndexPrompt(extPath, workspaceRoot);
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
  + 'implement something.\n\n'
  + 'When you edit files, use `getDiagnostics` to verify whether your changes introduce '
  + 'TypeScript or linter errors, and automatically fix any errors before finishing.\n\n'
  + 'When you need external documentation, specs, or web pages, use `fetchUrl` to retrieve them. '
  + 'When the question is about something current or general-knowledge that is not answerable from '
  + 'this codebase (news, current events, a fact about the outside world, a library/API you need to '
  + 'look up), use `webSearch` instead of grepping the codebase for it — do not search local files '
  + 'for information that was never going to be in them.\n\n'
  + 'When you need to LOCATE code or UNDERSTAND how part of the codebase works before acting '
  + '(e.g. "where is X handled", "how does Y flow", "which files touch Z"), prefer the `explore` '
  + 'tool over running many grep/read calls yourself: it delegates the search to a fast '
  + 'read-only sub-agent and returns a compact findings summary (files, symbols, line numbers), '
  + 'keeping your context small. Use direct grep/read for a single known file or a quick check.\n\n'
  + '### Working autonomously\n'
  + 'You are an autonomous agent, not a one-reply chatbot. For any task that takes more than a '
  + 'couple of steps (implementing a feature, fixing a bug across files, a multi-part change), FIRST '
  + 'call `todowrite` with a concrete plan — one item per verifiable step — then carry it out to '
  + 'completion in this run. As you work, keep the todo list in lockstep: mark exactly one item '
  + '`in_progress` while you do it, `completed` the moment it is done, and add items you discover are '
  + 'needed. Do NOT stop and hand back to the user while items are still `pending` or `in_progress` — '
  + 'keep going through the whole plan. The plan is done only when every item is `completed`.\n\n'
  + 'Before marking the LAST item complete, verify your own work: check diagnostics on files you '
  + 'edited (`getDiagnostics`) and confirm the change actually satisfies the original request. Only '
  + 'stop early if you hit a genuine blocker (missing information only the user has, a destructive '
  + 'action needing consent, or repeated failure) — and when you do, say plainly what is blocking and '
  + 'what you have done so far. For a simple one-step task or a plain question, skip the todo list and '
  + 'just do it — the plan is for multi-step work.\n\n'
  + '### Using tools reliably (critical)\n'
  + 'NEVER announce an action without actually performing it. Writing "Let me read the file", "I\'ll '
  + 'fix it", or "let me check the routes" and then stopping is a FAILURE — nothing is read and '
  + 'nothing changes. Every time you are about to describe doing something, emit the tool call '
  + 'instead. A turn that only describes what you would do, with no tool call, is wrong.\n\n'
  + 'Always prefer your native tool-calling. But if you cannot emit a native tool call, emit it as '
  + 'text in EXACTLY this format — a real call will run from it:\n'
  + '<function=TOOL_NAME>{"arg": "value"}</function>\n'
  + 'Examples: <function=readFile>{"path": "routes/web.php"}</function> · '
  + '<function=grep>{"pattern": "Laravel", "path": "resources/views"}</function> · '
  + '<function=editFile>{"path": "resources/views/welcome.blade.php", "search": "Laravel", "replace": "Bazardor"}</function>\n'
  + 'Rules for the text form: output the tag on its own, NOT inside backticks or a code fence; use '
  + 'the real tool name and its real arguments (JSON); emit ONE call, then STOP and wait for the '
  + 'result before deciding the next step. Do not invent tool names — use only the tools you were given.';

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
  + 'You are in Ask mode: read-only Q&A. You can search and read the codebase (readFile, '
  + 'listDir, glob, grep, explore) to ground your answer in the actual project files, but you '
  + 'cannot edit or create files, delete anything, or run commands. Use a tool only when the '
  + "question actually needs it — a general question doesn't. If the question is about "
  + 'something current or outside this codebase (news, current events, a general fact, an '
  + 'external library/API), use `webSearch` instead of grepping local files for it — local '
  + "search tools cannot answer something that was never going to be in the project's files. "
  + 'Use `fetchUrl` to read the full content of a promising `webSearch` result (or any URL the '
  + "user gave you) when the snippet alone isn't enough. If a tool call fails or you "
  + "don't have a tool for what you need, don't dwell on the error or apologize at length: "
  + 'answer from the conversation and your general knowledge instead, noting briefly if the '
  + "answer isn't grounded in the actual files. If the question needs an edit or a command run "
  + '(making a change, running a build/test), say so and suggest switching to Agent mode. '
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

export async function buildSystemPrompt(mode: 'agent' | 'plan' | 'ask', taskKind?: TaskKind): Promise<string> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!extensionPath) {
    return '# Identity\nYou are TierMux, an AI coding assistant.' + modeTail(mode) + `\n\n${todayLine()}`;
  }
  const { agentPrompt, instructions } = await loadAgentInstructions(extensionPath, workspaceRoot, taskKind);
  return [agentPrompt + modeTail(mode), todayLine(), instructions].filter(Boolean).join('\n\n');
}
