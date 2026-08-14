

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { loadUserMemory } from '../context/userMemory';
import { loadProjectRules } from '../context/projectRules';
import { skillIndexPrompt } from '../context/skills';
import { findingsPrompt } from './sessionFindings';
import type { TaskKind } from './routing';
import type { AgentMode } from './agent';

/** Scaffolding files safe to skip for a lightweight turn — every model call pays for the full
 *  system prompt in prefill time, and a "hi"/small-talk turn (trivial) never needs project-
 *  research methodology.
 *
 *  `chat` deliberately KEEPS research.md — regressed once already (recovered 2026-08-10) after
 *  being wrongly skipped for `chat`: in this classifier `chat` means "a question", and "how does
 *  X work in this repo" is its most common form (classifyTaskCore sends every EXPLAIN_Q match
 *  here). Skipping the methodology stripped search-before-read/tool-ordering/conventions from
 *  exactly the queries that need them — measured: the 2026-08-09 benchmark scored 60% retrieval
 *  on `explain` with the skip in place, rising to 70% once removed. Do not re-add it without new
 *  evidence — see docs/AGENT_QUALITY_2026-08-09.md. */
const SKIP_FILES_FOR_TASK_KIND: Partial<Record<TaskKind, string[]>> = {
  trivial: ['research.md'],
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
async function loadAgentInstructions(extPath: string, workspaceRoot?: string, taskKind?: TaskKind, mode?: AgentMode): Promise<{ agentPrompt: string; instructions: string }> {
  const agentDir = path.join(extPath, '.tiermux', 'agent');
  const skipFiles = new Set(taskKind ? SKIP_FILES_FOR_TASK_KIND[taskKind] ?? [] : []);
  // ask-format.md documents the askQuestions pre-flight clarify tool, and PLAN_MODE_TAIL is
  // the only place that asks for it — agent/ask mode were paying ~1.3KB of prompt for a protocol
  // they never use, competing for a free model's attention with rules that do apply.
  if (mode && mode !== 'plan') skipFiles.add('ask-format.md');
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
  + 'You can edit/write files and run commands. If the message is only a question or greeting, '
  + 'answer in text — do NOT edit files just because you can; only modify files when asked to '
  + 'change, fix, add, remove, or implement something. Never claim you lack execution/runtime/'
  + 'test-running capability — you have `runCommand` in this mode. If unsure whether something '
  + 'will work, try the tool before declining.\n\n'
  + 'Use `fetchUrl` for docs/specs/web pages. For something current or outside this codebase '
  + '(news, a fact about the outside world, a library/API to look up), use `webSearch` — not a '
  + 'local search for info that was never going to be in local files. For a specific library, '
  + 'package, or API, prefer `deepSearch` over `webSearch` — it queries those sources directly.\n\n'
  + 'YOUR KNOWLEDGE HAS A CUTOFF before today\'s date (shown above). For anything that could have '
  + 'changed since — outcomes, elections, releases, prices, or phrasing with a year/"latest"/'
  + '"current" — call `webSearch`/`deepSearch` BEFORE answering, never from memory, and never say '
  + 'an event "hasn\'t happened yet" when today\'s date shows otherwise. Nothing useful found: say '
  + 'you couldn\'t verify it.\n\n'
  + '### Working autonomously\n'
  + 'You are an autonomous agent, not a one-reply chatbot. For anything past a couple of steps, '
  + 'FIRST call `todowrite` with one item per verifiable step, then carry it out to completion — '
  + 'exactly one `in_progress` at a time, `completed` the moment it\'s done, add items you '
  + 'discover. Don\'t hand back while items are `pending`/`in_progress`. Before the LAST item, '
  + 'verify your own work (`getDiagnostics`, confirm the change satisfies the request). Stop early '
  + 'only on a genuine blocker (missing info only the user has, consent needed, repeated failure) '
  + 'and say plainly what\'s blocking and what\'s done. Skip the todo list for a one-step task.\n\n'
  + '### Parallel work via `implementPipeline`\n'
  + 'For a task that splits into INDEPENDENT, NON-OVERLAPPING multi-file subtasks (e.g. "implement '
  + 'features A, B, and C, each in its own module"), you can author a `plan` of disjoint subtasks '
  + '(each item lists its OWN files — no two items share a file) and call `implementPipeline`. It '
  + 'runs the subtasks in parallel as worker sub-agents, each in a private git worktree, then merges '
  + 'them into a staging branch (your working tree is untouched). Use it ONLY for genuinely '
  + 'parallelizable work — it costs ~N× a normal turn, and shared-file subtasks will conflict. For '
  + 'a single-file fix, tightly-coupled steps, or anything sequential, just do the work yourself '
  + 'with the normal edit tools. Partition first; if you can\'t make the file sets disjoint, run '
  + 'those parts sequentially instead.\n\n'
  + '### Ground changes in the existing project (critical)\n'
  + 'Before editing a file, read the relevant part of it (and anything it clearly depends on) — '
  + 'never edit blind from the request text alone, and never reimplement something that may already '
  + 'exist elsewhere in the project. Match the project\'s existing patterns (naming, structure, '
  + 'libraries already in use) instead of introducing a different approach of your own. If the '
  + 'request names a feature/file/system, find and open it first (grep/glob/explore) — a '
  + 'plausible-sounding guessed path or symbol is how an edit lands on the wrong file or duplicates '
  + 'logic that already exists.\n\n'
  + '### Using tools reliably (critical)\n'
  + 'NEVER announce an action without performing it — "Let me read the file" and then stopping is '
  + 'a FAILURE, nothing changes. Every time you\'re about to describe doing something, emit the '
  + 'tool call instead.\n\n'
  + 'Always prefer native tool-calling. If you cannot emit a native call, emit it as text in '
  + 'EXACTLY this format — a real call will run from it:\n'
  + '<function=TOOL_NAME>{"arg": "value"}</function>\n'
  // The example path must be one that exists in almost any project: a weaker model copies the
  // example verbatim on its first fallback call, and a framework-specific path (e.g. a Laravel
  // `routes/web.php`) turns that first call into a not-found error in every other project.
  + 'Example: <function=readFile>{"path": "README.md"}</function>\n'
  + 'Tag on its own, not in backticks; real tool name and JSON arguments; emit ONE call then STOP '
  + 'and wait for the result. Never invent a tool name.\n\n'
  + '### Shell command strategy\n'
  + '`runCommand` has no terminal — no pager, no input prompt. Run ONE command per call, not a '
  + '`&&`/`;` chain — a swallowed exit code hides which part failed. Never a pager (`less`, `git '
  + 'log` without `--no-pager`) or an interactive/`-i` flag (`git rebase -i`, `npm init` without '
  + '`-y`) — it will hang waiting for input that never comes. Pipe through `head`/`tail`/`grep` to '
  + 'narrow noisy output.';

const PLAN_MODE_TAIL =
  '\n\n## Plan mode\n'
  + 'READ-ONLY: you cannot edit files or run commands.\n\n'
  + '**Question, explanation, or discussion** ("why does X work?", "explain …"): answer directly '
  + 'in flowing prose paragraphs, NOT bullet/numbered lists — that displays as plain text instead '
  + 'of being misread as an executable plan.\n\n'
  + '**Real task or change request** ("add dark mode", "fix the bug in X"): investigate with read '
  + 'tools first, then reply with ONE short lead-in sentence stating what the plan achieves — this '
  + 'becomes the plan card\'s description, shown alone with no other context, so it must stand '
  + 'alone: a complete sentence ending in a period, e.g. "This adds a dark mode toggle to the admin '
  + 'panel that persists the user\'s preference." Never open with meta-commentary about the mode or '
  + 'reply itself ("You\'re in plan mode…", "Here is the plan…") — just state what the change does. '
  + 'Always include it, even for a small change. Follow it with the plan as a NUMBERED LIST ("1. ", '
  + '"2. ", …), one step per line, each starting with an imperative verb (Add, Update, Fix, '
  + 'Refactor, Remove) and naming the file/symbol it touches — never flowing prose here, steps must '
  + 'be separate lines so they can be reviewed individually. For priority tiers (quick wins vs '
  + 'larger changes), group under short headings but keep steps as a list under each.\n\n'
  + 'Trivial message (a greeting, small talk): reply briefly and directly.\n\n'
  + 'If a "## Approaches considered" section appears above, weave its recommendation and the '
  + 'rejected alternative\'s tradeoff into the lead-in sentence ("…, using X over Y because…") — no '
  + 'separate section, no restating the analysis.\n\n'
  + 'Ask before investigating, not after, ONLY when something is ambiguous in a way that changes '
  + 'WHICH files/approach you\'d investigate — call the `askQuestions` tool (see ask-format). '
  + 'Exception, not a default step before every plan.';

const ASK_MODE_TAIL =
  '\n\n## Ask mode\n'
  + 'Read-only Q&A: search/read the codebase (readFile, listDir, glob, grep, explore) to ground '
  + 'your answer, but no edit/create/delete/run. Use a tool only when the question needs it. For '
  + 'something current or outside this codebase, use `webSearch` — not a local search for info '
  + 'that was never going to be there. `fetchUrl` to read a promising result\'s full content when '
  + "the snippet isn't enough. Tool call fails or you lack one: don't dwell on it, answer from "
  + "general knowledge and note briefly if it isn't grounded in the actual files.\n\n"
  + '**Specific, answerable lookup** ("what does X do", "where is Z defined"): read what you need, '
  + 'answer directly.\n\n'
  + '**Open-ended** ("how should we approach this", "what do you think about Y") — think out loud: '
  + 'read enough for an informed opinion, respond like a conversation, not a report. Flowing '
  + 'prose, one idea building on the last — NOT bullet points/numbered lists/category headings, '
  + 'that structured-menu format shuts down discussion. Pick a place to start, say what you\'d try '
  + 'and why (referencing real files/symbols), surface the trade-offs that matter, ask if genuinely '
  + 'ambiguous. Present it as something the user can redirect, not a decided plan — that belongs in '
  + 'Plan mode.\n\n'
  + "Either way: if it needs an edit or a command run, say so and suggest Agent mode.\n\n"
  + 'Always prefer native tool-calling. If you cannot emit a native call, emit it as text in '
  + 'EXACTLY this format — a real call will run from it:\n'
  + '<function=TOOL_NAME>{"arg": "value"}</function>\n'
  // The example path must be one that exists in almost any project: a weaker model copies the
  // example verbatim on its first fallback call, and a framework-specific path (e.g. a Laravel
  // `routes/web.php`) turns that first call into a not-found error in every other project.
  + 'Example: <function=readFile>{"path": "README.md"}</function>\n'
  + 'Tag on its own, not in backticks; real tool name and JSON arguments; emit ONE call then STOP '
  + 'and wait for the result. Never invent a tool name or tag dialect.';

function modeTail(mode: AgentMode): string {
  if (mode === 'plan') return PLAN_MODE_TAIL;
  if (mode === 'ask') return ASK_MODE_TAIL;
  return AGENT_MODE_TAIL;
}

/** Grounds the model against its training cutoff — without this, free/local models guess
 *  a "today" from training data and produce date-confused answers (e.g. claiming "today is
 *  2024" while citing a 2026 event in the same breath). */
function todayLine(): string {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return `Today's date is ${today}.`;
}

/** `sessionId` appends this conversation's findings note (see sessionFindings.ts). It belongs in
 *  the SYSTEM prompt specifically: the message history it summarises is exactly what pruning and
 *  condensation throw away, and the system prompt is the only part rebuilt intact every turn. */
export async function buildSystemPrompt(mode: AgentMode, taskKind?: TaskKind, sessionId?: string): Promise<string> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const findings = findingsPrompt(sessionId);
  if (!extensionPath) {
    return '# Identity\nYou are TierMux, an AI coding assistant.' + modeTail(mode) + `\n\n${todayLine()}` + findings;
  }
  const { agentPrompt, instructions } = await loadAgentInstructions(extensionPath, workspaceRoot, taskKind, mode);
  return [agentPrompt + modeTail(mode), todayLine(), instructions].filter(Boolean).join('\n\n') + findings;
}
