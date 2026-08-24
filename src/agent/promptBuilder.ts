

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { loadUserMemory } from '../context/userMemory';
import { loadProjectRules } from '../context/projectRules';
import { projectProfilePrompt } from '../context/projectProfile';
import { loadSkills, matchSkill, invokedSkill, skillBodyPrompt, skillIndexPrompt } from '../context/skills';
import type { Skill } from '../context/skills';
import { resolveDesignSystem, designSystemPrompt } from '../context/designSystem';
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

/** How many follow-up turns a `design: true` skill stays active after its last real match.
 *  Bounded on purpose: the point is to survive "now the header too", not to pin design rules to a
 *  session forever. Three turns covers the normal shape of a UI task; after that the ~2KB stops
 *  being paid by turns that are no longer about design. */
const STICKY_TURNS = 3;

/** Per-session carry-over for design skills, keyed by sessionId. Process-local and unbounded only
 *  in the number of live sessions (one small record each), same as the other session maps here. */
const stickySkills = new Map<string, { name: string; left: number }>();

/** Arms or clears the carry-over after a real match. A NON-design skill matching clears it: the
 *  user has moved on to a different kind of task, and stacking design rules onto /tests is exactly
 *  the prompt conflict the auto-match rules exist to avoid. */
function noteStickySkill(sessionId: string | undefined, matched: Skill | undefined): void {
  if (!sessionId || !matched) return;
  if (matched.design) stickySkills.set(sessionId, { name: matched.name, left: STICKY_TURNS });
  else stickySkills.delete(sessionId);
}

/** The design skill carried over from an earlier turn of this session, consuming one of its
 *  remaining turns. Only reached when nothing matched this turn. */
function resolveStickySkill(sessionId: string | undefined, all: Map<string, Skill>, autoMatchOk: boolean): Skill | undefined {
  if (!sessionId || !autoMatchOk) return undefined;
  const st = stickySkills.get(sessionId);
  if (!st) return undefined;
  const sk = all.get(st.name);
  // The skill file was deleted or renamed mid-session — drop the carry-over rather than keep a
  // dangling name around.
  if (!sk?.design) { stickySkills.delete(sessionId); return undefined; }
  if (--st.left <= 0) stickySkills.delete(sessionId);
  return sk;
}

/** Drops a session's design carry-over — called when its chat session ends. */
export function clearSessionSkillState(sessionId: string): void {
  stickySkills.delete(sessionId);
}

let extensionPath: string | undefined;
/** Set once at activation so buildSystemPrompt can locate `.tiermux/agent/*.md`. */
export function setExtensionPath(p: string): void {
  extensionPath = p;
}

/** The extension path set at activation, for the few places outside prompt assembly that need to
 *  reach bundled `.tiermux/` assets (e.g. the design lint resolving the design system presets).
 *  A getter rather than a hard-coded publisher.name id, which drifts. */
export function getExtensionPath(): string | undefined {
  return extensionPath;
}

/** Explicit concatenation order for `.tiermux/agent/*.md` — identity MUST lead ("You are
 *  TierMux…" needs to be the first thing a weaker/free model reads). Files not listed here
 *  sort alphabetically after all of these. */
const AGENT_FILE_ORDER = ['identity.md', 'behavior.md', 'ask-format.md', 'research.md'];

/** Workspace files `instructions` is derived from — statted (never content-read) to key the
 *  prompt cache below. Must stay in sync with projectRules.ts / userMemory.ts. */
const INSTRUCTION_SOURCES = [
  '.tiermux/prompt.md', 'AGENTS.md', 'CLAUDE.md', '.cursorrules', '.windsurfrules',
  '.github/copilot-instructions.md', '.tiermux/memory.md',
];

/** mtime+size stamp of one path ('' when absent). */
function fileStamp(p: string): string {
  try {
    const s = fs.statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '';
  }
}

