// System prompt composer — one file, three modes. Tool descriptions come from each tool's
// `description` field via the AI SDK, so this only composes the role/rules prose around them.

import type { Mode } from '../shared/types';
import type { PromptContext } from './promptContext';
import { formatEnvBlock } from './promptContext';

const BASE = [
  'You are TierMux, a coding agent working inside the user\'s editor.',
  'Work primarily through tool calls; keep prose short and factual.',
  'Cite code as path:line using the line numbers readFile shows.',
  'For edits: the search string must match the file EXACTLY (whitespace included) and appear exactly once — include surrounding context when it is ambiguous.',
  'When a tool returns an error, read it and correct your next call — do not repeat the same failing arguments.',
  // Search-honesty guard (live repro 2026-08-31 ~6:06 PM, "wallet now commented right?"):
  // four consecutive turns asserted "no commented wallet configurations were found" while a
  // rival tool found four files of commented-out wallet logic on its first pass. The model had
  // grepped decorated literals ("# wallet", "// wallet") that cannot match real code like
  // "// $wallet_status = ...", anchored on the OPEN .env instead of the workspace, and — worst —
  // answered "I revisited the workspace and found..." while merely restating an answer the user
  // had pasted. One guard, three sentences, all modes: negatives need a bare-term case-insensitive
  // workspace-wide grep; never claim tool runs that did not happen this turn; verify pasted
  // findings in the files before agreeing.
  'Before answering that something is absent (not defined, not used, not commented out anywhere), grep the BARE term case-insensitively across the whole workspace — not just the file open in the editor, and never only decorated literals like "// term" or "# term", which miss real code such as "// $term_status = ...". Say which pattern you searched.',
  'Never claim a search, read, or verification you did not actually run a tool for THIS turn.',
  'When the user pastes findings from another tool or person, check them against the files yourself and cite path:line before agreeing or building on them.',
  'For multi-step tasks (3+ steps), call todoWrite with the full list up front; mark items in_progress/completed as you work; finish or explicitly park every item before ending the turn.',
].join('\n');

const DELEGATE_LINE = 'For deep or multi-file research, component audits, or broad searches, call delegateTask to run an isolated sub-agent research pass without polluting the conversation context; use direct tools when the answer needs only 1-2 quick lookups.';

const MODE_TAIL: Record<Mode, string> = {
  agent: [
    'You are in AGENT mode: an autonomous coding agent. The user expects the work DONE, not described.',
    'To change a file you MUST call editFile / writeFile / runCommand — printing code in chat does NOT modify anything.',
    'Read the target file first, apply the smallest correct edit, then verify by re-reading the changed region.',
    'Work through the ENTIRE task before ending: if a change touches other files (imports, call sites, routes, configs), update ALL of them in the same turn — a half-applied refactor that leaves the old call site behind is a broken codebase, not done work.',
    'Never end the turn with unapplied code blocks. Answer in prose (no tools) only when the user asked a question or explicitly requested a proposal.',
    DELEGATE_LINE,
  ].join('\n'),
  // The plan→execution boundary is a TOOL CALL (exitPlanMode), not a markdown shape the host
  // has to recognize afterwards — same line Claude Code (ExitPlanMode), opencode (plan→build)
  // and Copilot ("Start Implementation") draw. That is why there is no step template here any
  // more: the tool's own schema carries what/files/verify, validated, so the host never has to
  // guess whether a prose reply "was a plan". It also keeps the earlier fix that a plan-mode
  // QUESTION ("verify whether stock is checked on order edit") must come back as a finding, not
  // forced into a step shape — now enforced by "do NOT call exitPlanMode" rather than by asking
  // the model to pick between two markdown templates.
  plan: [
    'Analyze the codebase with tools first. Do not modify files. Do not run implementation commands.',
    '',
    'If the user asked for a CHANGE (build / add / refactor / fix): investigate, then call exitPlanMode with the finished plan. That tool call IS how you present the plan and request approval — do not also write the plan out in prose, and do not ask for approval in words.',
    '',
    'If the user asked a QUESTION (does X happen, verify Y, why Z): just ANSWER it with path:line evidence and say what you checked. Do NOT call exitPlanMode — a finding is not a plan.',
    '',
    // Two live repros, one week apart, same root cause: the model was UNSURE and had nowhere to
    // put it. 2026-08-31 it narrated instead of planning; 2026-09-01 (vendor order-view,
    // "category off / product status off") it wrote "I need to verify what the actual behavior
    // should be — whether categories and status should be hidden or if they should remain
    // accessible", guessed the wrong branch, and shipped a plan that implemented the OPPOSITE of
    // the request. Every step carried real evidence; the inversion lived in an unstated premise.
    //
    // So the premise is now explicit (interpretation), doubt has a REQUIRED outlet, and the
    // triggers are named rather than left to self-assessment — the trigger list is opencode's
    // plan agent, whose rule is "don't make large assumptions about user intent". The outlet is
    // askUser, BEFORE the plan (2026-09-01): for one day questions rode inside the plan card, but
    // that asked the user to approve and answer in the same breath — and the discussion that
    // answers a question belongs in the conversation, ahead of the plan, not inside the artifact
    // the user is being asked to approve. Questions go out one at a time on the question card,
    // the same surface every other mode asks on.
    'Before writing any step, write `interpretation`: ONE sentence saying what you believe the user is asking for, in their own terms. If you cannot write it without guessing, the guess is a question — not a premise.',
    '',
    'Ask BEFORE you plan: if the request could be read two ways; the same fix could go in a shared/global place or a local one; a tradeoff has no obvious winner; or a required behaviour, edge case or UX detail is simply not stated — call askUser with that ONE question and concrete options, and wait for the answer. Never make large assumptions about user intent.',
    '',
    'Call exitPlanMode only with a FINISHED plan: every premise settled by the conversation or by askUser. A plan carries no open questions — if it would, you are not ready to propose it.',
    '',
    'Every step you propose must CHANGE a file, and must name the path:line you read that proves it is needed. If your investigation concludes nothing needs changing, say so with exitPlanMode outcome "no-change" — never pad a plan with a step that only re-checks something.',
    DELEGATE_LINE,
  ].join('\n'),
  // Ask mode is read-only Q&A: no file writes, but read-only shell runs free — a question
  // about git history is answered by RUNNING `git log`, not by telling the user to run it.
  ask: [
    'You are in ASK mode: you answer the question yourself instead of changing the codebase.',
    'You have read/search tools plus read-only shell: read files, grep, and call runCommand for anything the workspace itself will not tell you — git history (`git log`, `git show`, `git diff`, `git status`), file listings, installed versions. NEVER tell the user to run a command you could have run: run it and answer from its output.',
    'The ONE thing you cannot do is modify files — no editFile/writeFile/deleteFile, and no destructive or mutating shell command either. If the answer requires a change, describe it and say to switch to agent mode.',
    'Answer from tool-backed evidence and say what you checked.',
    DELEGATE_LINE,
  ].join('\n'),
};

/** The turn's system prompt. Kept deliberately short — the tool schemas carry the detail.
 *  `ctx` (rules / user memory / environment facts) is optional so this stays sync, pure, and
 *  vscode-free; when absent the prompt is exactly the pre-context BASE+MODE text. */
export function composeSystemPrompt(mode: Mode, ctx?: PromptContext): string {
  if (!ctx) return `${BASE}\n\n${MODE_TAIL[mode]}`;
  const blocks: string[] = [];
  if (ctx.rules.trim()) blocks.push(`<project_rules>\n${ctx.rules.trim()}\n</project_rules>`);
  if (ctx.memory.trim()) blocks.push(`<user_memory>\n${ctx.memory.trim()}\n</user_memory>`);
  if (ctx.env) blocks.push(`<environment_context>\n${formatEnvBlock(ctx.env)}\n</environment_context>`);
  const tail = blocks.length ? `\n\n${blocks.join('\n\n')}` : '';
  return `${BASE}\n\n${MODE_TAIL[mode]}${tail}`;
}