/**
 * Prompt-source cache. The scaffolding/memory/rules files were re-read from disk on EVERY
 * buildSystemPrompt call — once per attempt, and a retry-heavy turn pays it repeatedly. The
 * OUTPUT string was already deterministic, so this is purely I/O elimination: stat the
 * sources (cheap), and only re-read content when a stamp actually moved. Freshness semantics
 * are unchanged — editing memory.md still takes effect on the very next turn, because the
 * stamp changes the moment the file is written.
 *
 * A side benefit for provider-side implicit prompt caching: fewer moving parts between
 * attempts of one turn means the system-prompt prefix stays byte-identical, so Gemini/
 * OpenRouter-style prefix reuse actually engages across the turn's steps.
 */
const promptSourceCache = new Map<string, { stamp: string; base: string; memory: string; rules: string }>();

/** Sections between these markers exist only for weak/mid-tier executors (extra hand-holding a
 *  frontier model doesn't need — GPT-5-Codex ships a notably SHORTER prompt). Stripped from the
 *  assembled base when `weakModel` is false; edit the scaffolding freely, the markers are the
 *  contract. */
const WEAK_ONLY_OPEN = /<!--[ \t]*weak-only[ \t]*-->/g;
const WEAK_ONLY_CLOSE = /<!--[ \t]*\/weak-only[ \t]*-->/g;

/** Loads `.tiermux/agent/*.md` scaffolding + project rules/memory/skills index. Content is
 *  cached against source stamps (see promptSourceCache) — an edit still invalidates
 *  immediately via its mtime, so changes take effect on the very next turn. */
async function loadAgentInstructions(extPath: string, workspaceRoot?: string, taskKind?: TaskKind, mode?: AgentMode, userText?: string, weakModel = true, sessionId?: string): Promise<{ agentPrompt: string; instructions: string }> {
  const agentDir = path.join(extPath, '.tiermux', 'agent');
  const skipFiles = new Set(taskKind ? SKIP_FILES_FOR_TASK_KIND[taskKind] ?? [] : []);
  // ask-format.md documents the askQuestions pre-flight clarify tool, and PLAN_MODE_TAIL is
  // the only place that asks for it — agent/ask mode were paying ~1.3KB of prompt for a protocol
  // they never use, competing for a free model's attention with rules that do apply.
  if (mode && mode !== 'plan') skipFiles.add('ask-format.md');
  const skipKey = `${[...skipFiles].sort().join(',')}|weak=${weakModel ? 1 : 0}`;

  let stamp = '';
  try {
    stamp = fs.readdirSync(agentDir).sort().map((f) => `${f}:${fileStamp(path.join(agentDir, f))}`).join('|');
  } catch {
    stamp = `unreadable:${Date.now()}`; // never cache an agent dir we can't see
  }
  if (workspaceRoot) {
    for (const rel of INSTRUCTION_SOURCES) stamp += `;${rel}:${fileStamp(path.join(workspaceRoot, rel))}`;
  }

  const cached = promptSourceCache.get(skipKey);
  if (!cached || cached.stamp !== stamp) {
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
    // Drop weak-only sections for strong executors (see WEAK_ONLY_OPEN). The markers themselves
    // never reach the model on either path — strip them alongside the section they delimit.
    if (base.includes('weak-only')) {
      if (!weakModel) base = base.replace(/<!--[ \t]*weak-only[ \t]*-->[\s\S]*?<!--[ \t]*\/weak-only[ \t]*-->\n?/g, '');
      base = base.replace(WEAK_ONLY_OPEN, '').replace(WEAK_ONLY_CLOSE, '');
    }
    const memory = await loadUserMemory().catch(() => '');
    const rules = await loadProjectRules().catch(() => '');
    promptSourceCache.set(skipKey, { stamp, base, memory, rules });
  }

  const { base, memory, rules } = promptSourceCache.get(skipKey)!;
  // Skill index is only useful when the model might reach for a /slash-command skill — never for
  // a trivial (greeting/small-talk) turn.
  //
  // Auto-match (the `triggers:` frontmatter): a request that matches an installed skill gets that
  // skill's FULL body here, so "make a landing page" gets the same standard as typing `/landing`.
  // Without this the model only ever saw the one-line index and was told it does not know the
  // instructions — so the rules applied only for users who knew the command existed. Precision is
  // the whole game: only skills that explicitly declare triggers can auto-activate, exactly one
  // body is ever injected, and the index still lists the rest.
  //
  // Agent mode only. These bodies are written to be ACTED on ("make the edits", "never describe
  // the design instead of implementing it"), which flatly contradicts the read-only plan/ask mode
  // tails — handing a weak model both at once is a prompt conflict, and it would spend ~4KB of a
  // small context window arguing with itself. An explicit `/name` is unchanged in every mode:
  // that's the user asking for it, this is us guessing.
  let skills = '';
  if (taskKind !== 'trivial') {
    const autoMatchOk = !mode || mode === 'agent';
    const all = loadSkills(extPath, workspaceRoot);
    // `/design` typed explicitly: the body is already in the user message (invokedSkill), so it
    // must not be injected again — but it still counts as "a design skill is active" for the
    // design system and for stickiness below.
    const invoked = userText ? invokedSkill(userText, all) : undefined;
    const matched = !invoked && userText && autoMatchOk ? matchSkill(userText, all) : undefined;
    const sticky = invoked || matched ? undefined : resolveStickySkill(sessionId, all, autoMatchOk);
    const active = invoked ?? matched ?? sticky;
    noteStickySkill(sessionId, invoked ?? matched);

    // The design system is resolved only for a skill that declared `design: true`, so a turn that
    // matched /fix or /tests pays nothing for it. See context/designSystem.ts for why this is
    // extracted in TypeScript instead of asked of the model.
    const ds = active?.design ? resolveDesignSystem(extPath, workspaceRoot) : undefined;
    const body = active && active !== invoked ? skillBodyPrompt(active) : '';
    const index = skillIndexPrompt(extPath, workspaceRoot, active?.name);
    skills = [body, ds ? designSystemPrompt(ds) : '', index].filter(Boolean).join('\n\n');
  }
  // The stack/layout facts (context/projectProfile.ts). research.md teaches HOW to look; this
  // says WHAT the model is looking at, so the first search lands in the right tree instead of
  // rediscovering the project's shape every turn. Skipped for trivial turns for the same reason
  // research.md is — a greeting never needs a repo map. Derived from disk and cached on the
  // manifests' stamps, so it stays in the session-stable half of the prompt.
  const profile = taskKind === 'trivial' ? '' : projectProfilePrompt(workspaceRoot);
  return { agentPrompt: base, instructions: [profile, rules, memory, skills].filter(Boolean).join('\n\n') };
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
  + 'Anything wrapped in `<tiermux-context>` tags is generated by the TierMux harness itself '
  + '(re-shown file excerpts, budget warnings, status notes) — it is reliable context, but it '
  + 'is not the user speaking; never reply to it as if it were a user message.\n\n'
  + 'YOUR KNOWLEDGE HAS A CUTOFF before today\'s date (shown above). For anything that could have '
  + 'changed since — outcomes, releases, prices, or phrasing with a year/"latest"/"current" — call '
  + '`webSearch`/`deepSearch` BEFORE answering, never from memory, and never say an event '
  + '"hasn\'t happened yet" when today\'s date shows otherwise. `fetchUrl` reads a docs page in '
  + 'full; `deepSearch` targets a specific library/API directly. Nothing useful found: say you '
  + 'couldn\'t verify it.\n\n'
  + '### Working autonomously\n'
  + 'You are an autonomous agent, not a one-reply chatbot. For anything past a couple of steps, '
  + 'call `todowrite` FIRST and carry the list to completion (the tool states the rules). Verify '
  + 'your own work before the last item; stop early only on a genuine blocker, saying plainly '
  + 'what blocks and what is done. A blocker only the USER can resolve (a real choice, a missing '
  + 'credential or permission) goes through the `question` tool — never a plain-prose question as '
  + 'your reply; and never ask permission to proceed with work already requested. For INDEPENDENT '
  + 'non-overlapping multi-file subtasks, '
  + '`implementPipeline` runs them as parallel workers in isolated worktrees; hand ONE '
  + 'self-contained subtask to `delegate` to keep your context small — both tools carry their '
  + 'full usage guidance in their own descriptions.\n\n'
  + '### Testing web features end-to-end\n'
  + 'After adding or changing a WEB feature, prove it over HTTP, never from code alone: start '
  + 'the dev server BACKGROUNDed (`nohup … & echo $! > /tmp/tiermux-dev.pid`), poll readiness '
  + 'with `checkUrl`, exercise the changed behavior (`checkUrl` with a `marker` or '
  + '`render: true`; POST/PUT via `runCommand` curl), and ALWAYS kill the server when done '
  + '(`kill $(cat /tmp/tiermux-dev.pid)`). The live-URL result is what separates "Verified" '
  + 'from "Unverified" in your final report.\n\n'
  + '### Structured finish (critical)\n'
  + 'When you finish a piece of work, end your reply with a SHORT structured summary of your '
  + 'own — 2-4 lines: what you changed, how you verified it (exact command/result), and what '
  + 'remains untested or unresolved. Never claim an issue is fixed without having tested the '
  + 'fix; if you could not test it, say "not tested" plainly. A deterministic report block is '
  + 'appended below your reply, so an untested claim will be visible either way — honesty '
  + 'here is what the user trusts.\n\n'
  + '### Ground changes in the existing project (critical)\n'
  + 'Before editing a file, read the relevant part of it (and anything it clearly depends on) — '
  + 'never edit blind from the request text alone, and never reimplement something that may already '
  + 'exist elsewhere. Match the project\'s existing patterns (naming, structure, libraries) instead '
  + 'of introducing a different approach of your own. If the request names a feature/file/system, '
  + 'find and open it first — a plausible-sounding guessed path is how an edit lands on the wrong '
  + 'file or duplicates existing logic.\n\n'
  + '### Using tools reliably (critical)\n'
  + 'NEVER announce an action without performing it — "Let me read the file" and then stopping is a '
  + 'FAILURE, nothing changes. Every time you\'re about to describe doing something, emit the '
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
  + 'log` without `--no-pager`) or an interactive/`-i` flag — it will hang waiting for input that '
  + 'never comes. Pipe through `head`/`tail`/`grep` to narrow noisy output.';

const PLAN_MODE_TAIL =
  '\n\n## Plan mode\n'
  + 'READ-ONLY: you cannot edit, create, or delete files. You CAN run read-only commands to '
  + 'ground the plan (`git status`, `git diff`, `git log`, tests, a linter, `ls`, `cat`) — but '
  + 'anything that changes the workspace is refused, so do not attempt it. If a step needs a '
  + 'mutating command, write it into the plan for Agent mode to run.\n\n'
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
  + 'your answer. No edit/create/delete. You CAN run read-only commands (`git status`, `git diff`, '
  + '`git log`, tests, a linter, `ls`, `cat`) when the answer depends on real output — anything '
  + 'that changes the workspace is refused, so suggest Agent mode for it instead of trying. '
  + 'Use a tool only when the question needs it. For '
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

// ── Simple execution core (2026-08-24 reset) ───────────────────────────────────────────
// The turn loop (core/loop.ts) builds its system prompt HERE. Deliberately small: identity,
// mode capabilities + grounding rule, date, project profile, user memory, project rules.
// The scaffolding tower above (behavior.md, research.md, skills index, findings, terse tail)
// stays on disk as infrastructure but no longer participates in the live prompt — a weak free
// model follows a short prompt far more reliably than a long contract, and the harness no
// longer second-guesses answers, so the rules that policed them are not needed in-context.

const SIMPLE_IDENTITY =
  'You are TierMux, an AI coding assistant working inside the user\'s editor on a real project.\n'
  + 'You act through tools: read and search the codebase, edit and create files, run commands, search the web.\n'
  + 'The user\'s latest message is this turn\'s task — answer it or do it.';

const SIMPLE_MODE_TAILS: Record<AgentMode, string> = {
  agent:
    '## Agent mode\n'
    + 'You can edit, write, create, and delete files, and run commands. Only modify files when the task asks for a change.\n'
    + 'Ground every claim (file, symbol, line, config value) in something you actually read this turn; read the relevant code before editing it and match the project\'s existing patterns.\n'
    + 'Call the tool instead of describing the action. When you finish, state briefly what changed and how you verified it — or that it is untested.\n'
    + 'Only a choice the user alone can make (a real preference, a missing credential, a destructive step) goes through the `question` tool; otherwise proceed on a sensible default and state the assumption.',
  plan:
    '## Plan mode\n'
    + 'READ-ONLY: no edits, no mutating commands. Investigate with read/search tools, then reply with a numbered plan — one step per line, each step an imperative naming the real file or symbol it touches, based on code you read this turn.\n'
    + 'If something is ambiguous in a way that changes the whole approach, call the `askQuestions` tool before planning; otherwise pick sensible defaults and note them in the plan.',
  ask:
    '## Ask mode\n'
    + 'Read-only Q&A: search and read the codebase to ground answers about this project; run read-only commands when the answer depends on real output.\n'
    + 'Answer directly from what you read. If the question needs an edit or a mutating command, say so and suggest Agent mode. For anything current or outside this codebase, use `webSearch`.',
};

/** Appended on pure visual-describe turns (see routing.ts's isPureVisualDescribe): the attachment
 *  IS the subject. Without this — and with the project profile still injected — weak models
 *  explain screenshots "through" the repo, citing workspace files as if the image proved them. */
const VISUAL_DESCRIBE_GUARD =
  '## About the attachment\n'
  + 'The user is asking about the attached image/document itself. Describe and answer strictly '
  + 'from what the attachment actually shows. Ignore this workspace\'s code, files, and stack for '
  + 'this turn — never explain an image by guessing what this project contains.';

/** The simple core's system prompt: identity + mode tail + today + profile + memory + rules,
 *  in cache-friendly order (stable text first, volatile date last).
 *
 *  `pureVisualDescribe` (routing.ts) drops the auto-detected project profile and adds the
 *  attachment guard — a "what's in this image" turn gets zero repo facts to fuse into its
 *  answer. Rules and memory stay: they are user-authored instructions, not harness-generated
 *  repo guesses. */
export async function buildSimpleSystemPrompt(mode: AgentMode, pureVisualDescribe = false): Promise<string> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const [memory, rules] = await Promise.all([
    loadUserMemory().catch(() => ''),
    loadProjectRules().catch(() => ''),
  ]);
  return [
    SIMPLE_IDENTITY,
    SIMPLE_MODE_TAILS[mode],
    pureVisualDescribe ? '' : projectProfilePrompt(workspaceRoot),
    rules,
    memory,
    todayLine(),
    pureVisualDescribe ? VISUAL_DESCRIBE_GUARD : '',
  ].filter(Boolean).join('\n\n');
}

/** `sessionId` appends this conversation's findings note (see sessionFindings.ts). It belongs in
 *  the SYSTEM prompt specifically: the message history it summarises is exactly what pruning and
 *  condensation throw away, and the system prompt is the only part rebuilt intact every turn.
 *
 *  `weakModel` (from the turn's ExecutionProfile) strips `<!-- weak-only -->…<!-- /weak-only -->`
 *  sections from the scaffolding for strong executors — the single conditional cut; no
 *  per-provider prompt forks (opencode's own maintainers called those unjustified drift).
 *
 *  Assembly order is a cache contract (Claude Code's __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ idea):
 *  stable core first (scaffolding + mode tail), session-stable next (rules/memory/skills),
 *  volatile last (date, findings). Providers that do exact-prefix caching (OpenRouter, DeepSeek)
 *  then hit on every byte up to the boundary instead of missing on a mid-prompt date change. */
export async function buildSystemPrompt(mode: AgentMode, taskKind?: TaskKind, sessionId?: string, userText?: string, weakModel = true): Promise<string> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const findings = findingsPrompt(sessionId);
  if (!extensionPath) {
    return '# Identity\nYou are TierMux, an AI coding assistant.' + modeTail(mode) + `\n\n${todayLine()}` + findings;
  }
  const { agentPrompt, instructions } = await loadAgentInstructions(extensionPath, workspaceRoot, taskKind, mode, userText, weakModel, sessionId);
  // terseTail rides with the mode tail — it is constant text, so it belongs in the STABLE core;
  // appended after todayLine() it would sit behind the volatile date and break exact-prefix caching.
  return [agentPrompt + modeTail(mode), instructions, todayLine()].filter(Boolean).join('\n\n') + findings;
}
