

// The agent turn: thin streamText() wiring, not a hand-rolled loop. Consumes the SDK's own
// stream directly (verified empirically to carry text-delta/reasoning-delta/tool-call/
// tool-result/tool-error/tool-approval-* parts in the expected order — see the plan's spike
// notes) and maps them onto the existing AgentOpts callbacks. No custom iteration, no custom
// permission gate, no custom hook system.
import { streamText, generateText, wrapLanguageModel, isStepCount, pruneMessages, generateObject, NoSuchToolError, InvalidToolInputError, ToolCallRepairError } from 'ai';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { Router } from '../../router/router';
import type { ChatMessage, ChatContentBlock } from '../../shared/types';
import type { AgentOpts, AgentResult } from '../agent';
import { classifyTaskCore, attachmentKindsFromContent, type TaskKind, type ClassifySignals } from '../routing';
import { assessAnswerQuality, TASK_WORD_FLOOR } from '../answerQuality';
import { judgeFulfillment, compareAnswers, JUDGEABLE_TASK_KINDS } from '../fulfillment';
import { contentToString } from '../content';
import { buildSystemPrompt } from '../promptBuilder';
import { recordFindings } from '../sessionFindings';
import { createRouterProvider } from './routerProvider';
import { createTelemetryMiddleware } from './middleware/telemetry';
import { createToolApproval, MUTATING_TOOLS } from './policies/permission';
import { createToolSet } from './tools';
import { getMcpManager } from './tools/mcp/manager';
import { NEW_DIAGNOSTICS_MARKER, waitForWorkspaceDiagnosticsSettled, workspaceErrorSignatures, newErrorsSince } from './tools/workspace/formatDiagnostics';
import { resolveVerifyCommand, runVerifyCommand } from './tools/workspace/verifyCommand';
import { resolveWorkspacePath } from './tools/resolvePath';
import { AnchorStore, stripAnchorBlock, renderTouchedFiles } from './anchors';
import { planStepsToTodos } from '../../session/titles';
import { stepDifficultyOf, type StepDifficulty } from '../stepDifficulty';
import { diagLog } from '../../util/diag';
import { repairToolArguments, sanitizeToolName } from '../toolArgs';
import type { ClarifyingQuestion } from '../clarify';

/** AI SDK ModelMessage shape (loosely typed here — the SDK validates the real shape). */
type CoreMessage = { role: string; content: unknown };

/** Converts one TierMux content block to an AI SDK FilePart — used for both `image_url` and
 *  `file` blocks (ImagePart is deprecated in favor of FilePart with mediaType: 'image'). Content
 *  blocks the SDK doesn't need a part for (plain text) are handled by the caller. */
function toFilePart(block: Extract<ChatContentBlock, object>): { type: 'file'; data: string; mediaType: string; filename?: string } | undefined {
  if (block.type === 'image_url' && typeof block.image_url === 'object' && block.image_url) {
    const img = block.image_url as { url?: string; mime?: string; filename?: string };
    if (typeof img.url === 'string') return { type: 'file', data: img.url, mediaType: img.mime || 'image/png', filename: img.filename };
  }
  if (block.type === 'file' && typeof block.file === 'object' && block.file) {
    const f = block.file as { file_data?: string; mime?: string; filename?: string };
    if (typeof f.file_data === 'string') return { type: 'file', data: f.file_data, mediaType: f.mime || 'application/octet-stream', filename: f.filename };
  }
  return undefined;
}

/** Converts a user message's content (string, or a mixed text+attachment block array) into AI
 *  SDK's multi-part user content shape, preserving image/file blocks — flattening to text alone
 *  (as `contentToString` does) would silently drop attachments, exactly the bug class OC's own
 *  "vision reinjection" workaround existed to paper over for its lossy re-serialization. */
function toUserContent(content: ChatMessage['content']): unknown {
  if (typeof content === 'string' || content == null) return contentToString(content);
  const parts: unknown[] = [];
  let fileCount = 0;
  for (const block of content) {
    if (typeof block === 'string') { if (block) parts.push({ type: 'text', text: block }); continue; }
    const filePart = toFilePart(block);
    if (filePart) { parts.push(filePart); fileCount++; continue; }
    if (typeof block.text === 'string' && block.text) parts.push({ type: 'text', text: block.text });
  }
  diagLog('attach.toUserContent', `inputBlocks=${content.length} outParts=${parts.length} fileParts=${fileCount}`);
  return parts.length ? parts : contentToString(content);
}

/** True only for a genuine cancellation/abort — NOT for provider or validation errors
 *  that happen to coincide with an aborted signal. Used by the catch in runTurn so a
 *  real failure surfaces instead of vanishing as a silent empty turn. */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  const code = (err as { code?: unknown })?.code;
  return code === 'aborted' || code === 20 /* DOMException.ABORT_ERR */ || /abort/i.test((err as { message?: string })?.message ?? '');
}

function toCoreMessages(messages: ChatMessage[]): CoreMessage[] {
  const toolNameByCallId = new Map<string, string>();
  for (const m of messages) for (const tc of m.tool_calls ?? []) toolNameByCallId.set(tc.id, tc.function.name);

  const mapped = messages.map((m): CoreMessage => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const parts: unknown[] = [];
      const text = contentToString(m.content);
      if (text) parts.push({ type: 'text', text });
      for (const tc of m.tool_calls) {
        let input: unknown = {};
        try { input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { /* leave empty */ }
        parts.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, input });
      }
      return { role: 'assistant', content: parts };
    }
    if (m.role === 'tool') {
      const toolName = m.name ?? toolNameByCallId.get(m.tool_call_id ?? '') ?? 'tool';
      return { role: 'tool', content: [{ type: 'tool-result', toolCallId: m.tool_call_id ?? '', toolName, output: { type: 'text', value: contentToString(m.content) } }] };
    }
    if (m.role === 'user') {
      return { role: 'user', content: toUserContent(m.content) };
    }
    return { role: m.role, content: contentToString(m.content) };
  });
  return sanitizeCoreMessages(mapped);
}

/** Enforce the AI SDK's history invariant: every assistant `tool-call` part MUST have a
 *  matching `tool-result`, and every `tool` message MUST reference a preceding tool-call.
 *  History persisted from an interrupted/paused/condensed turn can violate this — e.g. an
 *  assistant `tool_calls` entry whose run was cut before any tool result came back. The SDK
 *  throws on such input, which (via the abort path) surfaced as a silent "0 in / 0 out"
 *  turn on every secondary send. Repair by dropping orphaned tool-call parts and lone tool
 *  messages so streamText always gets well-formed input. */
function sanitizeCoreMessages(msgs: CoreMessage[]): CoreMessage[] {
  // Pass 1: collect every toolCallId that HAS a result somewhere in the history.
  const idsWithResult = new Set<string>();
  for (const m of msgs) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const p of m.content as Array<{ type?: string; toolCallId?: unknown }>) {
      if (p?.type === 'tool-result' && typeof p.toolCallId === 'string') idsWithResult.add(p.toolCallId);
    }
  }
  // Pass 2: drop orphan tool-call parts (and lone tool messages), removing any assistant
  // message left empty as a result. `seenCalls` tracks ids actually emitted so a tool message
  // with no preceding call is dropped too.
  const seenCalls = new Set<string>();
  const out: CoreMessage[] = [];
  for (const m of msgs) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const filtered = (m.content as Array<{ type?: string; toolCallId?: string; text?: string }>)
        .filter((p) => {
          if (p?.type !== 'tool-call') return true;
          if (!idsWithResult.has(p.toolCallId ?? '')) return false; // orphan — no result anywhere
          seenCalls.add(p.toolCallId ?? '');
          return true;
        });
      if (filtered.length === 0) continue; // assistant msg became empty — drop it
      out.push({ role: 'assistant', content: filtered });
      continue;
    }
    if (m.role === 'tool' && Array.isArray(m.content)) {
      const filtered = (m.content as Array<{ type?: string; toolCallId?: string }>)
        .filter((p) => p?.type === 'tool-result' && seenCalls.has(p.toolCallId ?? ''));
      if (filtered.length === 0) continue; // result for a call we dropped above
      out.push({ role: 'tool', content: filtered });
      continue;
    }
    out.push(m);
  }
  return out;
}

/** Rough token estimate (~4 chars/token) over the SDK's running message array — used only to
 *  decide WHEN to prune, so a cheap char count is fine. Mirrors budget.ts's estimator. */
function roughTokens(messages: CoreMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    const c = m.content;
    if (typeof c === 'string') chars += c.length;
    else if (Array.isArray(c)) for (const p of c) chars += JSON.stringify(p).length;
  }
  return Math.ceil(chars / 4);
}

/** System-prompt tail for the forced synthesis turn — tells the model the tool work is done and
 *  it must now answer the user in plain language. */
const SYNTH_SUFFIX =
  '\n\nYou have finished using tools. Using ONLY what you learned from the tool results above, '
  + 'write your final answer to the user now — clear, plain language, no tool calls, no '
  + '<function=…>/<tool_call> syntax of any kind. Summarize what you did and what you found, and '
  + 'directly address the user\'s original request.';

/** System-prompt tail used instead of SYNTH_SUFFIX when the turn ended via stuckStop/budgetStop
 *  (loop.ts's stopReason) rather than finishing naturally — the model did NOT complete the task,
 *  so asking it to "give your final answer" would read as false completion. Ask for a progress
 *  report instead: what it found/concluded, and what's still unresolved. */
const SYNTH_SUFFIX_STUCK =
  '\n\nYou were stopped before finishing — you got stuck repeating the same action without making '
  + 'progress. Using ONLY what you learned from the tool results above, tell the user what you '
  + 'found/concluded so far and what is still unresolved. Do NOT claim the task is complete — this '
  + 'is a progress report, not a final answer. Do NOT call a tool or emit tool-call syntax of any '
  + 'kind (no <function=…>, no <tool_call>, no JSON action blob) — you no longer have tools '
  + 'available in this step; write prose only.';

/** A reply that ENDS on an announced action ("…let me read the file and fix it:") — a weak model's
 *  classic "all talk, no action" turn. Matched only at the tail so a genuine explanation that
 *  merely mentions an action mid-text doesn't trip it. Combined with hadToolCalls===false in
 *  runTurn to detect a turn that promised work but called no tool. */
const ACTION_INTENT_RE = /\b(let me|i'?ll|i will|let'?s|i'?m going to|now i'?ll|i can|i'?d|i should|let me go ahead and)\b[^.!?\n]*\b(read|open|look at|inspect|examine|check|review|fix|edit|update|change|modify|rewrite|replace|implement|create|add|remove|delete|run|execute|search|grep|find|explore|apply|write)\b[^.!?\n]*[:.]?\s*$/i;

/** A DIFFERENT "all talk, no action" shape than ACTION_INTENT_RE: instead of announcing an action
 *  and stopping, the model explains what to change and pastes the fix as a fenced code block —
 *  e.g. "here's the updated code snippet:" + ```php ... ``` — as if showing the diff in chat WERE
 *  the action. Reproduced from real free-model runs (Mistral/GLM) that never called `editFile` at
 *  all. Deliberately just "did it emit at least one fenced code block" — with hadToolCalls===false
 *  already required by the caller, a fenced block in an action task kind is the signal; requiring
 *  a specific announcing phrase (like ACTION_INTENT_RE) would miss the exact cases this exists
 *  for, since these replies often open with "To do X, you need to..." rather than "let me...". */
const CODE_FENCE_RE = /```[\s\S]*?```/;

/** A THIRD "all talk, no action" shape: the model works out exactly what needs doing, lists the
 *  steps, then ENDS by asking permission to start ("Do you want me to proceed with these steps?")
 *  — having called no tool at all. Captured from a real 2026-08-13 Gemini run that listed
 *  "locate the route files / verify closure routes" and then stopped.
 *
 *  No existing detector caught it: ACTION_INTENT_RE is tail-anchored on an action VERB so a
 *  trailing question misses; CODE_FENCE_RE needs a fenced block; and answerQuality's
 *  DEFLECTION_PHRASE is capped at DEFLECTION_MAX_WORDS (40) so a long, well-structured reply is
 *  excluded before its regex even runs — and "want me to proceed" isn't in that phrase list.
 *
 *  Matched only against the TAIL (see the caller) so a long report that merely poses a question
 *  mid-text doesn't trip it — the signal is specifically "the LAST thing it did was ask instead
 *  of act". Agent mode has `askQuestions` for genuinely blocking ambiguity, and behavior.md
 *  already tells the model to act directly, so this shape is a failure, not a clarification. */
const ASKS_PERMISSION_RE = /\b(do you want me to|would you like me to|shall i|should i (?:go ahead|proceed|start)|do you want (?:me )?to proceed|let me know if you(?:'d| would)? (?:like|want)|want me to (?:proceed|continue|start|go ahead))\b[^?]{0,160}\?\s*$/i;

/** Nudge appended (as a user turn) when a model announced an action but called no tool. Pushes the
 *  SAME model to actually invoke the tool this time instead of re-describing the plan. */
const FORCE_ACTION_NUDGE =
  'You described what you would do but did NOT use any tool — no file was read or changed, so '
  + 'nothing actually happened. Do it now: call the appropriate tool to perform the action. Do not '
  + 'just describe what you will do — actually do it.\n\n'
  + 'If you cannot emit a native tool call, emit it as text in EXACTLY this format (a real call '
  + 'will run from it): <function=TOOL_NAME>{"arg": "value"}</function> — for example '
  + '<function=readFile>{"path": "routes/web.php"}</function>. Put the tag on its own line, not in '
  + 'backticks, using the real tool name and JSON arguments. Emit the call now, then wait for the result.';

/** Nudge appended (as a user turn) when the model already did real work this turn (tool calls ran)
 *  but then ENDED on an announced-but-undone next action ("Let me check the workspace structure
 *  first.") — a continuation of the announcedNoAction failure that the zero-tool gate on
 *  FORCE_ACTION_NUDGE's path can't reach. Unlike FORCE_ACTION_NUDGE this must NOT claim "nothing
 *  happened", because the turn's workMessages show real prior work; it only pushes the model to
 *  perform the ONE action it just announced. */
const FORCE_CONTINUE_ACTION_NUDGE =
  'Your last message announced what you would do next, but the turn ended there — you did NOT '
  + 'actually perform that next action. Continue now: call the appropriate tool to perform the '
  + 'action you just described. Do not just describe what you will do — actually do it, then wait '
  + 'for the result.\n\n'
  + 'If you cannot emit a native tool call, emit it as text in EXACTLY this format (a real call '
  + 'will run from it): <function=TOOL_NAME>{"arg": "value"}</function> — for example '
  + '<function=listDir>{"path": "."}</function>. Put the tag on its own line, not in backticks, '
  + 'using the real tool name and JSON arguments.';

/** Nudge appended (as a user turn) when a tool call died with `toolCallRepairFailed` — repair
 *  exhausted and the model never actually saw why, since an unrepaired InvalidToolInputError
 *  surfaces as a stream `error` part, not a `tool-error` part the model gets in its context (see
 *  createRepairToolCall's doc comment). `detail` is the raw SDK error message — genuinely useful
 *  to the model here (it names the offending tool/field), unlike showing it to the user raw. */
function forceToolRepairNudge(detail: string): string {
  return 'Your last tool call failed and could not be automatically repaired:\n\n'
    + `${detail}\n\n`
    + 'Common causes: a JSON array/object argument was sent as an escaped STRING instead of a real '
    + 'array/object, or an argument name that does not exist in the tool\'s schema. Call the SAME '
    + 'tool again with corrected arguments — do not repeat the same malformed call.';
}

/** Nudge appended (as a user turn) when the model answered an action task by PASTING the code in
 *  its reply (a fenced block) instead of creating/editing the file — so no project file actually
 *  changed. The most common "all talk, no action" shape on weaker models: it reads the project,
 *  then "helpfully" writes the solution out as text. Pushes it to call createFile/editFile with the
 *  exact content. Continues from the turn's transcript (reads already happened), so it must NOT
 *  claim "nothing happened" — reads did; only the write is missing. */
const FORCE_PASTE_TO_ACTION_NUDGE =
  'You wrote out the code in your reply but did NOT create or edit the file — no writeFile or '
  + 'editFile tool ran, so nothing in the project actually changed. Implement it now: call '
  + 'createFile (for a new file) or editFile (to change an existing one) with the exact content '
  + 'you just wrote. Do not paste the code again as text — write it to the file with the tool, '
  + 'then confirm it is done.\n\n'
  + 'If you cannot emit a native tool call, emit it as text in EXACTLY this format (a real call '
  + 'will run from it): <function=TOOL_NAME>{"arg": "value"}</function> — for example '
  + '<function=createFile>{"path": "resources/views/landing.blade.php", "content": "..."}</function>. '
  + 'Put the tag on its own line, not in backticks, using the real tool name and JSON arguments.';

/** A model declined to look something up and pointed the user elsewhere ("switch to a mode that
 *  can search the web", "I don't have real-time access", "check FIFA's official site") instead of
 *  calling the `webSearch`/`fetchUrl` tool it was actually given. Unlike ACTION_INTENT_RE this
 *  fires for ANY taskKind — a plain chat question is exactly where this happens, since the
 *  force-action retry below is normally restricted to agent/coding/debug/longContext. */
const DECLINED_WEBSEARCH_RE = /\b(switch(?:ing)? to (?:a |another )?mode|i (?:don'?t|do not) have (?:access to (?:the )?(?:internet|real-?time|live)|real-?time access|the ability to (?:browse|search))|cannot (?:browse|access) the (?:internet|web)|no internet access|(?:look|search) (?:it |this )?up (?:on|via|using) (?:the )?(?:internet|web|external sources?|a search engine)|external sources? (?:like|such as)|can'?t (?:browse|search) the web|unable to (?:browse|search) the (?:internet|web))\b/i;

const FORCE_WEBSEARCH_NUDGE =
  'You said you cannot look this up, but you DO have a `webSearch` tool available — use it now '
  + 'instead of telling the user to switch modes or check an external site themselves. Call '
  + '`webSearch` with a query for what was asked, then answer from the results.\n\n'
  + 'If you cannot emit a native tool call, emit it as text in EXACTLY this format (a real call '
  + 'will run from it): <function=webSearch>{"query": "..."}</function>. Put the tag on its own '
  + 'line, not in backticks. Emit the call now, then wait for the result.';

/** Confident fast-path: common phrasings of "I have no execution/runtime capability" that a
 *  model states flatly, with zero tool calls, despite Agent mode having a real runCommand tool.
 *  [\s\S]{0,100} (not [^.!?\n]*) deliberately spans sentence boundaries — a real reply like
 *  "I cannot run this request. I have no access to the test suite." is two sentences but one
 *  decline; a sentence-bounded gap would miss it and fall through to the (still-correct, just
 *  more expensive) LLM path every time. Bounded to 100 chars so it can't runaway-match across an
 *  entire long reply. */
const NO_RUNTIME_ACCESS_RE =
  /\b(i (?:cannot|can'?t|am unable to|don'?t have (?:the )?ability to)|there'?s no|no access to)\b[\s\S]{0,100}\b(run|execute|access)\b[\s\S]{0,100}\b(tests?|runtime|environment|test suite|database|code)\b/i;

/** Loose pre-filter: decline-shaped language. Gates the LLM classify call below so it never
 *  fires on an ordinary no-tool-call reply (e.g. a plain chat answer) — only on text that already
 *  smells like a capability claim, mirroring classifyTaskCore's "confident vs ambiguous" split. */
const MAYBE_CAPABILITY_DECLINE_RE = /\b(cannot|can'?t|unable|don'?t have|no access|not able)\b/i;

/** Regex-first, LLM-classify-fallback for a false "I have no execution capability" decline —
 *  same shape as classifyTaskSmart (task-kind routing, above) and tryModelRepair's Tier 3 (tool-
 *  call repair): a cheap regex catches the common phrasings for free; anything decline-shaped but
 *  not a confident regex match escalates to one cheap classify call for genuine semantic
 *  judgment on the paraphrases a regex can't enumerate. Never blocks the turn — any failure
 *  (timeout/abort/parse) degrades to `false` (no retry), same discipline as tryModelRepair's
 *  `catch { return null }`. Exported so scripts/falseCapabilityDecline.e2e.ts can unit-test it
 *  directly, bypassing the full runTurn() pipeline (found unreliable for triggering classify-
 *  style calls through a fake-Router harness — see repairToolCallTier3.e2e.ts's own history). */
export async function detectFalseCapabilityDecline(router: Router, text: string, abortSignal?: AbortSignal): Promise<boolean> {
  if (NO_RUNTIME_ACCESS_RE.test(text)) return true;
  if (!MAYBE_CAPABILITY_DECLINE_RE.test(text)) return false; // not decline-shaped — skip the call entirely
  try {
    const provider = createRouterProvider(router, { taskKind: 'trivial' });
    const timeout = AbortSignal.timeout(4000);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
    const { object } = await generateObject({
      model: provider,
      output: 'enum',
      enum: ['false_decline', 'other'],
      abortSignal: signal,
      prompt: 'An AI coding assistant that HAS a real tool to run shell commands/tests just replied '
        + 'without calling it. Does this reply falsely claim it lacks the ability to run commands/'
        + 'tests/code, when it actually has that capability? Reply "false_decline" if so, "other" if '
        + 'it is declining for a different valid reason (missing info, genuinely ambiguous request) '
        + 'or not declining at all.\n\nReply:\n"""' + text.slice(0, 1500) + '"""',
    });
    return object === 'false_decline';
  } catch {
    return false;
  }
}

const FORCE_RUNTIME_ACCESS_NUDGE =
  'You DO have a `runCommand` tool available right now in this session — call it to actually run '
  + 'the command/tests. Do not claim you lack execution access. If you cannot emit a native tool '
  + 'call, emit it as text in EXACTLY this format: <function=runCommand>{"command": "..."}</function>. '
  + 'Put the tag on its own line, not in backticks. Emit the call now, then wait for the result.';

/** Nudge appended (as a user turn) when an edit/write tool call's own verifyNoteFor check found a
 *  NEW diagnostic error right after the edit (Ralph-Wiggum-style self-correct). The diagnostic
 *  text is already in context (it's part of the tool result in workMessages) — this just tells
 *  the model to act on it instead of finishing with a broken file. */
const SELF_CORRECT_NUDGE =
  'The edit you just made introduced a new error, reported above in the tool result. Fix it now: '
  + 'read the surrounding code if you need to, then correct the error with another edit before '
  + 'finishing. Do not just acknowledge the error — actually fix it.';

/** Nudge for the end-of-turn command gate: the turn's edits were checked by ACTUALLY RUNNING the
 *  project's verify command (the planner's `Verify:` pick or auto-detected from the manifest) and
 *  it exited non-zero. The failing output is appended to this nudge by the caller. Same shape as
 *  SELF_CORRECT_NUDGE but the evidence is an observed command result, not LSP diagnostics — the
 *  strongest falsifier the loop has. */
const VERIFY_FAILED_NUDGE =
  'Your changes were verified by actually running the project\'s verify command, and it FAILED '
  + '(output below). Fix the actual cause of the failure now — read the failing file or test if '
  + 'you need to, make the edit, and make the command pass. Do not just acknowledge the failure: '
  + 'the turn is not complete while the verify command still exits non-zero.';

/** Tools that can actually falsify a "it's fixed" claim: they execute or re-inspect the code
 *  rather than restating it. `readFile` is deliberately NOT here — re-reading your own edit
 *  confirms the text landed, not that the bug is gone. */
const VERIFY_TOOLS = new Set(['runCommand', 'getDiagnostics']);

/** Mutating tools that ALREADY run a diagnostics check as part of their own execute() —
 *  verifyNoteFor (src/agent/core/tools/workspace/formatDiagnostics.ts) is baked into
 *  writeFile/createFile/editFile unconditionally, success or not. Before this existed, the
 *  Unverified badge fired on every clean edit that didn't ALSO get a separate top-level
 *  getDiagnostics/runCommand call — which is most single-edit turns — training users to ignore a
 *  warning that was often wrong, exactly the alarm-fatigue failure mode a trust-signal cannot
 *  afford. A successful ('tool-result', not 'tool-error') call to one of these IS the check; no
 *  extra step should be required to prove it happened. `deleteFile` (nothing left to lint) and
 *  `runCommand` (a shell command claiming a fix genuinely needs external verification, e.g. a
 *  test run) are deliberately excluded — they still require a real VERIFY_TOOLS call. */
const SELF_VERIFYING_TOOLS = new Set(['writeFile', 'createFile', 'editFile']);

/** Tools whose `path` argument names a workspace file the agent has genuinely looked at. Kept to
 *  tools that address ONE file: `grep`/`glob` take a directory or pattern, which would poison the
 *  findings note with "already read" entries for files nobody opened. */
const PATH_ARG_TOOLS = new Set(['readFile', 'writeFile', 'createFile', 'editFile', 'getSymbolGraph', 'getDependencyTree']);

/** The `path`-ish argument of a tool call, if it looks like one. Args arrive as `unknown` from
 *  the stream part (and from a weak model, sometimes as a JSON string). */
function pathArgOf(input: unknown): string | undefined {
  let v = input;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return undefined; } }
  if (!v || typeof v !== 'object') return undefined;
  const p = (v as Record<string, unknown>).path ?? (v as Record<string, unknown>).file;
  return typeof p === 'string' && p.trim() ? p.trim() : undefined;
}

/** Flatten the per-attempt changedFiles Map into the AgentResult array shape. Empty → undefined so
 *  a no-op turn carries no field. */
function mapChangedFiles(m: Map<string, 'created' | 'modified' | 'deleted'>): { path: string; status: 'created' | 'modified' | 'deleted' }[] | undefined {
  if (!m.size) return undefined;
  return [...m.entries()].map(([path, status]) => ({ path, status }));
}

/** Merge a retry's changedFiles into the running set. A path created in one attempt then edited in
 *  another stays 'created'; 'deleted' wins over 'modified'. Later status overrides unless it would
 *  downgrade a created→modified (a file created this turn was created, not modified). */
function mergeChangedFiles(a: { path: string; status: 'created' | 'modified' | 'deleted' }[] | undefined, b: { path: string; status: 'created' | 'modified' | 'deleted' }[] | undefined): { path: string; status: 'created' | 'modified' | 'deleted' }[] | undefined {
  if (!a?.length && !b?.length) return undefined;
  const m = new Map<string, 'created' | 'modified' | 'deleted'>();
  const rank = { created: 3, deleted: 2, modified: 1 } as const;
  for (const e of [...(a ?? []), ...(b ?? [])]) {
    const prev = m.get(e.path);
    if (!prev || rank[e.status] >= rank[prev]) m.set(e.path, e.status);
  }
  return [...m.entries()].map(([path, status]) => ({ path, status }));
}

/** Completion claims — a verdict about the user's system ("Fixed.", "Both issues fixed", "should
 *  work now"), as opposed to a description of what changed ("changed the column count to F"). */
const COMPLETION_CLAIM_RE = new RegExp([
  // English
  /\b(?:(?:is|are|now|both|all|issues?|bugs?|problems?)\s+fixed|fixed(?:\s+(?:it|this|that|both|all|the\s+\w+))?\.|resolved|should (?:now )?work|now works?|works? now|that (?:should|will) (?:fix|do) it|problem solved|all set|done\.)/.source,
  // Romanized Bengali, and Bengali script. Without these the badge was English-only, so a reply
  // ending "ঠিক হয়ে গেছে" or "thik kore diyechi" made exactly the unverified claim this guard
  // exists to catch and sailed through untouched — the user this was built for writes that way.
  /\b(?:thik\s*(?:hoye\s*(?:geche|gache)|kore\s*(?:dilam|diyechi|dieche))|hoye\s*geche|kaj\s*kor(?:be|che)\s*ekhon|somossa\s*(?:nei|shesh)|fix\s*kore\s*(?:dilam|diyechi))\b/.source,
  /(?:ঠিক\s*(?:হয়ে\s*গেছে|করে\s*দিয়েছি|করে\s*দিলাম)|সমাধান\s*হয়েছে|কাজ\s*করবে\s*এখন|হয়ে\s*গেছে)/.source,
].join('|'), 'i');

/** Appended verbatim when the model claims a fix it never checked. Deterministic on purpose: the
 *  prompt (behavior.md "Reporting what you changed") already asks for this honesty, and free
 *  models comply unreliably — an unverified "Fixed." that turns out wrong costs the user a round
 *  trip AND their trust, which is exactly the failure this whole path exists to stop. A plain
 *  appended line costs zero extra model calls and zero latency, unlike a retry nudge. */
const UNVERIFIED_CLAIM_CAVEAT =
  '\n\n> ⚠️ **Unverified** — this change was not tested. No command was run and no diagnostics '
  + 'were checked after the last edit, so the claim above is reasoning about the code, not an '
  + 'observed result. Please confirm it actually fixes the problem.';

/** Does the text make CODEBASE-SPECIFIC claims — a workspace-looking path, a backticked
 *  identifier, or a `call()` — as opposed to answering in plain prose? An answer with none of
 *  these asserts nothing about the repo, so having opened no files is not suspicious; an answer
 *  full of them, written without opening anything, is invention. */
const CLAIMS_CODE_IDENTIFIERS = /`[A-Za-z_$][\w$]{2,}`|\b[\w-]+\/[\w-/]+\.[a-zA-Z]{1,5}\b|\b[A-Za-z_$][\w$]{2,}\s*\(\s*\)/;

/** Sent back when an Ask/Plan turn answered about the project without opening anything. Names the
 *  specific failure (answered from memory) and demands ONE tool call, so a weak model has a single
 *  unambiguous next move. */
/** Threshold (fraction of maxTurnTokens) at which the budget-approaching nudge fires — see
 *  prepareStep in runAttempt. 0.65 leaves real room after the nudge for the model to actually
 *  make the edit and get verified, while still firing well before the hard budgetStop cutoff. */
const BUDGET_NUDGE_THRESHOLD = 0.65;

const BUDGET_NUDGE =
  'You are most of the way through your token budget for this turn and have not made any edit '
  + 'yet. Stop investigating now and make the change with the files you have already found — '
  + 'read no more new files. If you genuinely need one more piece of information, get it in your '
  + 'very next tool call and then write the edit.';

/** Threshold (fraction of maxTurnTokens) at which read-only tools are physically removed from
 *  the model's toolset for the rest of the turn — see prepareStep. Comfortably above
 *  BUDGET_NUDGE_THRESHOLD (0.65) so a model that heeded the nudge is never forced; only a model
 *  that ignored it reaches this. */
const BUDGET_FORCE_THRESHOLD = 0.85;

const BUDGET_FORCE_NUDGE =
  'You ignored the earlier warning and kept investigating instead of making the change. Your '
  + 'search/read tools are now DISABLED for the rest of this turn — calling them is no longer '
  + 'possible. Use only what you have already learned: make the edit now with a mutating tool, '
  + 'or if you truly cannot proceed, explain in plain text exactly what is blocking you and stop.';

const FORCE_GROUND_NUDGE =
  'You answered without opening a single file, so that answer came from memory — and you have '
  + 'never seen this codebase before. Anything you named in it (files, functions, constants) is a '
  + 'guess until you verify it.\n\n'
  + 'Do it properly now: make ONE search or read call (grep, glob, getSymbolGraph, readFile, or '
  + 'explore) against this workspace, wait for the result, then continue from what it actually '
  + 'says. Cite `path:line` for each claim. If the answer genuinely needs no project file, say so '
  + 'explicitly in one sentence instead of describing code you did not read.';

/** The user's request asks to PRODUCE something (a file/feature/change), not just discuss it.
 *  Used to detect the "model showed the code in chat but never called writeFile/editFile" failure:
 *  a create/edit task answered with a code block and no tool call means nothing was actually built,
 *  so runTurn escalates to a model that will use the tools. Discussion verbs (explain/review/show)
 *  are deliberately excluded — those legitimately produce text/code without a tool call. */
const CREATE_TASK_RE = /\b(?:make|create|build|write|add|fix|implement|develop|generate|set ?up|put together|scaffold|generate|produce|write me|build me|create me)\b/i;

/** Tool-result pruning policy for `prepareStep` (see its comment below). Split by tool, not one
 *  blanket rule, because the two kinds of tool result age very differently:
 *
 *  - Read-type results are the bloat — a single `readFile` is capped at 30K chars (~7.5K tokens,
 *    capOutput.ts), so two of them alone blow past `pruneAtTokens`. Once the model has used a file
 *    dump it can re-read on demand, so these are evicted aggressively.
 *  - Mutating results are a handful of bytes each ("Edited src/foo.ts.") and ARE the turn's memory
 *    of what it has already done. Blanket-pruning them (the previous behavior) is what made the
 *    agent forget its own edits mid-turn and across turns — so a user correcting the same thing
 *    repeatedly got the same wrong answer back, since the evidence of the earlier attempt was gone
 *    from the model's view. They cost almost nothing to keep, so they are never pruned.
 *
 *  `question`/`todowrite` are kept for the same reason: they record interaction state, not bulk. */
/** Tools whose result is worth retaining for late re-anchoring (anchors.ts): they return the
 *  CONTENT of a specific file, keyed by a `path` argument. Deliberately narrow — `grep`/`glob`
 *  return match lists across many files with no single path to anchor to, and re-showing a grep
 *  dump is what the bench already found scores retrieval without the model citing anything. */
const ANCHOR_TOOLS = new Set(['readFile']);

/** Mutating, path-taking tools whose target is pinned into the anchor store after the write lands
 *  (see AnchorStore.pin). `deleteFile` is absent — there is nothing left to read back. */
const PIN_ON_MUTATION_TOOLS = new Set(['writeFile', 'createFile', 'editFile']);
/** Ceiling on a pinned file's retained text. digest() sizes the block itself; this only stops one
 *  very large edited file from dominating the store before it gets there. */
const PIN_CONTENT_CAP = 12_000;

// `runCommand` is deliberately absent here despite returning bulk output: it's in
// MUTATING_TOOLS and the whole point of the split above is that mutating results are "the
// turn's memory of what it has already done" and are never pruned. It used to be listed
// alongside the read-only tools by mistake, which meant test/build output from earlier in a
// long multi-file turn could silently vanish — contradicting the very design comment above it.
const PRUNE_TOOL_POLICY = [
  {
    type: 'before-last-2-messages' as const,
    tools: ['readFile', 'grep', 'glob', 'listDir', 'explore', 'getSymbolGraph', 'getDependencyTree',
      'getDiagnostics', 'webSearch', 'deepSearch', 'fetchUrl'],
  },
];

/** The same tool set as a lookup, for `blankStaleToolResults`. */
const PRUNABLE_TOOLS = new Set(PRUNE_TOOL_POLICY[0].tools);

/** Opens a blanked tool result. Also the idempotence key — a result already blanked is skipped on
 *  the next pass, so re-running this every step can't nest placeholders. */
const STALE_RESULT_MARKER = '[trimmed]';
/** Below this, blanking saves less than the placeholder costs. */
const MIN_BLANK_CHARS = 400;

/**
 * Replace stale read-tool output with a one-line placeholder, KEEPING the call record.
 *
 * This is the difference between "the model can't see that file's contents any more" and "the
 * model has no idea it ever opened that file". `pruneMessages` does the latter: it removes a tool
 * result together with the assistant message that called it, so after a prune the transcript
 * contains no evidence the call ever happened. On a multi-file task that is precisely the failure
 * the user reported — the agent re-reads files it already read, and contradicts decisions it
 * already made, because the record of having made them is gone.
 *
 * Blanking the body instead keeps the (cheap) call record and drops only the (expensive) payload,
 * so the model still sees "I ran readFile(src/foo.ts) earlier" and can re-run it deliberately.
 * It is also structurally safer than removal: nothing is added or deleted, so a tool-call can
 * never be orphaned from its result (AI_MissingToolResultsError) the way hand-filtering risks.
 * Cline does the same thing, rewriting superseded reads to "[outdated - see the latest file
 * content]" rather than dropping them.
 */
export function blankStaleToolResults(messages: CoreMessage[]): { messages: CoreMessage[]; blanked: number } {
  // Same window as PRUNE_TOOL_POLICY's 'before-last-2-messages': the last two messages are the
  // model's active working set and must stay verbatim.
  const keepFrom = messages.length - 2;
  if (keepFrom <= 0) return { messages, blanked: 0 };
  // A tool result names its tool but not its arguments, so the path comes from the paired call.
  // Without it the placeholder degrades to "some readFile ran", which is nearly useless.
  const pathById = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const part of m.content as Array<Record<string, unknown>>) {
      if (part?.type !== 'tool-call' || typeof part.toolCallId !== 'string') continue;
      const p = pathArgOf(part.input);
      if (p) pathById.set(part.toolCallId, p);
    }
  }
  let blanked = 0;
  const out = messages.map((m, i) => {
    if (i >= keepFrom || m.role !== 'tool' || !Array.isArray(m.content)) return m;
    let changed = false;
    const content = (m.content as Array<Record<string, unknown>>).map((part) => {
      if (part?.type !== 'tool-result' || !PRUNABLE_TOOLS.has(part.toolName as string)) return part;
      const output = part.output as { type?: string; value?: unknown } | undefined;
      if (output?.type !== 'text' || typeof output.value !== 'string') return part;
      if (output.value.length <= MIN_BLANK_CHARS || output.value.startsWith(STALE_RESULT_MARKER)) return part;
      changed = true;
      blanked++;
      const path = pathById.get(part.toolCallId as string);
      const what = `${part.toolName as string}${path ? `(${path})` : ''}`;
      return {
        ...part,
        output: {
          ...output,
          value: `${STALE_RESULT_MARKER} You ran ${what} earlier this turn; its output was trimmed to save context. `
            + 'Run it again only if you actually need the contents — do not redo work you already did.',
        },
      };
    });
    return changed ? ({ ...m, content } as CoreMessage) : m;
  });
  return { messages: out, blanked };
}

/** Intelligence rank at/above which an executor counts as "weak" for the planner→execute
 *  pipeline — rank 3+ means a mid-tier-or-worse model will serve the turn, so a planner step
 *  that decomposes the task first is worth its latency. Lower = smarter; 1 is frontier. */
const WEAK_EXECUTOR_RANK = 3;

/** Step routing (Phase 2): `easy` steps (reads/searches/lookups) route to the cheap pool —
 *  intelligenceRank >= 3. A cheap model reading a file correctly is exactly as correct as a
 *  frontier model reading it; the only thing being spent is quota that a later `hard` step
 *  will need. Unknown models (custom endpoints) always pass the filter inside Router. */
const EASY_STEP_MIN_RANK = 3;
/** `hard` steps (tricky edits, refactors, debugging) get the same top-tier-only constraint the
 *  quality escalation uses — this is where model intelligence actually changes outcomes. */
const HARD_STEP_MAX_RANK = 2;

/** Maps a plan step's difficulty to Router constraints. `medium`/undefined → no constraint
 *  (today's behavior). Escalation constraints win over difficulty — an escalation retry is by
 *  definition a "the smart model must finish this" path. */
function difficultyRouteConstraints(
  stepDifficulty: StepDifficulty | undefined,
  escalation: { maxIntelligenceRank: number } | undefined,
): { minIntelligenceRank?: number; maxIntelligenceRank?: number } {
  if (escalation) return { maxIntelligenceRank: escalation.maxIntelligenceRank };
  if (stepDifficulty === 'easy') return { minIntelligenceRank: EASY_STEP_MIN_RANK };
  if (stepDifficulty === 'hard') return { maxIntelligenceRank: HARD_STEP_MAX_RANK };
  return {};
}

/** System prompt for the planner step of the mixture pipeline. The planner is a read-only,
 *  single-step call routed to a `planner`-tagged model (via taskKind 'plan') that decomposes
 *  the task into an execution plan WITHOUT calling tools or executing anything — its output is
 *  appended to the executor's system prompt as guidance. Keeping it tool-less is what makes the
 *  pipeline safe: no side effects, so it can never collide with the no-retry-after-mutation rule. */
const PLANNER_SYSTEM =
  'You are a planning model. Decompose the user\'s task into a concise, ordered execution plan: '
  + 'the goal, the relevant files/paths to touch, concrete steps in order, and edge cases to watch. '
  + 'Do NOT execute, write code, or call tools — only produce the plan. Be specific and brief.\n'
  + 'Prefix EVERY step with a difficulty tag: `[easy]` for reading/searching/looking things up, '
  + '`[medium]` for straightforward edits, `[hard]` for tricky logic, refactoring, or debugging.\n'
  + 'End the plan with a final line of the exact form `Verify: <command>` naming the ONE command '
  + 'that best proves the change works once implemented (e.g. `npm test`, `tsc --noEmit`, `cargo test`), '
  + 'or `Verify: none` if no command applies.\n\n'
  + 'Example — task: "add a loading spinner to the submit button":\n'
  + 'Goal: show a spinner on the submit button while the form request is in flight.\n'
  + 'Files: src/components/SubmitButton.tsx, src/components/SubmitButton.css\n'
  + 'Steps:\n'
  + '1. [easy] Read SubmitButton.tsx and the form component to find the submit handler.\n'
  + '2. [medium] Add an `isLoading` prop to SubmitButton and disable the button when true.\n'
  + '3. [hard] Wire isLoading from the form\'s submit-in-flight state, clearing it on failure too.\n'
  + 'Edge cases: rapid double-submit while loading; spinner must clear on request failure, not just success.\n'
  + 'Verify: npm test';

/** Parses the planner's `Verify: <command>` tail line (see PLANNER_SYSTEM). Returns undefined for
 *  'none', a missing line, or a value that doesn't look like a shell command — the planner output
 *  is free text from an arbitrary model, so nothing downstream trusts it blindly. */
function plannerVerifyCommand(plan: string): string | undefined {
  const m = /^Verify:\s*(.+)$/im.exec(plan);
  const v = m?.[1]?.trim();
  if (!v || v.toLowerCase() === 'none') return undefined;
  // Command-shaped sanity bound: single line, short, contains a word char. A "verification
  // paragraph" from a chatty planner is not a runnable command — fall back to auto-detection.
  return /^[\w./@-]+([ \t]+\S+){0,6}$/.test(v) ? v : undefined;
}

/**
 * Forced synthesis turn — run after the main loop when the model acted via tools but produced no
 * final text. Re-invokes the SAME routed model with the full tool transcript plus an explicit
 * "answer now" instruction, with the tool loop disabled (single step, no tools) so the only way
 * out is natural-language text. Returns "" if it also yields nothing (caller applies a fallback).
 *
 * `onChunk`/`onReasoning` keep streaming the synthesis live into the UI as if it were a normal
 * answer turn — the user sees "Writing answer…" then the text, not a silent stall.
 */
/** Budget for what `forceSynthesis` may send. Well under any free model's window, because this
 *  is the call that must NOT fail — it is the last chance to turn a dead turn into something the
 *  user can act on. */
const SYNTH_TOKEN_BUDGET = 8_000;
/** Per-tool-result ceiling once the transcript is still too big after pruning. A synthesis needs
 *  to know WHICH files said WHAT, not every line of them. */
const SYNTH_RESULT_CAP = 1_200;

/**
 * Shrink a turn's transcript down to something a weak model can actually summarise.
 *
 * `forceSynthesis` used to send `[...opts.messages, ...workMessages]` verbatim — every raw tool
 * result the turn produced. A stuck turn is BY DEFINITION the one with the most tool output: runs
 * that died this way had made 28-45 calls and carried ~100K characters, so the synthesis request
 * blew past the model's context window and returned nothing. The user then saw "couldn't
 * summarize its findings either" — the turn threw away everything it had learned at exactly the
 * moment that knowledge was all it had left.
 *
 * Two passes, cheapest first: evict stale tool results the same way the main loop does, then, if
 * still over budget, truncate whatever tool results remain.
 */
export function shrinkForSynthesis(messages: CoreMessage[]): CoreMessage[] {
  if (roughTokens(messages) <= SYNTH_TOKEN_BUDGET) return messages;
  let out = pruneMessages({
    messages: messages as never,
    reasoning: 'before-last-message',
    toolCalls: PRUNE_TOOL_POLICY,
    emptyMessages: 'remove',
  }) as unknown as CoreMessage[];
  if (roughTokens(out) <= SYNTH_TOKEN_BUDGET) return out;
  // toCoreMessages() gives a 'tool' message a structured content ARRAY of tool-result parts, each
  // carrying its text under `output.value` — not a plain string. An earlier version of this pass
  // checked `typeof m.content !== 'string'` and therefore never matched anything real, silently
  // no-op-ing on every actual turn (only caught by a test fixture that happened to mirror the bug).
  out = out.map((m) => {
    if (m.role !== 'tool' || !Array.isArray(m.content)) return m;
    return {
      ...m,
      content: (m.content as Array<Record<string, unknown>>).map((part) => {
        if (part.type !== 'tool-result') return part;
        const output = part.output as { type?: string; value?: unknown } | undefined;
        if (output?.type !== 'text' || typeof output.value !== 'string' || output.value.length <= SYNTH_RESULT_CAP) return part;
        return { ...part, output: { ...output, value: `${output.value.slice(0, SYNTH_RESULT_CAP)}\n…[truncated for the summary]` } };
      }),
    } as CoreMessage;
  });
  // Third pass: 40 results capped at 1.2K each can still overshoot, so drop tool calls/results
  // entirely via pruneMessages('all') rather than hand-filtering — a manual filter that removes a
  // 'tool' (result) message but leaves its paired assistant tool-call in place orphans the call,
  // which the AI SDK rejects outright (AI_MissingToolResultsError), and that error is exactly
  // what forceSynthesis's own try/catch swallows into another empty "couldn't summarize" turn.
  // pruneMessages removes a call and its result together, so the transcript stays well-formed.
  if (roughTokens(out) > SYNTH_TOKEN_BUDGET) {
    out = pruneMessages({
      messages: out as never,
      reasoning: 'all',
      toolCalls: 'all',
      emptyMessages: 'remove',
    }) as unknown as CoreMessage[];
  }
  diagLog('turn.synth', `transcript shrunk to ~${roughTokens(out)}tok for synthesis`);
  return out;
}

const TOOL_CALL_DIALECT_RE = /(?:<tool_call>|<tool_call_start|<function=|<｜+DSML｜|\[\s*[a-zA-Z0-9_\-]+\s*\(|\{\s*"(?:name|type)"\s*:)/;

/** Minimum prefix length (words) worth keeping when a tool-call dialect attempt is found mid-text.
 *  Below this, the "prefix" is just meta-narration ("Now let me…") with nothing substantive in
 *  it, and keeping it would show the user a sentence fragment instead of an answer. */
const TOOL_CALL_PREFIX_MIN_WORDS = 12;

/** Does synthesis output contain an attempted tool call, and if so, is there real content before
 *  it worth keeping? forceSynthesis explicitly disables tools (single step, no `tools` param) so
 *  the model MUST answer in text — but a weak model can still try to "call" one anyway by emitting
 *  an inline dialect (see rescueInlineToolCalls) as plain text.
 *
 *  Two real, DIFFERENT cases were observed, and conflating them was itself a bug:
 *  - 2026-08-09: a stuck synthesis's ENTIRE "answer" was raw `<tool_call><function=readFile>...` —
 *    nothing to keep, discard everything.
 *  - 2026-08-10, confirmed from a live user session (screenshot): a model that had ALREADY
 *    successfully made two real edits wrote a genuine summary of what it changed, then tried one
 *    more verification call as text ("...updated the seeder. Let me verify with
 *    <tool_call>getDiagnostics</tool_call>"). The old all-or-nothing version discarded the WHOLE
 *    thing, so the user saw "I looked into this and ran some tools, but couldn't produce a final
 *    answer" — a confident-sounding LIE about a turn that had just edited two real files, worse
 *    than the raw dialect leak this was built to prevent.
 *
 *  Returns the safe portion to keep (possibly the original text if no dialect attempt), or ''
 *  when nothing before the attempt is worth keeping. */
function stripToolCallAttempt(text: string): string {
  const m = TOOL_CALL_DIALECT_RE.exec(text);
  if (!m) return text;
  const prefix = text.slice(0, m.index).trim();
  const words = prefix ? prefix.split(/\s+/).length : 0;
  // Word count alone isn't enough: "Now let me read the specific parts of `runTurn`. Let me find
  // the key code sections." is 16 words and STILL pure narration, not a finding — it ends on an
  // announced-but-undone action, the same shape ACTION_INTENT_RE already exists to catch
  // elsewhere in this file. Require the prefix to be substantial AND not end that way.
  return words >= TOOL_CALL_PREFIX_MIN_WORDS && !ACTION_INTENT_RE.test(prefix) ? prefix : '';
}

async function forceSynthesis(
  languageModel: unknown,
  system: string,
  opts: AgentOpts,
  workMessages: ChatMessage[],
  onChunk: (t: string) => void,
  onReasoning: (d: string) => void,
  stuck?: boolean,
): Promise<string> {
  opts.onStep('synthesizing', stuck ? 'Summarizing progress so far…' : 'Writing answer…');
  try {
    const messages = shrinkForSynthesis(toCoreMessages([...opts.messages, ...workMessages]) as CoreMessage[]);
    messages.push({ role: 'user', content: stuck ? 'You got stuck — summarize your findings and what remains unresolved.' : 'Based on the tool results above, give your final answer now.' });
    const synth = streamText({
      model: languageModel as any,
      system: (system || '') + (stuck ? SYNTH_SUFFIX_STUCK : SYNTH_SUFFIX),
      messages: messages as any,
      // No `tools` + single-step stop → the model cannot delegate again, it must answer.
      stopWhen: [isStepCount(1)],
      abortSignal: opts.abortSignal,
    } as any);
    let out = '';
    let streamed = false;
    for await (const part of (synth as any).fullStream) {
      if (part.type === 'text-delta') { const t = part.text ?? part.delta ?? ''; out += t; onChunk(t); if (t) streamed = true; }
      else if (part.type === 'reasoning-delta') { const d = part.text ?? part.delta ?? ''; onReasoning(d); }
      else if (part.type === 'error') { break; }
    }
    if (TOOL_CALL_DIALECT_RE.test(out)) {
      const kept = stripToolCallAttempt(out);
      diagLog('turn.synth', kept
        ? `synthesis contained a trailing tool-call attempt — kept ${kept.length}/${out.length} chars of real content before it`
        : 'synthesis output looks like an attempted tool call with no real content before it — discarding');
      // The raw text already streamed to the chat bubble live (we can't know it's a tool-call
      // attempt until the stream ends) — retract the transient streamed draft the same way a
      // revealed-as-narration draft is retracted elsewhere in this file. The RETURNED value (not
      // the retracted stream) is what the caller renders as the persisted final answer bubble, so
      // returning `kept` here shows the trimmed real content instead of losing it entirely.
      if (streamed) opts.onRetractDraft?.();
      return kept;
    }
    return out;
  } catch {
    return ''; // synthesis is best-effort — never let it mask the original turn's outcome
  }
}

/**
 * Continuation turn for a length-truncated answer (finish_reason: 'length'). Re-invokes the SAME
 * routed model with its own partial answer in context plus a "resume from the cutoff" instruction,
 * single-step / no tools, and returns the appended text plus the continuation's finish reason so
 * the caller can keep looping until the answer completes naturally. Mirrors forceSynthesis but
 * extends an existing reply instead of forcing one. Live-streams into the UI via onChunk so the
 * user sees the answer resume seamlessly rather than a stall.
 */
async function continueAfterTruncation(
  languageModel: unknown,
  system: string,
  opts: AgentOpts,
  workMessages: ChatMessage[],
  onChunk: (t: string) => void,
  onReasoning: (d: string) => void,
): Promise<{ text: string; finishReason?: string }> {
  opts.onStep('synthesizing', 'Continuing answer…');
  try {
    const messages = toCoreMessages([...opts.messages, ...workMessages]);
    messages.push({ role: 'user', content: 'Continue your previous answer exactly where it ended. Do not repeat any text already written — resume from the cutoff and complete the response.' });
    const synth = streamText({
      model: languageModel as any,
      system,
      messages: messages as any,
      stopWhen: [isStepCount(1)],
      abortSignal: opts.abortSignal,
    } as any);
    let out = '';
    for await (const part of (synth as any).fullStream) {
      if (part.type === 'text-delta') { const t = part.text ?? part.delta ?? ''; out += t; onChunk(t); }
      else if (part.type === 'reasoning-delta') { const d = part.text ?? part.delta ?? ''; onReasoning(d); }
      else if (part.type === 'error') { break; }
    }
    let fr: string | undefined;
    try { fr = await (synth as any).finishReason; } catch { /* non-fatal */ }
    return { text: out, finishReason: fr };
  } catch {
    return { text: '', finishReason: undefined }; // best-effort — never mask the partial already shown
  }
}

/**
 * End-of-turn change recap for mutating turns whose final text didn't already summarize what
 * changed (the model ended on a bare tool call, or on narration that never named the files). A
 * short, single-step, tool-less synthesis pass — the same shape as `forceSynthesis` but prompted
 * for a concise "what I changed" summary, streamed live via onChunk. Best-effort: on any failure it
 * returns '' and the caller falls back to the deterministic changedFiles footer. Only invoked when
 * the heuristic below judges the existing final text NOT to be a recap, so it adds no latency to a
 * turn that already ended with a real summary.
 */
async function recapChanges(
  router: Router,
  opts: AgentOpts,
  workMessages: ChatMessage[],
  changedFiles: { path: string; status: 'created' | 'modified' | 'deleted' }[],
): Promise<string> {
  opts.onStep('synthesizing', 'Summarizing changes…');
  try {
    const provider = createRouterProvider(router, { taskKind: 'trivial' });
    const changeList = changedFiles.map((f) => `- ${f.path} (${f.status})`).join('\n');
    const messages = toCoreMessages([...opts.messages, ...workMessages]);
    messages.push({ role: 'user', content: `Summarize what you just changed. In 1-3 sentences, name the files you edited and what the change does. Files touched:\n${changeList}` });
    const synth = streamText({
      model: provider as any,
      system: 'You are summarizing your own completed edits. Be concise and factual. Do not describe steps you did not take.',
      messages: messages as any,
      stopWhen: [isStepCount(1)],
      abortSignal: opts.abortSignal,
    } as any);
    let out = '';
    for await (const part of (synth as any).fullStream) {
      if (part.type === 'text-delta') { const t = part.text ?? part.delta ?? ''; out += t; opts.onChunk(t); }
      else if (part.type === 'reasoning-delta') { const d = part.text ?? part.delta ?? ''; opts.onReasoning(d); }
      else if (part.type === 'error') { break; }
    }
    return out.trim();
  } catch {
    return '';
  }
}

/** Heuristic: does `text` already constitute a recap of the changes (so we can skip the synthesis
 *  call)? "Yes" if it's substantive (≥40 words) OR mentions at least one changed file's basename.
 *  Cheaper than an LLM judge and good enough to avoid a redundant synthesis on turns that already
 *  ended with a real summary. */
function alreadyRecaps(text: string, changedFiles: { path: string; status: 'created' | 'modified' | 'deleted' }[]): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.split(/\s+/).filter(Boolean).length >= 40) return true;
  const lower = t.toLowerCase();
  return changedFiles.some((f) => {
    const base = f.path.split(/[\\/]/).pop()?.toLowerCase();
    return !!base && base.length > 2 && lower.includes(base);
  });
}

/** Extra instruction appended AFTER the plan (not before) in the executor's system prompt when
 *  the mixture pipeline is active — weak models weight the tail of a system prompt most heavily,
 *  and the one thing that must not get buried is "one thought, one action per turn", the ReAct
 *  pattern most consistently credited for tool-call reliability on small/free models. */
const REACT_SCAFFOLD =
  '\n\nBefore each action, write one short line starting "Thought:" stating what you are about to '
  + 'do and why, then either call exactly one tool or give your final answer. Do not describe '
  + 'multiple future steps in the same turn — one thought, one action. Wait for each tool result '
  + 'before deciding the next step.\n'
  // Anti-repeat: the dominant free-model failure isn't a wrong tool, it's the same tool re-run on
  // a near-identical query until the turn dies. stuckStop catches exact repeats after the fact;
  // this tries to stop it happening. OpenCode ships the same rule to every free model.
  + 'Do not call the same tool again with the same or nearly-identical arguments once you have a '
  + 'usable result — if a search came back empty or unhelpful, change approach or say what you '
  + 'could not find, rather than searching again in a loop.';

/** True when the model that will actually serve this task is mid-tier or worse — the condition
 *  REACT_SCAFFOLD exists for. Read-only peek; does not commit the router to a selection. */
function isWeakExecutor(router: Router, taskKind: TaskKind): boolean {
  return (router.peekTopSelection(taskKind)?.model?.intelligenceRank ?? 5) >= WEAK_EXECUTOR_RANK;
}

/** Scans planner output for file-path-shaped tokens (nested like `src/foo/bar.ts` or bare
 *  root-level like `package.json`) and returns the ones that don't exist in the workspace —
 *  the most common small-model planning failure is inventing a plausible-looking path. Pure
 *  filesystem check, no LLM call, so it costs nothing extra and can't itself hallucinate. */
function unresolvedPlanPaths(plan: string): string[] {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return [];
  const candidates = new Set(plan.match(/\b(?:[\w.-]+\/)*[\w.-]+\.\w{1,10}\b/g) ?? []);
  const missing: string[] = [];
  for (const p of candidates) {
    const abs = path.isAbsolute(p) ? p : path.join(root, p);
    if (!fs.existsSync(abs)) missing.push(p);
  }
  return missing;
}

/** Planner step of the mixture pipeline (see runTurn). Routes a `planner`-tagged model via
 *  taskKind 'plan' and runs a single tool-less streamText to decompose the task; the returned
 *  plan is appended to the executor's system prompt. Live-streams into the UI as a reasoning
 *  block so the user sees the plan form. Best-effort: '' on any failure — never blocks the turn. */
async function runPlannerStep(router: Router, opts: AgentOpts): Promise<string> {
  opts.onStep('planning', 'Decomposing task…');
  try {
    const provider = createRouterProvider(router, {
      taskKind: 'plan',
      pinnedModel: undefined, // always auto-pick the best planner-tagged model
      onFailover: opts.onFailover,
      onKeyRotated: opts.onKeyRotated,
      onModelSelected: (p, m, rt) => opts.onModel(p, m, rt),
      onSelectionRationale: opts.onSelectionRationale,
    });
    const languageModel = wrapLanguageModel({
      model: provider,
      middleware: createTelemetryMiddleware({ profiler: opts.profiler, traceId: opts.sessionId as any }),
    });
    const result = streamText({
      model: languageModel,
      system: PLANNER_SYSTEM,
      messages: toCoreMessages(opts.messages) as any,
      // No `tools` + single-step stop → the planner can only produce a plan, not act.
      stopWhen: [isStepCount(1)],
      abortSignal: opts.abortSignal,
    } as any);
    let out = '';
    for await (const part of (result as any).fullStream) {
      if (part.type === 'text-delta') { const t = part.text ?? part.delta ?? ''; out += t; opts.onReasoning(t); }
      else if (part.type === 'reasoning-delta') { const d = part.text ?? part.delta ?? ''; opts.onReasoning(d); }
      else if (part.type === 'error') { break; }
    }
    const missing = unresolvedPlanPaths(out);
    if (missing.length) {
      out += `\n\n(Note: these paths do not currently exist in the workspace — verify whether they are missing or meant to be newly created: ${missing.join(', ')})`;
    }
    return out;
  } catch {
    return ''; // planner is best-effort — never let it mask the executor's turn
  }
}

const BRAINSTORM_SYSTEM =
  'You are evaluating whether a coding task has a genuine fork in approach — competing '
  + 'libraries/patterns, a migrate-vs-shim choice, a data-model tradeoff, etc. Most tasks do '
  + 'NOT have one (e.g. "fix this typo", "add a loading spinner") — only flag a real fork, not '
  + 'a trivial implementation detail. If there is no genuine fork, set hasFork to false and leave '
  + 'approaches empty. If there is one, name 2-3 concrete approaches with a one-line tradeoff '
  + 'each, and a short recommendation for which to pick and why.';

const BRAINSTORM_SCHEMA = z.object({
  hasFork: z.boolean(),
  approaches: z.array(z.object({ name: z.string(), tradeoff: z.string() })).max(3),
  recommendation: z.string().optional(),
});

/** Plan-mode counterpart to runPlannerStep: a single tool-less `generateObject` call that
 *  decides whether this task has a genuine fork in approach and, if so, names the alternatives
 *  and their tradeoffs — folded into the plan-generation system prompt as guidance so the final
 *  numbered plan can name the tradeoff instead of silently picking one (see the research behind
 *  this: no coding agent runs a separate "generate N full plans, pick one" pipeline for this —
 *  Claude Code/Cline/aider all fold it into prompt guidance for the single planning pass, which
 *  is what this does too — one extra structured call, not a multi-plan fan-out).
 *  Best-effort: '' on any failure, timeout, or "no real fork" — never blocks the plan turn. */
async function runBrainstormStep(router: Router, opts: AgentOpts): Promise<string> {
  opts.onStep('planning', 'Considering approaches…');
  try {
    const provider = createRouterProvider(router, {
      taskKind: 'plan',
      onFailover: opts.onFailover,
      onKeyRotated: opts.onKeyRotated,
      onModelSelected: (p, m, rt) => opts.onModel(p, m, rt),
      onSelectionRationale: opts.onSelectionRationale,
    });
    const timeout = AbortSignal.timeout(8000);
    const { object } = await generateObject({
      model: provider,
      schema: BRAINSTORM_SCHEMA,
      system: BRAINSTORM_SYSTEM,
      messages: toCoreMessages(opts.messages) as any,
      abortSignal: opts.abortSignal ? AbortSignal.any([opts.abortSignal, timeout]) : timeout,
    });
    if (!object.hasFork || !object.approaches.length) return '';
    const lines = object.approaches.map((a) => `- ${a.name}: ${a.tradeoff}`).join('\n');
    return `\n\n## Approaches considered\n${lines}`
      + (object.recommendation ? `\nRecommendation: ${object.recommendation}` : '');
  } catch {
    return ''; // brainstorm is best-effort — never let it block or mask the plan turn
  }
}

/** One model attempt at a turn — everything runTurn used to do inline, extracted so a weak/
 *  stuck attempt can be retried once with a different (excluded/escalated) model. See
 *  runTurn's escalation orchestration below. */
interface AttemptResult {
  text: string;
  reasoning: string;
  platform?: string;
  model?: string;
  runtimeName?: string;
  paused: boolean;
  workMessages: ChatMessage[];
  stopReason?: 'budget' | 'stuck' | 'askQuestions';
  /** Set when the model called the plan-mode `askQuestions` tool this turn — the caller uses
   *  this directly instead of parsing `text` for the legacy ???QUESTIONS??? sentinel. */
  askQuestions?: ClarifyingQuestion[];
  hadToolCalls: boolean;
  /** True if any write/create/edit/delete/runCommand tool call happened this attempt — once
   *  true, retrying with a different model is unsafe (side effects already occurred), so
   *  runTurn must not escalate past this attempt. */
  hadMutatingToolCall: boolean;
  /** A verify-shaped tool ran after the last mutating call — see VERIFY_TOOLS. */
  verifiedAfterMutation: boolean;
  /** Workspace paths this attempt actually passed to a path-taking tool — the raw material for
   *  the session findings note (see sessionFindings.ts). Unfiltered here; recordFindings drops
   *  anything that isn't a real file. */
  openedFiles: string[];
  /** Set when the attempt ended via the genuine-error catch path (not abort) with no text —
   *  `onError` already surfaced a message to the UI; runTurn must not also report success. */
  failed?: boolean;
  /** The failure text, same as what went to `onError` — carried through so the caller can show
   *  it as a real reply bubble instead of leaving the user with only the thin error notice. */
  errorMessage?: string;
  /** Set when `failed` came from a tool call that `repairToolCall`'s 3 tiers all gave up on
   *  (InvalidToolInputError/NoSuchToolError/ToolCallRepairError escaping streamText) — a weak
   *  model shape neither deterministic nor model-assisted repair could fix, as opposed to a
   *  provider/network failure. runTurn uses this to decide the failure is worth one more attempt
   *  with an explicit "here's what was wrong with your last call" nudge, since the model never
   *  actually saw why it failed (see AI SDK's own docs: an unrepaired InvalidToolInputError comes
   *  back as a stream `error` part, not a `tool-error` part, so it never reaches the model like a
   *  normal tool failure would). */
  toolCallRepairFailed?: boolean;
  /** Files this attempt created/modified/deleted via mutating tools — propagated to
   *  AgentResult.changedFiles for the caller's recap. */
  changedFiles?: { path: string; status: 'created' | 'modified' | 'deleted' }[];
}

const TASK_KIND_VALUES = ['trivial', 'chat', 'agent', 'coding', 'debug', 'longContext', 'vision'] as const;

/** Regex classification is instant but guesses when nothing matches (e.g. "reformat this for
 *  Google Docs @notes.md" — no textbook verb, no bare "?"). Rather than trust a predefined-word
 *  list that can always miss a phrasing, spend one cheap classify call ONLY on that ambiguous
 *  case — confident regex matches (the overwhelming majority of messages) pay zero extra latency.
 *  Uses `output: 'enum'` (not a full object schema) since the model just needs to pick one label,
 *  and a short abort timeout + broad try/catch so a flaky/incapable free model never blocks the
 *  turn — any failure just falls back to the regex guess it already had. */
async function classifyTaskSmart(router: Router, text: string, signals?: ClassifySignals): Promise<TaskKind> {
  const { kind, confident } = classifyTaskCore(text, signals);
  if (confident) return kind;
  try {
    const provider = createRouterProvider(router, { taskKind: 'trivial' });
    const { object } = await generateObject({
      model: provider,
      output: 'enum',
      enum: [...TASK_KIND_VALUES],
      abortSignal: AbortSignal.timeout(4000),
      prompt: 'Classify this message for an AI coding assistant\'s routing.\n'
        + '- trivial: a greeting or small talk\n'
        + '- chat: a question, or a request to use/transform content already supplied in the '
        + 'message (e.g. "reformat this for Google Docs")\n'
        + '- agent: an explicit action that may edit files\n'
        + '- coding: a specific code edit/implementation request\n'
        + '- debug: chasing a bug or error\n'
        + '- longContext: needs a very large amount of context\n'
        + '- vision: about an attached image or PDF\n\n'
        + `Message:\n"""${text.slice(0, 2000)}"""`,
    });
    diagLog('turn.classify', `regex guessed "${kind}" (ambiguous) → llm picked "${object}"`);
    return object as TaskKind;
  } catch (err) {
    diagLog('turn.classify', `llm classify failed, keeping regex guess "${kind}": ${err instanceof Error ? err.message : String(err)}`);
    return kind;
  }
}

/** AI SDK's own inline repair hook for a NATIVE tool call the model emitted through the real
 *  tools API but with bad name/args — distinct from `rescueInlineToolCalls` in routerProvider.ts,
 *  which only fires when the model emitted NO native call at all (dialect text instead). A weak
 *  model can still botch a genuine native call (double-JSON-encoded args, a stringified nested
 *  object/array, a Harmony-mangled tool name) and this is currently the only place that gets a
 *  chance to fix it before the SDK throws and drops the step.
 *  - InvalidToolInputError: reuse the same repairToolArguments the text-rescue path already
 *    trusts, against the failing tool's real input schema.
 *  - NoSuchToolError: reuse sanitizeToolName to strip Harmony/namespace noise, retry against the
 *    tool list.
 *  - Tier 3 (last resort, only when both above miss): ask a cheap utility model to fix the call
 *    itself. `ai@7.0.58`'s `repairToolCall` ships no built-in repair strategy of its own — this is
 *    the SDK's own documented pattern (recursively calling the model to repair its tool call), not
 *    something the SDK does automatically; TierMux didn't use it before this.
 *  Returns null (drop the call, let the SDK report the error back to the model) when no repair
 *  produces a valid result — never fabricate an unrelated tool call. */
function createRepairToolCall(router: Router, abortSignal?: AbortSignal): NonNullable<Parameters<typeof streamText>[0]['repairToolCall']> {
  return async ({ toolCall, tools, error, inputSchema }) => {
    if (InvalidToolInputError.isInstance(error)) {
      const schema = await Promise.resolve(inputSchema({ toolName: toolCall.toolName })).catch(() => undefined);
      const repaired = repairToolArguments(toolCall.input, schema as { properties?: Record<string, { type?: string }> } | undefined);
      if (repaired !== toolCall.input) {
        try {
          JSON.parse(repaired);
          diagLog('turn.repairToolCall', `invalid-input: ${toolCall.toolName} repaired`);
          return { ...toolCall, input: repaired };
        } catch { /* fall through to Tier 3 */ }
      }
      return (await tryModelRepair(toolCall, tools, error.message, schema, router, abortSignal)) as any;
    }
    if (NoSuchToolError.isInstance(error)) {
      const fixedName = resolveToolName(sanitizeToolName(toolCall.toolName), tools);
      if (fixedName && fixedName !== toolCall.toolName) {
        diagLog('turn.repairToolCall', `no-such-tool: "${toolCall.toolName}" → "${fixedName}"`);
        return { ...toolCall, toolName: fixedName };
      }
      // Tool name is too scrambled to resolve deterministically — no schema to repair args
      // against either. Tier 3's prompt gets the full active tool-name list in this case so the
      // model can pick the right tool AND fix the arguments in one shot.
      return (await tryModelRepair(toolCall, tools, error.message, undefined, router, abortSignal)) as any;
    }
    return null;
  };
}

/** Tier 3: ask a cheap/fast utility model (`router.pickUtilityModel()` — the same picker
 *  `explore.ts` uses, so this doesn't add a second model-tier decision) to fix a tool call that
 *  neither deterministic repair could. Only reached when Tier 1/2 both miss, so it never adds
 *  latency to the common cases. Strictly time-boxed (this is error recovery, not a normal
 *  request) and combined with the turn's own abort signal so cancelling the turn also kills an
 *  in-flight repair call instead of leaving it running to its own timeout. */
export async function tryModelRepair(
  // Typed loosely on purpose: the real type is the SDK's LanguageModelV4ToolCall, but this
  // helper only reads toolName/input and spreads the rest back through unchanged (preserving
  // `type`/`toolCallId`, which the hook's return type requires but this function never touches).
  toolCall: { toolName: string; input: string } & Record<string, unknown>,
  tools: Record<string, unknown>,
  errorMessage: string,
  schema: unknown,
  router: Router,
  abortSignal?: AbortSignal,
): Promise<({ toolName: string; input: string } & Record<string, unknown>) | null> {
  diagLog('turn.repairToolCall.tier3_attempt', `${toolCall.toolName}: ${errorMessage}`);
  const timeout = AbortSignal.timeout(4000);
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
  try {
    const utility = await router.pickUtilityModel();
    const provider = createRouterProvider(router, { taskKind: 'reasoning', pinnedModel: utility });
    const toolNames = Object.keys(tools);
    const prompt = schema
      ? `A tool call failed validation.\nTool: ${toolCall.toolName}\nSchema: ${JSON.stringify(schema)}\nArguments: ${toolCall.input}\nError: ${errorMessage}\n\nReply with ONLY the corrected JSON arguments object matching the schema. No explanation, no markdown.`
      : `A tool call named "${toolCall.toolName}" does not exist. Valid tool names: ${toolNames.join(', ')}\nArguments: ${toolCall.input}\nError: ${errorMessage}\n\nReply with ONLY a JSON object of the shape {"toolName": "<correct name from the list>", "input": <corrected arguments object>}. No explanation, no markdown.`;
    const { text } = await generateText({ model: provider as any, prompt, abortSignal: signal } as any);
    // Weak utility models routinely wrap the answer in preamble/markdown fences even when told
    // not to — extract the substring between the first `{` and the last `}` rather than trust a
    // fragile `replace(/^```json/, '')`, matching the tolerance repairToolArguments's own
    // double-JSON-unwrap already assumes about messy model output.
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) return null;
    const candidate = text.slice(first, last + 1);
    if (schema) {
      JSON.parse(candidate); // validate only — throws on garbage
      diagLog('turn.repairToolCall.tier3_success', `invalid-input: ${toolCall.toolName} model-repaired`);
      return { ...toolCall, input: candidate };
    }
    const parsed = JSON.parse(candidate) as { toolName?: string; input?: unknown };
    if (!parsed.toolName || !tools[parsed.toolName] || parsed.input == null) return null;
    diagLog('turn.repairToolCall.tier3_success', `no-such-tool: "${toolCall.toolName}" → "${parsed.toolName}" model-repaired`);
    return { ...toolCall, toolName: parsed.toolName, input: JSON.stringify(parsed.input) };
  } catch {
    return null; // timeout, abort, or genuinely unparseable — surface as a normal tool error
  }
}

/** Names weak models invent for tools that DO exist under another name. Measured, not guessed:
 *  a 20-query benchmark run made 13 `read` calls, every one of which errored — ~4% of all tool
 *  calls in the run burned on a name mismatch, each one also costing a step and a round trip.
 *  sanitizeToolName alone can't fix these; it only strips Harmony/namespace noise, so a clean
 *  but wrong name like `read` passes through unchanged and the call dies. */
const TOOL_NAME_ALIASES: Record<string, string> = {
  read: 'readFile', readfile: 'readFile', cat: 'readFile', open: 'readFile', view: 'readFile',
  write: 'writeFile', create: 'createFile', edit: 'editFile', patch: 'editFile', replace: 'editFile',
  delete: 'deleteFile', remove: 'deleteFile', rm: 'deleteFile',
  ls: 'listDir', list: 'listDir', listdirectory: 'listDir', dir: 'listDir',
  find: 'glob', search: 'grep', ripgrep: 'grep', rg: 'grep', searchfiles: 'grep',
  bash: 'runCommand', shell: 'runCommand', run: 'runCommand', exec: 'runCommand', terminal: 'runCommand',
  todo: 'todowrite', todos: 'todowrite', todowrite: 'todowrite',
  websearch: 'webSearch', fetch: 'fetchUrl', fetchurl: 'fetchUrl',
  ask: 'question', askuser: 'question',
  diagnostics: 'getDiagnostics', symbols: 'getSymbolGraph', symbolgraph: 'getSymbolGraph',
  dependencies: 'getDependencyTree', dependencytree: 'getDependencyTree',
};

/** Map a model-invented tool name onto a real one from THIS turn's tool set, or undefined.
 *  Order matters: an exact hit wins, then a case/underscore-insensitive match (`read_file` →
 *  `readFile`), then the hand-written alias table. Never returns a tool the turn doesn't have —
 *  swapping in a tool the mode deliberately withheld would defeat the plan/ask read-only gate. */
function resolveToolName(name: string, tools: Record<string, unknown>): string | undefined {
  if (!name) return undefined;
  if (tools[name]) return name;
  const key = name.toLowerCase().replace(/[_\-\s]/g, '');
  for (const real of Object.keys(tools)) {
    if (real.toLowerCase().replace(/[_\-\s]/g, '') === key) return real;
  }
  const alias = TOOL_NAME_ALIASES[key];
  return alias && tools[alias] ? alias : undefined;
}

async function runAttempt(
  router: Router,
  opts: AgentOpts,
  taskKind: TaskKind,
  pruneAtTokens: number,
  maxTurnTokens: number,
  maxExplorationCalls: number,
  maxStepsPerTurn: number,
  escalation?: { excludeModels: string[]; maxIntelligenceRank: number },
  planGuidance?: string,
): Promise<AttemptResult> {
  // Loop-control stop conditions beyond the step cap. `stopReason` is set by whichever custom
  // condition fires so the finish handling below can treat it as TERMINAL (not paused) — these
  // are "the model is stuck / over budget" stops, and auto-continuing them would just repeat the
  // waste. Kept out of the paused→auto-continue path on purpose.
  let stopReason: 'budget' | 'stuck' | 'askQuestions' | undefined;
  // Captured when the model calls the plan-mode `askQuestions` tool (no `execute` — the SDK
  // never auto-runs it). Its `input.questions` is already Zod-validated by the SDK.
  let askQuestionsCall: { toolCallId: string; questions: ClarifyingQuestion[] } | undefined;
  // Fires-once guard for the budget-approaching nudge in prepareStep below.
  let budgetNudged = false;
  // Fires-once guard for the DIAGNOSTIC message on the hard tool-restriction escalation below —
  // the restriction itself (`out.activeTools`) re-applies every step past the threshold, this
  // flag only stops the explanatory nudge message from repeating each time.
  let budgetForced = false;
  const budgetStop = ({ steps }: { steps: Array<{ usage?: { totalTokens?: number } }> }): boolean => {
    if (maxTurnTokens <= 0) return false;
    const total = steps.reduce((n, s) => n + (s.usage?.totalTokens ?? 0), 0);
    if (total > maxTurnTokens) { stopReason = 'budget'; diagLog('turn.stop', `budget: ~${total}tok > ${maxTurnTokens}`); return true; }
    return false;
  };
  // Weak free models frequently re-issue the identical tool call (e.g. grep "failover" 4×) and
  // spin to the step cap without progress. Stop once any exact (tool + args) call has been made
  // 3 times in this turn — clearly stuck, not deliberate repetition.
  const stuckStop = ({ steps }: { steps: Array<{ toolCalls?: Array<{ toolName?: string; input?: unknown }> }> }): boolean => {
    const counts = new Map<string, number>();
    for (const s of steps) {
      for (const tc of s.toolCalls ?? []) {
        const key = `${tc.toolName}:${JSON.stringify(tc.input ?? {})}`;
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        if (n >= 3) { stopReason = 'stuck'; diagLog('turn.stop', `stuck: repeated ${key.slice(0, 80)} ×${n}`); return true; }
      }
    }
    return false;
  };
/** Canonical form of a tool call for near-duplicate detection: tool name + arguments with keys
 *  sorted and string values lowercased/stripped of non-alphanumerics, so "submitProduct" and
 *  "submitproduct" collapse to the same key while two genuinely different reads stay distinct.
 *  Input may arrive as a JSON string from a weak model — unwrap it first (same tolerance as
 *  pathArgOf/repairToolArguments). */
function normalizedToolCallKey(toolName: string, input: unknown): string {
  let v = input;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* keep raw string */ } }
  const canon = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(canon);
    if (x && typeof x === 'object') {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(x as Record<string, unknown>).sort()) o[k] = canon((x as Record<string, unknown>)[k]);
      return o;
    }
    if (typeof x === 'string') return x.toLowerCase().replace(/[^a-z0-9]+/g, '');
    return x;
  };
  return `${toolName}:${JSON.stringify(canon(v))}`;
}

  // Exact-repeat detection (above) misses the more common weak-model failure: re-searching the
  // SAME thing with slightly different wording each time ("submitproduct", "submitProduct",
  // "submit") — never an exact duplicate, so never trips stuckStop, yet zero real progress
  // (no mutating tool call) happens. Cap only the NEAR-DUPLICATE exploration calls, not distinct
  // reads: investigating an unfamiliar codebase legitimately takes 20+ distinct reads before the
  // first edit, and the old distinct-count cap cut exactly those investigations short (reported
  // as 'stuck', then halted by the auto-continue loop after one nudge). Distinct reads are
  // progress — they are never counted here; budgetStop/stepCountStop remain the backstops for a
  // turn that reads forever without acting. Any mutating call disables the cap entirely.
  const explorationStop = ({ steps }: { steps: Array<{ toolCalls?: Array<{ toolName?: string; input?: unknown }> }> }): boolean => {
    if (maxExplorationCalls <= 0) return false;
    const seen = new Set<string>();
    let repeated = 0;
    for (const s of steps) {
      for (const tc of s.toolCalls ?? []) {
        if (!tc.toolName) continue;
        if (MUTATING_TOOLS.has(tc.toolName)) return false; // real progress happened — no cap
        const key = normalizedToolCallKey(tc.toolName, tc.input);
        if (seen.has(key)) repeated++;
        else seen.add(key);
      }
    }
    if (repeated > maxExplorationCalls) {
      stopReason = 'stuck';
      diagLog('turn.stop', `stuck: ${repeated} near-duplicate read-only tool calls (${seen.size} distinct) with zero mutating progress`);
      return true;
    }
    return false;
  };
  // `askQuestions` has no `execute` (human-in-the-loop pattern — see tools/ui/askQuestions.ts),
  // so there's no tool-result to feed back into a further step. Belt-and-suspenders alongside
  // the SDK's own "no result available, nothing to continue with" behavior for no-execute tools —
  // an explicit stop here means this turn terminates deterministically the moment it's called,
  // rather than relying on that being the SDK's actual behavior in every version.
  const askQuestionsStop = ({ steps }: { steps: Array<{ toolCalls?: Array<{ toolName?: string }> }> }): boolean => {
    if (!tools.askQuestions) return false; // not registered this mode — a name match can't be real
    for (const s of steps) {
      if ((s.toolCalls ?? []).some((tc) => tc.toolName === 'askQuestions')) {
        stopReason = 'askQuestions';
        return true;
      }
    }
    return false;
  };
  // Hard step ceiling (see maxStepsPerTurn in runTurn). Catches the one runaway shape the other
  // three miss: many DISTINCT mutating tool calls, none exact-repeating, all "real progress" —
  // yet the turn sprawls. Reports as 'budget' so it halts via the bounded-continuation path
  // (maxBudgetContinuations) rather than becoming a resumable pause that would just re-segment
  // the same work across auto-continue rounds.
  const stepCountStop = ({ steps }: { steps: unknown[] }): boolean => {
    if (maxStepsPerTurn <= 0) return false;
    if (steps.length > maxStepsPerTurn) {
      stopReason = 'budget';
      diagLog('turn.stop', `step-cap: ${steps.length} steps > ${maxStepsPerTurn}`);
      return true;
    }
    return false;
  };
  // stuckStop/explorationStop only look at toolCalls, and only run BETWEEN steps — a weak model
  // that thrashes by repeating the same sentence/line over and over with NO tool calls at all
  // (observed: "Then I'll check the X controller." repeated hundreds of times) never trips
  // either one, and since it's all one step, it can run to the provider's own output cap before
  // stopWhen gets a chance to look. Checked incrementally against the live text-delta buffer
  // instead (see the text-delta branch below). Cheap streak count, no regex backtracking risk.
  const hasDegenerateTextRepetition = (text: string): boolean => {
    const tail = text.slice(-4000);
    const lines = tail.split(/(?<=[.!?\n])\s+/).map((s) => s.trim()).filter((s) => s.length >= 10);
    if (lines.length < 4) return false;
    const last = lines[lines.length - 1];
    let streak = 1;
    for (let i = lines.length - 2; i >= 0 && lines[i] === last; i--) streak++;
    return streak >= 4;
  };

  let platform: string | undefined;
  let model: string | undefined;
  let runtimeName: string | undefined;

  // A caller-supplied excludeModels (e.g. chatViewProvider's auto-continue loop excluding the
  // model that just got stuck) only matters in Auto mode — an explicit pinnedModel is the user's
  // own choice and always wins. Unlike escalation, sessionId is deliberately KEPT here: Router
  // filters excludeModels out of the candidate list BEFORE consulting the session pin (see
  // Router.route()), so the excluded model is already gone by the time the pin would apply — the
  // pin lookup harmlessly misses and falls through. Keeping sessionId lets Router record whatever
  // NEW model this call picks as the session's pin, so the round AFTER the stuck-recovery one
  // stays on the model that actually worked instead of drifting back to the stale pin.
  const hasCallerExclude = !escalation && !opts.pinnedModel && !!opts.excludeModels?.length;
  // Step routing (Phase 2): the difficulty of the plan step this attempt executes constrains
  // the candidate pool. A pinned model always wins regardless (candidates() short-circuits
  // forced models before any rank filter), and an escalation's top-tier constraint wins over
  // difficulty — see difficultyRouteConstraints. `tiermux.agent.stepRouting: false` disables the
  // DIFFICULTY constraint only: an escalation retry is not step routing, and dropping its
  // top-tier constraint here would silently let the quality escalation retry on the same weak
  // tier it just escalated away from.
  const stepRoutingOn = vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('stepRouting', true);
  const stepRoute = difficultyRouteConstraints(stepRoutingOn ? opts.stepDifficulty : undefined, escalation);
  const provider = createRouterProvider(router, {
    effort: opts.effort,
    taskKind,
    // An escalation retry must not stay pinned to the model the user (or a prior attempt)
    // picked — that would just repeat the same weak/stuck answer. Auto-select among the
    // excluded/higher-tier candidates instead.
    pinnedModel: escalation ? undefined : opts.pinnedModel,
    // Session stickiness for Auto (see Router.sessionPin). Deliberately NOT passed on an
    // escalation retry: the whole point there is to leave the model that just underperformed.
    sessionId: escalation ? undefined : opts.sessionId,
    excludeModels: escalation?.excludeModels ?? (hasCallerExclude ? opts.excludeModels : undefined),
    maxIntelligenceRank: stepRoute.maxIntelligenceRank,
    minIntelligenceRank: stepRoute.minIntelligenceRank,
    onFailover: opts.onFailover,
    onKeyRotated: opts.onKeyRotated,
    onModelSelected: (p, m, rt) => { platform = p; model = m; runtimeName = rt; opts.onModel(p, m, rt); },
    onSelectionRationale: opts.onSelectionRationale,
  });
  const languageModel = wrapLanguageModel({
    model: provider,
    middleware: createTelemetryMiddleware({ profiler: opts.profiler, traceId: opts.sessionId as any }),
  });

  // Last user message drives the skill auto-match (`triggers:` frontmatter). On a continuation
  // round this is the synthetic continue message — which is exactly why stepEngine re-injects the
  // "Original request:" line into it: the trigger words ride along, so a matched skill stays
  // active for every round of a multi-step task instead of silently dropping after round 1.
  const lastUserForSkill = [...opts.messages].reverse().find((m) => m.role === 'user');
  const system = (await buildSystemPrompt(opts.mode, taskKind, opts.sessionId, contentToString(lastUserForSkill?.content ?? '')))
    + (planGuidance ?? '');
  diagLog('turn.gate', `traceId=${opts.sessionId ?? '<none>'} · buildSystemPrompt done`);
  const tools = createToolSet(opts, getMcpManager(), router);
  diagLog('turn.gate', `traceId=${opts.sessionId ?? '<none>'} · createToolSet done (${Object.keys(tools).length} tools)`);

  let text = '';
  let reasoning = '';
  const workMessages: ChatMessage[] = [];
  // Declared OUT here, not inside the try, so the catch below can report what actually happened.
  // They used to live in the try body, which left the catch no choice but to hardcode
  // `hadToolCalls: false, hadMutatingToolCall: false, openedFiles: []`. An exception can escape
  // streamText long AFTER real work ran (e.g. tiers 1-3 of repairToolCall all miss on step 5,
  // when step 3 already wrote a file), so those falsy values were a lie — and every guard built
  // on them was silently disarmed on this path: `!first.hadToolCalls` in the repair retry and
  // `!first.hadMutatingToolCall` in `canEscalate` are precisely the "never retry past a mutation"
  // invariant, and both were structurally always-true after a caught error. The result was a
  // retry that re-ran the turn from the original messages with no record of the edit already on
  // disk — duplicating the side effect.
  let hadToolCalls = false;
  let hadMutatingToolCall = false;
  // True once a verification-shaped tool ran AFTER the most recent mutating call. Reset by each
  // new mutation, so "edit, test, edit again" correctly counts as unverified — the last edit is
  // the one the completion claim is about.
  let verifiedAfterMutation = false;
  const openedFiles: string[] = [];
  // Late re-anchoring (anchors.ts): retains the content of files read this attempt so prepareStep
  // can re-show it after PRUNE_TOOL_POLICY evicts the real tool result. `stepIndex` only orders
  // the anchors by freshness — the newest read is rendered nearest the prompt tail.
  const anchors = new AnchorStore();
  let stepIndex = 0;
  // Read inline rather than threaded through runAttempt's already-long positional signature —
  // same pattern as the stepRouting flag above. 0 disables re-anchoring entirely.
  const reanchorChars = vscode.workspace.getConfiguration('tiermux.agent').get<number>('reanchorChars', 6_000);
  // Files this attempt created/modified/deleted, for the structured AgentResult.changedFiles recap.
  // A Map keyed by path so repeated edits to the same file collapse to one entry; createFile wins
  // over a later editFile on the same path (it was created this turn).
  const changedFilesMap = new Map<string, 'created' | 'modified' | 'deleted'>();

  try {
    diagLog('turn.gate', `traceId=${opts.sessionId ?? '<none>'} · streamText starting`);
    const result = streamText({
      model: languageModel,
      system,
      messages: toCoreMessages(opts.messages) as any,
      tools: tools as any,
      toolApproval: createToolApproval(opts) as any,
      repairToolCall: createRepairToolCall(router, opts.abortSignal),
      // No hard step-count cap — a long multi-step task no longer pauses just for running past an
      // arbitrary iteration count (see the Resume-button "paused" path, now unreachable for a
      // normal in-progress task). budgetStop/stuckStop are the remaining backstops against a
      // genuinely runaway/stuck turn — the abortSignal (Stop button) is always available too.
      stopWhen: [budgetStop, stuckStop, explorationStop, stepCountStop, askQuestionsStop],
      abortSignal: opts.abortSignal,
      // Per-step context compression (AI SDK native). Runs before each model call in the tool
      // loop; only rewrites history once it exceeds the threshold, so short turns are untouched.
      // Keeps the last 2 messages' tool outputs (the model's active working set) and the most
      // recent reasoning, dropping older ones — the SDK keeps the result well-formed (call+result
      // pruned together), so this can't reintroduce the orphaned-tool-call shape sanitize fixes.
      prepareStep: ({ messages, steps }: { messages: CoreMessage[]; steps: Array<{ usage?: { totalTokens?: number }; toolCalls?: Array<{ toolName?: string }> }> }) => {
        let out: { messages?: CoreMessage[]; activeTools?: string[] } = {};
        if (pruneAtTokens > 0) {
          const before = roughTokens(messages);
          if (before >= pruneAtTokens) {
            // Cheapest effective step first: blank the stale read payloads but keep their call
            // records (see blankStaleToolResults). This recovers nearly all the tokens that
            // deleting would, without destroying the model's record of what it has already done.
            const { messages: blankedMsgs, blanked } = blankStaleToolResults(messages);
            let pruned = pruneMessages({
              messages: blankedMsgs as any,
              // Tool results are handled by the blanking pass above; only reasoning is dropped
              // here, so no call/result pair is ever removed on this path.
              reasoning: 'before-last-message',
              emptyMessages: 'remove',
            }) as unknown as CoreMessage[];
            // Backstop: on a genuinely enormous transcript (hundreds of calls, or bulk that isn't
            // in a prunable tool's result at all) blanking may not be enough. Only then fall back
            // to real eviction — accepting the loss of call records because exceeding the context
            // window loses everything.
            if (roughTokens(pruned) >= pruneAtTokens) {
              pruned = pruneMessages({
                messages: pruned as any,
                reasoning: 'before-last-message',
                toolCalls: PRUNE_TOOL_POLICY,
                emptyMessages: 'remove',
              }) as unknown as CoreMessage[];
              diagLog('turn.prune', `still ~${roughTokens(pruned)}tok after blanking ${blanked} result(s) — fell back to eviction`);
            }
            diagLog('turn.prune', `~${before}tok ≥ ${pruneAtTokens} → blanked ${blanked}, ${messages.length}→${pruned.length} msgs (~${roughTokens(pruned)}tok)`);
            out.messages = pruned as any;
            // Late re-anchoring — see anchors.ts. Pruning just removed the read results; put a
            // bounded copy of the same files back so the model is not answering about code it can
            // no longer see. Deliberately tied to the prune branch: while nothing has been evicted
            // the real results are still in history and re-showing them would only duplicate.
            // Re-runs every pruned step (continuous re-anchoring, which is the mechanism that
            // works), and strips its own previous block first so copies can never stack.
            const digest = anchors.digest(reanchorChars);
            // The paths-only manifest goes in even when the content digest doesn't fit (or is
            // capped at 4 files): on a 5+ file task the earliest files fall out of BOTH the raw
            // history and the digest, and search-derived context is never re-anchored at all, so
            // without this the model loses any trace it already handled them and re-reads or
            // contradicts its own earlier decisions. Paths cost almost nothing.
            const manifest = renderTouchedFiles(openedFiles, changedFilesMap);
            if (digest || manifest) {
              const base = stripAnchorBlock(out.messages as Array<{ role: string; content: unknown }>);
              const blocks = [digest, manifest].filter(Boolean)
                .map((content) => ({ role: 'user', content }));
              out.messages = [...base, ...blocks] as any;
              diagLog('turn.reanchor', `re-showed ${anchors.size} read file(s), ~${digest.length} chars, + ${manifest ? 'manifest' : 'no manifest'}, after prune`);
            }
          }
        }
        // Budget-approaching nudge — agent mode only, fires once. budgetStop is a pure kill
        // switch with no warning: a model that keeps exploring without ever attempting an edit
        // can burn the ENTIRE token budget on read-only calls and get cut off having never once
        // tried the actual task. Measured 2026-08-10: a complex-task run made 29 read-only calls,
        // hit budgetStop, and produced zero edit-tool calls — confirmed via per-call instrumentation
        // (dead code before that: the harness only logged tool NAMES, never which ones ran).
        // Pruning doesn't help here — it shrinks what gets RE-SENT, not the cumulative usage
        // budgetStop counts — so the fix is pressure, not compression: once over threshold with no
        // mutation yet, tell the model plainly to stop investigating and act on what it has.
        if (opts.mode === 'agent' && maxTurnTokens > 0) {
          const usedSoFar = steps.reduce((n, s) => n + (s.usage?.totalTokens ?? 0), 0);
          const hasMutated = steps.some((s) => (s.toolCalls ?? []).some((tc) => tc.toolName && MUTATING_TOOLS.has(tc.toolName)));
          if (!hasMutated && !budgetNudged && usedSoFar > maxTurnTokens * BUDGET_NUDGE_THRESHOLD) {
            budgetNudged = true;
            diagLog('turn.budgetNudge', `~${usedSoFar}tok > ${Math.round(maxTurnTokens * BUDGET_NUDGE_THRESHOLD)}tok (${Math.round(BUDGET_NUDGE_THRESHOLD * 100)}% of budget) with no mutating call yet — nudging to act now`);
            out.messages = [...(out.messages ?? messages), { role: 'user', content: BUDGET_NUDGE }] as any;
          }
          // Escalation: the nudge above is words, and a weak model can just ignore words — measured
          // live 2026-08-10, a run got the nudge, kept reading anyway (a DIFFERENT file each time,
          // so stuckStop's exact-repeat check never caught it), and only stopped when budgetStop
          // finally killed the whole turn with zero edits attempted. Once further past budget with
          // still no mutation, stop asking and start ENFORCING: restrict this step's tools to only
          // the mutating ones (plus getDiagnostics, so an edit can still be self-checked). The model
          // can no longer physically call another readFile/grep/glob — its only moves are to make
          // the edit or give up and explain why in text. Applied on every remaining step once
          // triggered (not fires-once) — no `mutatingOnly` flag needed since MUTATING_TOOLS check
          // above already turns this off the instant a real edit happens.
          if (!hasMutated && usedSoFar > maxTurnTokens * BUDGET_FORCE_THRESHOLD) {
            const forced = Object.keys(tools).filter((name) => MUTATING_TOOLS.has(name) || name === 'getDiagnostics');
            if (forced.length) {
              if (!budgetForced) {
                budgetForced = true;
                diagLog('turn.budgetForce', `~${usedSoFar}tok > ${Math.round(maxTurnTokens * BUDGET_FORCE_THRESHOLD)}tok (${Math.round(BUDGET_FORCE_THRESHOLD * 100)}% of budget) with no mutating call yet — restricting to [${forced.join(', ')}] only`);
                out.messages = [...(out.messages ?? messages), { role: 'user', content: BUDGET_FORCE_NUDGE }] as any;
              }
              out.activeTools = forced as any;
            }
          }
        }
        return out;
      },
      // Thin forwarders of the SDK's own lifecycle callbacks onto AgentOpts.onStep — no new
      // phase tracking of our own. Deliberately narrow:
      // - onToolExecutionStart/onToolExecutionEnd are NOT forwarded here: the tool-call/
      //   tool-result fullStream parts handled below already drive onTool -> a tool-specific
      //   status label (e.g. "Reading file...") that's strictly more useful than a generic one,
      //   and forwarding both would race two independently-timed signals for the same moment
      //   with no benefit.
      // - onEnd (the current name — onFinish/onStepFinish are @deprecated aliases in ai@7.0.34)
      //   is NOT forwarded either: end-of-turn UI cleanup already happens via the 'busy:false'
      //   backstop once runTurn() returns; there's no distinct "done" status this would add.
      onStart: () => opts.onStep('thinking', 'Thinking…'),
      onStepStart: () => opts.onStep('thinking', 'Thinking…'),
    } as any);


    // ── Two-buffer state machine (speculative draft vs canonical reply) ──────────────
    // A tool call is a MIDDLE step, not a final answer. Text the model emits in a step that ALSO
    // issues a tool call ("Let me search…") is provisional narration — fine to show live as a
    // draft, but it must NEVER become the committed assistant message. AI SDK 7 emits
    // `start-step`/`finish-step` parts, so we know exactly when a step ends and can commit or
    // discard its text by INTENT rather than by fragile heuristics.
    //
    // Phase models the intent the user described:
    //   idle → text → (tool-call) planning → (tool-result) waiting_final → (text) final
    // Only text committed in the FINAL phase (a pure-text step after all tool activity) is
    // eligible to be the permanent reply. liveBuffer streams to the UI as a draft throughout;
    // the webview reconciles the draft → canonical on `assistantMessage`.
    //
    // STREAM ROUTING (the AI SDK "Chain of Thought vs chat" separation, made concrete):
    // Text the model emits inside a step that ALSO issues a tool call is provisional narration
    // ("Let me search…"), NOT chat. We buffer it per-step and decide at `finish-step`: a tool
    // step's buffered text is routed to `onReasoning` (the CoT block) so it surfaces as thinking,
    // never as the chat reply; a pure-text step's buffered text is the answer and streams live to
    // `onChunk`. This is exactly how the AI SDK keeps reasoning out of the message bubble.
    type Phase = 'idle' | 'text' | 'planning' | 'waiting_final' | 'final';
    let phase: Phase = 'idle';
    let finalBuffer = '';    // canonical reply — last pure-text (final-answer) step only
    let stepText = '';       // text accumulated in the CURRENT step (provisional until finish-step)
    let stepChatText = '';   // the subset of stepText that streamed to the CHAT bubble as a draft
    let stepHasTool = false; // current step issued a tool call → its text is narration
    // Per-step live streaming: once we've SEEN a tool call in the current step, further text in
    // this step is narration being generated alongside the tool call — route to reasoning. We
    // can only route text emitted BEFORE the tool call retroactively, at finish-step.
    let streamedThisStep = false; // did we already stream this step's text live to onChunk?
    let streamErrored = false; // an 'error' part arrived on fullStream (routerProvider surfaced a router.route() rejection)
    let streamErrorMessage = '';
    let lastRepetitionCheckLen = 0; // throttles hasDegenerateTextRepetition to ~every 200 chars, not every delta

    for await (const part of (result as any).fullStream) {
      if (part.type === 'start-step') {
        stepIndex++;
        stepText = ''; stepChatText = ''; stepHasTool = false; streamedThisStep = false; lastRepetitionCheckLen = 0;
      } else if (part.type === 'finish-step') {
        // Commit/discard by intent. A pure-text step (no tool call) is an answer step — its text
        // is canonical; the LAST such step wins (earlier ones, if any, are superseded). A tool
        // step's text was narration → route it to reasoning (CoT) instead of the chat reply.
        if (stepHasTool) {
          // Only the part that went to the CHAT bubble needs retrospective routing — text emitted
          // once the step was already known to be a tool step streamed to `onReasoning` delta by
          // delta as it arrived (see text-delta below) and is in `reasoning` already. Re-emitting
          // it here would print it twice in the CoT block, which appends what it receives.
          if (stepChatText.trim()) {
            // Retrospective routing: this text streamed live to the chat bubble as a draft, but
            // the step turned out to be a tool-planning step. Treat it as thinking instead. The
            // webview's toolStatus/reasoning path will render it in the CoT block, and the
            // assistantMessage reconciliation drops the draft bubble.
            reasoning += stepChatText;
            opts.onReasoning(stepChatText);
          }
        } else if (stepText.trim()) {
          finalBuffer = stepText;
          phase = hadToolCalls ? 'final' : 'text';
        }
      } else if (part.type === 'text-delta') {
        const t = part.text ?? part.delta ?? '';
        stepText += t;
        // Stream to chat ONLY if we're confident this step won't issue a tool call: i.e. we're
        // past all tool activity (waiting_final/final), or this is a pure-chat turn (idle/text and
        // no tool has run yet in the turn). Within the FIRST step of a tool turn we can't yet tell,
        // so we buffer until finish-step commits it — that's the one case where live streaming is
        // deferred, and it's exactly the "Let me search…" narration we must not show as chat.
        if (phase === 'waiting_final' || phase === 'final' || phase === 'text' || (phase === 'idle' && !hadToolCalls)) {
          streamedThisStep = true;
          stepChatText += t;
          opts.onChunk(t);
        } else {
          // Narration emitted alongside a tool call (phase 'planning'): its destination is already
          // decided, so stream it to the CoT block delta by delta. Holding it until finish-step —
          // as this branch used to — is why the Thinking block appeared all at once instead of
          // typing out: `reasoning-delta` never fires here (routerProvider emits text parts only),
          // so this text IS the thinking, and one buffered call at the end of the step renders as
          // a single splash.
          reasoning += t;
          opts.onReasoning(t);
        }
        if (phase === 'idle') phase = 'text';
        else if (phase === 'waiting_final') phase = 'final';
        // Pure-text thrash guard — only meaningful before any tool call this step (a step that's
        // already issuing tool calls isn't the degenerate no-progress pattern this catches).
        if (!stepHasTool && stepText.length - lastRepetitionCheckLen >= 200) {
          lastRepetitionCheckLen = stepText.length;
          if (hasDegenerateTextRepetition(stepText)) {
            stopReason = 'stuck';
            diagLog('turn.stop', `stuck: degenerate text repetition detected (~${stepText.length} chars, no tool calls)`);
            break;
          }
        }
      } else if (part.type === 'reasoning-delta') {
        const d = part.text ?? part.delta ?? ''; reasoning += d; opts.onReasoning(d);
      } else if (part.type === 'tool-call') {
        hadToolCalls = true; stepHasTool = true; phase = 'planning';
        if (MUTATING_TOOLS.has(part.toolName)) { hadMutatingToolCall = true; verifiedAfterMutation = false; }
        else if (hadMutatingToolCall && VERIFY_TOOLS.has(part.toolName)) verifiedAfterMutation = true;
        if (PATH_ARG_TOOLS.has(part.toolName)) {
          const p = pathArgOf(part.input);
          if (p) openedFiles.push(p);
        }
        // Record file mutations for the end-of-turn structured recap. `runCommand` is in
        // MUTATING_TOOLS but takes no `path`, so it contributes no entry here (correct — a shell
        // command's file effects aren't reliably knowable from its args).
        if (part.toolName === 'createFile') {
          const p = pathArgOf(part.input); if (p) changedFilesMap.set(p, 'created');
        } else if (part.toolName === 'writeFile' || part.toolName === 'editFile') {
          const p = pathArgOf(part.input); if (p && changedFilesMap.get(p) !== 'created') changedFilesMap.set(p, 'modified');
        } else if (part.toolName === 'deleteFile') {
          const p = pathArgOf(part.input); if (p) changedFilesMap.set(p, 'deleted');
        }
        // If text from THIS step already streamed live to the chat bubble as a tentative reply,
        // it's now revealed to be narration (a tool call arrived in the same step). Retract the
        // draft so it doesn't linger in the chat; the finish-step handler re-routes it to reasoning.
        if (streamedThisStep) opts.onRetractDraft?.();
        opts.onTool({ toolCallId: part.toolCallId, name: part.toolName, args: part.input, state: 'running' });
        // `askQuestions` has no `execute` — no 'tool-result' part will ever arrive for this call,
        // so capture it here and immediately report the card as done (waiting on the user, not
        // "running" forever) instead of leaving it stuck mid-state.
        // Guard on the tool actually being registered for this mode — the raw stream part
        // reports whatever name the model invented, BEFORE repairToolCall/NoSuchToolError even
        // runs, so a model calling this name in agent/ask mode (where it's not offered) must not
        // be treated as a real clarify request just because the string matches.
        if (part.toolName === 'askQuestions' && tools.askQuestions) {
          const raw = (part.input as { questions?: Array<Partial<ClarifyingQuestion>> } | undefined)?.questions;
          if (raw && raw.length) {
            // Normalize: the schema leaves `options` optional (rescued/weak-model calls often
            // omit it entirely) but ClarifyingQuestion.options is a required array everywhere
            // downstream (the same shape parseClarifying's sentinel parser always produced).
            const q: ClarifyingQuestion[] = raw
              .filter((x): x is Partial<ClarifyingQuestion> & { text: string } => !!x.text)
              .map((x) => ({ text: x.text, label: x.label, options: x.options ?? [], ...(x.multi ? { multi: true } : {}) }));
            if (q.length) {
              askQuestionsCall = { toolCallId: part.toolCallId, questions: q };
              // Set directly here rather than relying solely on askQuestionsStop's stopWhen
              // predicate: a no-execute tool call is the SDK's own "nothing to continue with"
              // terminal case, which can end the stream before stopWhen is ever consulted —
              // askQuestionsStop stays as a belt-and-suspenders net, this is the reliable path.
              stopReason = 'askQuestions';
              opts.onTool({ toolCallId: part.toolCallId, name: part.toolName, args: part.input, state: 'done', detail: 'Waiting for the user to answer.' });
            }
          }
        }
      } else if (part.type === 'tool-result') {
        phase = 'waiting_final';
        const detail = typeof part.output === 'string' ? part.output : JSON.stringify(part.output ?? '');
        // Late re-anchoring: keep this file's content so it can be re-shown after pruning evicts
        // the real result. Reads only — mutating results are a few bytes and are never pruned.
        if (reanchorChars > 0 && ANCHOR_TOOLS.has(part.toolName) && typeof detail === 'string') {
          const p = pathArgOf(part.input);
          if (p) anchors.record(p, detail, stepIndex);
        }
        // Pin the file this edit just changed, with its POST-edit content read back from disk.
        // Done on the result (not the call) so the write has actually landed. This is Aider's
        // never-prune-the-working-set idea: the files under active edit outrank merely-read files
        // for the digest's limited slots, and the model sees what the file IS now rather than the
        // pre-edit copy its original readFile returned.
        if (reanchorChars > 0 && PIN_ON_MUTATION_TOOLS.has(part.toolName)) {
          const p = pathArgOf(part.input);
          if (p) {
            try {
              const bytes = await vscode.workspace.fs.readFile(resolveWorkspacePath(p));
              // Same head-of-file rationale as AnchorStore's excerpts, and a hard ceiling so one
              // huge edited file can't monopolise the re-anchor budget before digest() sizes it.
              anchors.pin(p, new TextDecoder().decode(bytes).slice(0, PIN_CONTENT_CAP), stepIndex);
            } catch { /* deleted, binary, or outside the workspace — nothing to pin */ }
          }
        }
        // A SUCCESSFUL completion (not 'tool-error') of one of these means verifyNoteFor already
        // ran inside the tool's own execute() — see SELF_VERIFYING_TOOLS. Only counts for the
        // most recent mutation: an editFile that ran, then ANOTHER editFile that hasn't finished
        // yet, must not inherit the first one's verified status.
        if (SELF_VERIFYING_TOOLS.has(part.toolName) && hadMutatingToolCall) verifiedAfterMutation = true;
        opts.onTool({ toolCallId: part.toolCallId, name: part.toolName, args: part.input, state: 'done', detail });
      } else if (part.type === 'tool-error') {
        phase = 'waiting_final';
        const detail = part.error instanceof Error ? part.error.message : String(part.error ?? 'tool error');
        opts.onTool({ toolCallId: part.toolCallId, name: part.toolName, args: part.input, state: 'error', detail });
      } else if (part.type === 'error') {
        streamErrored = true;
        // AI SDK v7 error parts carry `errorText` (string); accept legacy `error` too.
        const etext = (part as { errorText?: unknown }).errorText;
        streamErrorMessage = typeof etext === 'string' && etext.length > 0
          ? etext
          : ((part as { error?: unknown }).error instanceof Error ? (part.error as Error).message : String((part as { error?: unknown }).error ?? ''));
        opts.onError(streamErrorMessage);
      }
    }

    // Canonical reply = the final-answer step's text. A tool turn with no committed answer stays
    // empty so the forced synthesis turn below fires, rather than showing narration as the answer.
    text = finalBuffer.trim();
    void phase;

    // Read the finish reason AFTER consuming the full stream — the SDK resolves this
    // Promise only once all parts (including tool results) have been emitted.
    // 'max-steps' means stopWhen:isStepCount() fired before the model finished naturally
    // — the caller (chatViewProvider's auto-continue loop + Resume button) needs paused:true
    // to know the run was cut short and can be continued rather than treating it as done.
    let finishReason: string | undefined;
    try { finishReason = await (result as any).finishReason; } catch { /* ignore — non-fatal */ }
    // A budget/stuck stop reports 'max-steps' too, but must NOT be paused: auto-continuing a
    // stuck-or-over-budget run just repeats the waste. Only a genuine step-cap hit is resumable.
    const paused = finishReason === 'max-steps' && !stopReason;

    const steps: any[] = (await (result as any).steps) ?? [];

    // `text` is already the canonical reply (finalBuffer from the state machine above). The steps
    // loop below only reconstructs the internal work transcript (tool calls + results) for memory —
    // it does NOT determine the user-visible answer.
    for (const step of steps) {
      const calls: any[] = step.toolCalls ?? [];
      if (calls.length === 0) continue;
      workMessages.push({
        role: 'assistant',
        content: step.text || null,
        tool_calls: calls.map((tc) => ({ id: tc.toolCallId, type: 'function' as const, function: { name: tc.toolName, arguments: JSON.stringify(tc.input ?? {}) } })),
      });
      const settled = new Set<string>();
      for (const tr of step.toolResults ?? []) {
        workMessages.push({ role: 'tool', content: typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output ?? ''), tool_call_id: tr.toolCallId });
        settled.add(tr.toolCallId);
      }
      // A tool call that THREW is reported as a `tool-error` part on `step.content`, and never
      // appears in `step.toolResults` — in ai@7 `TypedToolError` is a separate type from
      // `TypedToolResult`. Without this pass the failing call stayed an ORPHANED tool_call, which
      // `sanitizeCoreMessages` then deleted wholesale on every later turn (call AND error, since
      // there was no result to pair it with). Net effect: the model had no record that the call
      // was ever attempted or why it failed, so on "try again" it reissued the identical failing
      // call — e.g. an `editFile` whose `search` text didn't match, retried verbatim.
      for (const part of (step.content ?? []) as Array<{ type?: string; toolCallId?: string; error?: unknown }>) {
        if (part?.type !== 'tool-error' || !part.toolCallId || settled.has(part.toolCallId)) continue;
        const msg = part.error instanceof Error ? part.error.message : String(part.error ?? 'unknown error');
        workMessages.push({ role: 'tool', content: `Tool call failed: ${msg}`, tool_call_id: part.toolCallId });
        settled.add(part.toolCallId);
      }
      // Anything STILL unsettled gets a short placeholder, so no tool_call is ever orphaned.
      // Covers `askQuestions` (no `execute`, so it never yields a result) and a call denied by the
      // approval policy (neither a result nor an error). An orphan here violates the same
      // invariant synth-shrink.e2e.ts guards ("no tool-call survives without its result" —
      // AI_MissingToolResultsError). Kept deliberately short: these strings persist in history
      // across every later turn of the session.
      for (const tc of calls) {
        if (settled.has(tc.toolCallId)) continue;
        workMessages.push({
          role: 'tool',
          content: tc.toolName === 'askQuestions' ? 'Clarification requested.' : 'No result was recorded for this tool call.',
          tool_call_id: tc.toolCallId,
        });
        settled.add(tc.toolCallId);
      }
    }
    if (text.trim()) workMessages.push({ role: 'assistant', content: text });

    // FORCE A SYNTHESIS TURN. A tool call is a MIDDLE step, not a final answer. If the model
    // acted (one or more tool calls ran) but produced no natural-language text, the turn would
    // end "silent" — the user sees a queue of ✓ tools and zero words (the exact "agent ended on
    // a bare tool call" gap). Re-prompt with the tool transcript and an explicit instruction to
    // ANSWER NOW, with the tool loop disabled (stopWhen: 1 step, no tools) so the model must
    // produce text. This is the single biggest fix for weak/instruct models that delegate via
    // tools (e.g. explore) and then stop without synthesizing.
    // Skip when askQuestionsCall is set — the model deliberately stopped to ask the user, an
    // empty `text` here is correct (the questions ARE the response), not a synthesis failure.
    if (!text.trim() && hadToolCalls && !paused && !opts.abortSignal?.aborted && !askQuestionsCall) {
      text = await forceSynthesis(languageModel, system, opts, workMessages, (t) => opts.onChunk(t), (d) => { reasoning += d; opts.onReasoning(d); }, stopReason === 'stuck') || text;
      if (text.trim()) workMessages.push({ role: 'assistant', content: text });
    }

    // Last-resort non-empty guarantee: even if synthesis failed/returned nothing, never hand
    // back a blank turn — that reads as the old silent "0 out" symptom. Tell the user plainly.
    // Skip this when paused: a step-cap cutoff mid-task is a normal, resumable state (the caller
    // shows a Resume button), not a failure — stuffing in "couldn't produce a final answer" would
    // directly contradict the paused:true flag returned alongside it.
    // Skip this when streamErrored: `onError` already surfaced the REAL failure reason to the
    // UI (e.g. AllModelsFailedError) — piling a generic "couldn't produce a response" bubble on
    // top of that duplicates the message with a less useful one. The `failed` flag on the return
    // below tells the caller to skip rendering a turn at all, same as the thrown-exception path.
    if (!text.trim() && !paused && !streamErrored && !askQuestionsCall) {
      text = stopReason === 'stuck'
        ? 'Stopped: the model kept repeating the same action without making progress, and couldn\'t summarize its findings either. Try rephrasing the request, or switch models.'
        : hadToolCalls
        ? 'I looked into this and ran some tools, but couldn\'t produce a final answer. Try rephrasing the request, or switch to a stronger model.'
        : 'I wasn\'t able to produce a response. Try rephrasing the request, or switch to a stronger model.';
    }

    // A length-truncated turn (finish_reason: 'length') ends mid-answer with NO error — the model
    // simply ran out of output tokens. Rather than show a clean-looking half-reply (e.g. a plan
    // table whose last columns are empty), auto-continue: re-prompt "resume from the cutoff" and
    // stitch the continuation onto the partial so the user sees the FULL answer. Ask mode is hit
    // hardest — it must emit the whole long-form answer in one stream. Cap continuations so a model
    // stuck in a length loop can't run forever; only surface a notice if the cap is still reached.
    if (finishReason === 'length' && !hadToolCalls && !paused && text.trim() && !opts.abortSignal?.aborted) {
      let guard = 0;
      while (finishReason === 'length' && guard < 4 && !opts.abortSignal?.aborted) {
        guard++;
        const more = await continueAfterTruncation(
          languageModel, system, opts, workMessages,
          (t) => { text += t; opts.onChunk(t); },
          (d) => { reasoning += d; opts.onReasoning(d); },
        );
        if (!more.text.trim()) break;
        // Keep the in-context assistant transcript in sync with the appended continuation.
        const last = workMessages[workMessages.length - 1];
        if (last && last.role === 'assistant') last.content = (typeof last.content === 'string' ? last.content : '') + more.text;
        finishReason = more.finishReason;
      }
      if (finishReason === 'length' && guard >= 4 && text.trim() && !/(truncated|cut off|length limit)/i.test(text)) {
        text = `${text.trim()}\n\n_⚠ Still truncated after several continuations — say "continue" to resume._`;
      }
    }

    return {
      text,
      reasoning: reasoning.trim(),
      platform,
      model,
      runtimeName,
      paused,
      workMessages,
      stopReason,
      askQuestions: askQuestionsCall?.questions,
      hadToolCalls,
      hadMutatingToolCall,
      verifiedAfterMutation,
      openedFiles,
      // A provider/router error (streamErrored, e.g. AllModelsFailedError from a pinned model
      // hitting 403/quota) must surface in the chat even when tool calls already ran this turn —
      // previously the `&& !hadToolCalls` clause let it through as a non-failed empty turn, so the
      // failure only reappeared after closing/reopening the panel (from persisted transcript).
      // Drop that clause: no salvageable answer text + a real error = a failed, surfaced turn.
      failed: streamErrored && !text.trim(),
      errorMessage: streamErrored ? streamErrorMessage : undefined,
      changedFiles: mapChangedFiles(changedFilesMap),
    };
  } catch (err) {
    diagLog('turn.gate', `traceId=${opts.sessionId ?? '<none>'} · CAUGHT aborted=${!!opts.abortSignal?.aborted} isAbort=${isAbortError(err)} err=${err instanceof Error ? err.message : String(err)}`);
    // Only treat as a clean abort if the error is GENUINELY an abort. A real failure
    // (provider rejection, message-shape validation, empty response) that merely
    // coincides with an aborted signal used to vanish here as an empty, error-less
    // turn — the "0 in / 0 out / 0s" silent-idle symptom on follow-up sends. Surface
    // every other error so the user sees what actually went wrong.
    const genuineFailure = !(opts.abortSignal?.aborted && isAbortError(err));
    const errMsg = err instanceof Error ? err.message : String(err);
    // repairToolCall's 3 tiers all gave up and the SDK re-threw instead of feeding the model a
    // normal retryable tool-error (see AI SDK docs: an unrepaired input error is a stream `error`
    // part, not a `tool-error` part). The model never saw why its call failed — worth one more
    // attempt with an explicit nudge (runTurn) instead of dying here on the raw SDK message.
    const toolCallRepairFailed = genuineFailure
      && (InvalidToolInputError.isInstance(err) || NoSuchToolError.isInstance(err) || ToolCallRepairError.isInstance(err));
    if (genuineFailure) {
      opts.onError(errMsg);
    }
    // Report the REAL tool/mutation state, not hardcoded falsies — see the hoisted declarations
    // above. `workMessages` is only assembled after the stream loop, so on this path it can still
    // be empty even though tools ran; `hadMutatingToolCall` is what the retry guards key on, and
    // it is now accurate, so a caught error after a real edit can no longer unlock a duplicate.
    return { text, reasoning: reasoning.trim(), platform, model, runtimeName, paused: false, workMessages, hadToolCalls, hadMutatingToolCall, verifiedAfterMutation, openedFiles, failed: genuineFailure && !text.trim(), errorMessage: genuineFailure ? errMsg : undefined, toolCallRepairFailed, changedFiles: mapChangedFiles(changedFilesMap) };
  }
}

/** Pruning threshold scaled to the model that will actually serve the turn. The flat 12k default
 *  was tuned for the smallest free windows — on any model with a larger context it evicts read
 *  results the model is still actively using (one capped readFile is ~7.5k tokens, so after ~2
 *  reads everything older vanished), which reads to the user as "the agent forgot what it just
 *  looked at". 40% of the window, clamped to [12k, 60k]: small-window models keep the tight
 *  pruning they need, large-window models keep their context. Only used when the user hasn't set
 *  tiermux.agent.pruneAtTokens explicitly — a deliberate value always wins. */
function adaptivePruneAtTokens(router: Router, taskKind: TaskKind): number {
  const cfg = vscode.workspace.getConfiguration('tiermux.agent');
  const base = cfg.get<number>('pruneAtTokens', 12_000);
  if (base <= 0) return 0; // explicitly disabled
  const ins = typeof cfg.inspect === 'function' ? cfg.inspect<number>('pruneAtTokens') : undefined;
  const userSet = ins && (ins.globalValue !== undefined || ins.workspaceValue !== undefined
    || ins.workspaceFolderValue !== undefined || ins.globalLanguageValue !== undefined);
  if (userSet) return base;
  const window = router.peekTopSelection(taskKind)?.model?.contextWindow;
  if (!window || window <= 0) return base;
  return Math.min(Math.max(Math.floor(window * 0.4), 12_000), 60_000);
}

export async function runTurn(router: Router, opts: AgentOpts): Promise<AgentResult> {
  // Hard per-turn token ceiling (0 = off). With the step-count cap removed, this is now the
  // ONLY backstop against a runaway loop besides stuckStop's exact-repeat detection — hence a
  // real non-zero default rather than 0/off. A stuck free-model turn was observed burning
  // ~367k tokens before stuckStop caught it; this caps that kind of run earlier even when
  // stuckStop's narrower exact-repeat check doesn't fire. Default 200k (was 500k): a single turn
  // burning past ~200k is almost always a runaway free-tier loop, and the lower ceiling makes the
  // budget backstop bite well before the user-perceived stall. Large legit multi-file tasks aren't
  // hurt — auto-continue + maxBudgetContinuations still extend the run across rounds.
  const maxTurnTokens = vscode.workspace.getConfiguration('tiermux.agent').get<number>('maxTurnTokens', 200_000);
  // Cap on read-only tool calls before the first mutating one (see explorationStop above). 0 disables.
  const maxExplorationCalls = vscode.workspace.getConfiguration('tiermux.agent').get<number>('maxExplorationCalls', 20);
  // Hard per-turn STEP ceiling (0 = off). With the step-count cap removed, a turn making many
  // DISTINCT mutating tool calls (never exact-repeating, so stuckStop doesn't fire; each is real
  // progress, so explorationStop doesn't fire) can still sprawl indefinitely — only the token
  // budget checked. This is a generous backstop for that gap. Fires as a 'budget' stop (bounded
  // continuation via maxBudgetContinuations, NOT a resumable pause), so a capped turn halts within
  // one continuation rather than segmenting into maxAutoContinueRounds resume loops that would
  // just repeat the work in chunks. Default 50: a legit task rarely exceeds 50 steps in a SINGLE
  // turn (long tasks span auto-continue rounds instead), so this only catches true runaways.
  const maxStepsPerTurn = vscode.workspace.getConfiguration('tiermux.agent').get<number>('maxStepsPerTurn', 50);
  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
  const lastUserText = contentToString(lastUser?.content ?? '');
  // Feed attachment signals so an image (or a text-less/scanned PDF) upgrades the task to 'vision'
  // and the router prefers a vision-capable model. Derived from the BUILT content blocks by MIME, so
  // a doc or a text-extracted PDF (inlined as a text block, not a file block) correctly stays text.
  // Without this, an attached image under Auto could silently land on a text-only model that can't
  // see it — attachmentKindsFromContent was dead code until now.
  const attachmentKinds = lastUser ? attachmentKindsFromContent(lastUser.content) : [];
  // Plan mode always classifies as 'plan' rather than going through classifyTask — that
  // classifier can never return 'plan' (it's not one of its outputs), which silently made
  // the plan-mode quality floor/escalation below unreachable dead code.
  const taskKind = opts.mode === 'plan'
    ? 'plan'
    : await classifyTaskSmart(router, lastUserText, { attachmentKinds, attachments: attachmentKinds.length, mentions: opts.mentionCount });

  // Once the running tool-loop context passes this many tokens, prune stale tool outputs and old
  // reasoning BEFORE each step so a long, tool-heavy turn stops re-sending megabytes of grep/read
  // dumps the model no longer needs. 0 disables. Complements the per-result cap in capOutput.ts:
  // that bounds each result; this evicts whole stale ones from the growing history. Computed here
  // (after taskKind) because the adaptive default scales with the routed model's context window.
  const pruneAtTokens = adaptivePruneAtTokens(router, taskKind);

  // Planner→execute mixture pipeline: for action tasks, first run a read-only planner step that
  // decomposes the task, then hand the plan to the executor as system-prompt guidance AND seed
  // the todo checklist from it (the step-wise completion contract). Skipped for read-only modes
  // (plan/ask already non-mutating), when a model is pinned (respect the explicit choice), and
  // for trivial/chat/vision kinds. The planner is tool-less, so it has no side effects and can't
  // violate the no-retry-after-mutation rule below. Best-effort: a failed/empty planner just
  // yields no plan.
  const mixture = vscode.workspace.getConfiguration('tiermux.agent').get<string>('mixturePipeline', 'auto');
  let planGuidance: string | undefined;
  /** Verify command for the end-of-turn command gate: the planner's explicit `Verify:` line when
   *  the mixture pipeline ran, else auto-detected from the project manifest at gate time. */
  let turnVerifyCommand: string | undefined;
  const mixtureEligible = mixture !== 'off'
    && opts.mode !== 'plan' && opts.mode !== 'ask'
    && !opts.pinnedModel
    && (taskKind === 'agent' || taskKind === 'coding' || taskKind === 'debug' || taskKind === 'longContext');
  if (mixtureEligible) {
    const top = router.peekTopSelection(taskKind);
    const executorRank = top?.model?.intelligenceRank ?? 5;
    // 'auto' now plans for EVERY eligible action task, not just weak executors: the plan is
    // also what seeds the todo checklist (the step-wise completion contract below) and the
    // verify command for the end-of-turn command gate, which a strong executor benefits from
    // just as much — "capable model" and "never drifts from a 6-step task" are not the same
    // claim. 'on' additionally forces the weak-executor scaffold; 'off' skips everything.
    const scaffold = mixture === 'on' || executorRank >= WEAK_EXECUTOR_RANK;
    diagLog('turn.pipeline', `planner step before execute (executor ${top?.entry.platform}/${top?.entry.modelId ?? '?'} rank ${executorRank}, mode=${mixture})`);
    const plan = await runPlannerStep(router, opts);
    let guidance = '';
    if (plan.trim()) {
      guidance += '\n\n## Execution plan (produced by the planner — follow it, adapt as needed)\n' + plan.trim();
    }
    // Seed the visible todo checklist from the plan's own steps (deterministic regex parse via
    // planStepsToTodos — no extra LLM call). Two effects: the user sees the plan as a trackable
    // checklist immediately, and the chatViewProvider auto-continue loop gains its completion
    // contract — the send keeps going until every seeded step is marked completed, so "plan as
    // prompt text only" (the old behavior) can no longer end a turn with steps silently undone.
    // The executor replaces this list the moment it writes its own todowrite, so model-authored
    // plans always win. Only at ≥2 steps: a single-step task needs no checklist, and seeding one
    // would make the auto-continue loop treat a finished turn as incomplete. Each step also
    // carries its difficulty tag (stripped from the visible text) so later rounds route by it.
    const seededSteps = planStepsToTodos(plan);
    if (seededSteps.length >= 2) {
      opts.onTodos(seededSteps.map((t, i) => {
        const { difficulty, content } = stepDifficultyOf(t.content);
        return { content, difficulty, status: i === 0 ? ('in_progress' as const) : t.status };
      }));
      guidance += '\n\nThese plan steps are now your todo checklist. As you complete each step, '
        + 'report the updated list with the `todowrite` tool (marking the finished step `completed` '
        + 'and the next one `in_progress`) — the checklist is what tells the harness you are done.';
    }
    if (scaffold) {
      // REACT_SCAFFOLD goes LAST, after the plan — weak models weight the tail of a system
      // prompt most heavily (recency bias), and "one thought, one action" must not get buried
      // under the plan content.
      guidance += REACT_SCAFFOLD;
    }
    planGuidance = guidance || undefined;
    // The planner names the single command that proves the change works (see PLANNER_SYSTEM).
    // Used in preference to auto-detection by the command gate below; free-text output from an
    // arbitrary model, hence the shape check in plannerVerifyCommand().
    turnVerifyCommand = plannerVerifyCommand(plan);
  } else if (opts.mode !== 'plan' && opts.mode !== 'ask' && isWeakExecutor(router, taskKind)) {
    // The scaffold is about the EXECUTOR's tool-call reliability, so it must not be collateral
    // damage of the planner step being skipped. Pinning a model, or turning the mixture pipeline
    // off, says nothing about that model being strong enough to go without it — and OpenCode
    // ships the same one-tool-per-message rule to every free model unconditionally.
    planGuidance = REACT_SCAFFOLD;
  }
  if (opts.mode === 'plan') {
    // Brainstorm step: only for messages that look like a real task, not a plain question/
    // discussion — PLAN_MODE_TAIL already answers those in prose with no numbered plan, so a
    // fork-in-approach analysis has nothing to attach to. classifyTaskCore's regex kind (not its
    // 'agent' ambiguous-default bias) is enough here: 'chat'/'trivial' means question-shaped.
    const regexKind = classifyTaskCore(lastUserText, { attachmentKinds, attachments: attachmentKinds.length }).kind;
    if (regexKind !== 'chat' && regexKind !== 'trivial') {
      planGuidance = await runBrainstormStep(router, opts);
    }
  }

  // Snapshot workspace errors BEFORE any edit lands, so the end-of-turn workspace verify (below)
  // can tell which errors THIS turn introduced vs. ones the user already had. Captured here, right
  // before the first attempt — anything an earlier turn in this same run left behind is correctly
  // treated as pre-existing (not this turn's responsibility). Cheap: a synchronous getDiagnostics.
  // Defensive: in a headless test harness (or any env with no language server) `vscode.languages`
  // may be undefined — a missing diagnostics API just means no workspace verify, not a crash.
  let baselineErrors: Set<string> | undefined;
  try {
    if (vscode.languages?.getDiagnostics) baselineErrors = workspaceErrorSignatures(vscode.languages.getDiagnostics());
  } catch { /* no diagnostics available — skip workspace verify */ }

  const first = await runAttempt(router, opts, taskKind, pruneAtTokens, maxTurnTokens, maxExplorationCalls, maxStepsPerTurn, undefined, planGuidance);
  let final = first;

  // Tool-call-repair-exhausted retry — repairToolCall's 3 tiers all gave up on a malformed call
  // and the SDK threw instead of feeding the model a normal retryable tool-error (see
  // toolCallRepairFailed's doc comment). The model never saw why it failed, so give it one shot
  // with the raw error named explicitly. `first` already has failed/errorMessage set from the
  // catch path — if the retry doesn't produce anything usable either, that original failure
  // stands as `final` and surfaces exactly as it would have without this retry.
  //
  // Gated on hadMutatingToolCall, NOT hadToolCalls (same rule canEscalate uses): the retry re-runs
  // the turn from the ORIGINAL messages, so a write/delete/command that already landed would be
  // duplicated, while re-running reads is merely wasteful and idempotent. Gating on hadToolCalls
  // would also make this dead in its most common case — a model that reads a file and THEN emits
  // the unrepairable edit call, which is exactly the shape that motivated the retry.
  if (first.toolCallRepairFailed && !first.hadMutatingToolCall && !opts.abortSignal?.aborted) {
    diagLog('turn.forceAction', 'toolCallRepairFailed: retrying with the SDK error named explicitly');
    router.noteToolSoftFailure(first.platform, first.model);
    const nudged: AgentOpts = {
      ...opts,
      messages: [...opts.messages, { role: 'user', content: forceToolRepairNudge(first.errorMessage ?? 'Invalid tool input.') }],
    };
    const retried = await runAttempt(router, nudged, taskKind, pruneAtTokens, maxTurnTokens, maxExplorationCalls, maxStepsPerTurn);
    if (!retried.failed && (retried.hadToolCalls || retried.text.trim())) final = retried;
  }

  // Force-action retry — a weak model announced an action but called NO tool ("Let me read the
  // file and fix it:") and then stopped, so nothing happened and the turn died on a coherent-looking
  // but empty promise (assessAnswerQuality can't catch it — the text is long and well-formed). Only
  // for action task kinds, only when zero tools ran, and not after a budget/stuck stop or abort.
  // Re-invoke the SAME model with the model's own promise plus an explicit "actually do it now"
  // nudge so it follows through instead of re-describing. One retry only; accept whatever it yields.
  const wantsAction = taskKind === 'agent' || taskKind === 'coding' || taskKind === 'debug' || taskKind === 'longContext';
  // Widens the action gate past a misclassified taskKind: a "create/build/write/implement ..." prompt
  // that classifyTaskSmart wrongly read as 'chat'/'trivial' still counts as an action task for the
  // pasted-code / announced-action retries below, so agent mode doesn't accept a text-only answer.
  const actionTask = wantsAction || CREATE_TASK_RE.test(lastUserText);
  // final !== first: the tool-call-repair retry above already spent this turn's one retry.
  const canRetryToolUse = final === first && !first.hadToolCalls && !first.stopReason && !opts.abortSignal?.aborted;
  const announcedNoAction = actionTask && ACTION_INTENT_RE.test(first.text.trim());
  // The "explained + pasted code instead of calling editFile/writeFile" shape — see
  // CODE_FENCE_RE's doc comment. Only for action task kinds (a real 'chat'/'trivial' question is
  // legitimately answered with an example snippet), and only when nothing already explains the
  // miss, so this stays a narrow net rather than firing on every code-containing reply.
  // Agent mode ONLY. `taskKind` comes from classifyTaskSmart for every non-plan mode, so a plain
  // Ask-mode question like "write me a regex for semver" classifies as `coding` and would trip
  // `wantsAction` — but Ask mode has no mutating tool to call, and answering with a fenced snippet
  // is the CORRECT behavior there. Without this gate the retry fired on a good answer and
  // FORCE_ACTION_NUDGE told the model to call tools it hadn't been given.
  const pastedCodeInsteadOfActing = actionTask && opts.mode === 'agent' && !announcedNoAction && CODE_FENCE_RE.test(first.text);
  // "Listed the steps, then asked permission to start" — see ASKS_PERMISSION_RE. Tested against
  // the TAIL only (last 240 chars), so a long report that asks something mid-way is untouched;
  // the signal is that the LAST thing the turn did was ask instead of act. Agent mode only, for
  // the same reason as pastedCodeInsteadOfActing: in Ask/Plan mode offering next steps is correct,
  // and Plan mode has `askQuestions` for genuinely blocking ambiguity.
  const askedPermissionInsteadOfActing = actionTask && opts.mode === 'agent'
    && !announcedNoAction && !pastedCodeInsteadOfActing
    && ASKS_PERMISSION_RE.test(first.text.trim().slice(-240));
  // Declined-websearch fires for ANY taskKind (a plain chat question is exactly where a weak
  // model tells the user to "switch modes" instead of calling the webSearch tool it was given).
  const declinedWebSearch = canRetryToolUse && DECLINED_WEBSEARCH_RE.test(first.text.trim());
  // False capability decline: only meaningful in Agent mode (the only mode with a real
  // runCommand tool to point the model back at). Only classify when the cheaper checks above
  // didn't already explain the miss, so the classify call stays rare.
  let falseCapabilityDecline = false;
  if (canRetryToolUse && opts.mode === 'agent' && !announcedNoAction && !declinedWebSearch && !pastedCodeInsteadOfActing && !askedPermissionInsteadOfActing) {
    falseCapabilityDecline = await detectFalseCapabilityDecline(router, first.text.trim(), opts.abortSignal);
  }
  if (canRetryToolUse && (announcedNoAction || pastedCodeInsteadOfActing || askedPermissionInsteadOfActing || declinedWebSearch || falseCapabilityDecline)) {
    const nudgeText = declinedWebSearch ? FORCE_WEBSEARCH_NUDGE : falseCapabilityDecline ? FORCE_RUNTIME_ACCESS_NUDGE : FORCE_ACTION_NUDGE;
    const reason = declinedWebSearch ? 'declinedWebSearch' : falseCapabilityDecline ? 'falseCapabilityDecline'
      : pastedCodeInsteadOfActing ? 'pastedCodeInsteadOfActing' : askedPermissionInsteadOfActing ? 'askedPermissionInsteadOfActing' : 'announcedNoAction';
    diagLog('turn.forceAction', `${reason}: retrying with a use-the-tool nudge`);
    // Learn-by-failure: announcing an action but calling no tool is a tool-use failure this model
    // "succeeded" (HTTP 200) on. Record a strike so repeat offenders get benched from tool routing.
    router.noteToolSoftFailure(first.platform, first.model);
    const nudged: AgentOpts = {
      ...opts,
      messages: [...opts.messages, { role: 'assistant', content: first.text }, { role: 'user', content: nudgeText }],
    };
    const acted = await runAttempt(router, nudged, taskKind, pruneAtTokens, maxTurnTokens, maxExplorationCalls, maxStepsPerTurn);
    // Take the retry only if it ACTUALLY ACTED. The entire point of a force-action retry is to
    // convert a described action into a performed one; a retry that still called no tool has not
    // done that, and the old `hadToolCalls || text.trim()` accepted it purely for being non-empty
    // — which regularly made the turn WORSE. Observed shapes: "I already gave you the corrected
    // code above." replacing the corrected code, and a declined-websearch retry re-explaining the
    // refusal. The ungrounded retry below already uses this stricter rule; match it. The only
    // exception is a first attempt with no text at all, where any text beats blank (defensive —
    // every trigger above requires non-empty text, so this shouldn't be reachable today).
    if (acted.hadToolCalls || (!first.text.trim() && acted.text.trim())) final = acted;
  }

  // Announced-action-but-stopped AFTER tools already ran. The force-action retry above is gated on
  // `!first.hadToolCalls` (zero tools), so a model that did real work — e.g. a runCommand that
  // landed — then ended on "Let me check the workspace structure first." with NO follow-up tool call
  // sails through untouched: the announcement becomes the final answer and the agent stops mid-plan
  // (observed 2026-08-13). ACTION_INTENT_RE still matches the tail, so detect it here and CONTINUE
  // from `first.workMessages` (the turn's own transcript) rather than restarting from opts.messages.
  // Restarting would discard the work already done and risk re-running prior (possibly mutating)
  // calls from scratch; continuing keeps that work in context and just nudges the model to perform
  // the ONE action it announced. Same model, one shot, accepted only if it actually made a tool call.
  const announcedAfterWork = final === first && first.hadToolCalls
    && !first.stopReason && !opts.abortSignal?.aborted
    && wantsAction && ACTION_INTENT_RE.test(first.text.trim());
  if (announcedAfterWork) {
    diagLog('turn.forceAction', `announcedNoAction after prior tool calls: continuing with a use-the-tool nudge`);
    router.noteToolSoftFailure(first.platform, first.model);
    const nudged: AgentOpts = {
      ...opts,
      messages: [...opts.messages, ...first.workMessages, { role: 'user', content: FORCE_CONTINUE_ACTION_NUDGE }],
    };
    const acted = await runAttempt(router, nudged, taskKind, pruneAtTokens, maxTurnTokens, maxExplorationCalls, maxStepsPerTurn);
    // Take the continuation only if it actually performed the announced action (a tool call ran) —
    // a retry that just re-describes the plan or answers in prose has not advanced anything.
    if (acted.hadToolCalls) final = acted;
  }

  // Pasted-code-after-reads — the single most common "all talk, no action" shape on weaker models:
  // it gathered context (read/grep/list tools ran, so hadToolCalls is true), then answered by
  // PASTING the implementation as a code fence instead of calling createFile/editFile. The zero-tool
  // force-action path above can't reach it (its `canRetryToolUse` gate requires !hadToolCalls), and
  // `announcedAfterWork` only matches an action-INTENT phrase at the tail (ACTION_INTENT_RE), not a
  // pasted block — so a coherent reply ending in prose slipped through both. Detect it here: reads
  // happened, NO mutating tool ran (nothing was built), and the answer contains a fenced code block.
  // Continue from the turn's own transcript (reads already done — don't redo them) with a "create
  // the file now" nudge. Agent mode + action task only; Ask/Plan legitimately answer with snippets.
  // `actionTask` (defined above) already widens the gate past a misclassified taskKind.
  const pastedCodeAfterReads = final === first && first.hadToolCalls && !first.hadMutatingToolCall
    && !first.stopReason && !opts.abortSignal?.aborted
    && actionTask && opts.mode === 'agent' && CODE_FENCE_RE.test(first.text);
  if (pastedCodeAfterReads) {
    diagLog('turn.forceAction', `pastedCodeAfterReads: model answered with a code block instead of creating the file — continuing with a create-it nudge`);
    router.noteToolSoftFailure(first.platform, first.model);
    const nudged: AgentOpts = {
      ...opts,
      messages: [...opts.messages, ...first.workMessages, { role: 'assistant', content: first.text }, { role: 'user', content: FORCE_PASTE_TO_ACTION_NUDGE }],
    };
    const acted = await runAttempt(router, nudged, taskKind, pruneAtTokens, maxTurnTokens, maxExplorationCalls, maxStepsPerTurn);
    // Accept only if a MUTATING tool ran — the point is to convert a pasted block into a real file
    // change, not to accept another read-only re-description.
    if (acted.hadMutatingToolCall) final = acted;
  }

  // Quality-based escalation — restores a pipeline that existed under the old OpenCode-backed
  // engine (assessAnswerQuality → maybeEscalateWeak → tryEscalate → onFailover) and was lost in
  // the migration to this native loop. Only safe when NO mutating tool call happened yet: once a
  // write/edit/delete/command has actually run, retrying with a different model would either
  // repeat that side effect or silently strand it — never retry past that point. Also skipped
  // when the user pinned a specific model (not Auto): escalation drops pinnedModel (see the
  // `escalation ? undefined : opts.pinnedModel` above) and free-picks among top-tier models, so
  // running it on a pinned turn would silently execute the reply on a model the user never chose.
  // Ungrounded-answer retry. Ask and Plan exist to answer ABOUT THIS PROJECT, so a turn that
  // answered without opening a single file did it from memory — and a free model's memory of a
  // repo it has never seen is invention. Measured (2026-08-09 human simulation): turns 2-4 each
  // made ZERO tool calls, and one answered "yes, I verified" while citing constants that exist
  // nowhere in the codebase. The chatViewProvider grounding check could not catch it: it lives in
  // the UI layer, so every non-UI caller had no protection, and it only fires on a subject-term
  // mismatch — a confident invention that echoes the subject sails through.
  const readOnlyMode = opts.mode === 'ask' || opts.mode === 'plan';
  const canRetryUngrounded = readOnlyMode && final === first && !first.hadToolCalls
    && taskKind !== 'trivial' && !first.stopReason && !opts.abortSignal?.aborted && first.text.trim()
    // Only when the answer actually asserts things about THIS repo. A plain-prose answer that
    // opened nothing may be perfectly correct, and re-running every such turn would double the
    // cost of Ask mode on rate-limited free tiers for no gain.
    && CLAIMS_CODE_IDENTIFIERS.test(first.text);
  if (canRetryUngrounded) {
    diagLog('turn.ungrounded', `${opts.mode} answer with zero retrieval calls — retrying with a read-the-code nudge`);
    // No noteToolSoftFailure strike, unlike the force-action path: a question that genuinely needs
    // no project file is legitimate in Ask mode. The retry is the correction.
    const nudged: AgentOpts = {
      ...opts,
      messages: [...opts.messages, { role: 'assistant', content: first.text }, { role: 'user', content: FORCE_GROUND_NUDGE }],
    };
    const grounded = await runAttempt(router, nudged, taskKind, pruneAtTokens, maxTurnTokens, maxExplorationCalls, maxStepsPerTurn);
    // Only take the retry if it actually went and looked, AND a real comparison judge (not a
    // word-count heuristic) confirms it's actually the better answer to the ORIGINAL question —
    // a "go read the code" nudge can come back with a terse, on-a-tangent "here's what I found
    // in file X" that answers a sub-question instead of the one the user asked. Measured
    // complaint (2026-08-20): a good first answer got replaced by a short unrelated one after
    // this retry fired on a normal, correct, code-referencing answer.
    if (grounded.hadToolCalls && grounded.text.trim()) {
      const cmp = await compareAnswers(router, lastUserText, first.text, grounded.text, `${first.platform}::${first.model}`);
      if (cmp.pick === 'B') final = grounded;
      else diagLog('turn.ungrounded', `comparison judge kept the original over the grounded retry (${cmp.reason})`);
    }
  }

  // Excludes an askQuestions turn: its empty `text` is correct (the questions ARE the response,
  // not a synthesis gap), so quality.weak would otherwise misjudge it and escalate away the
  // model's deliberate clarify request instead of surfacing it to the user.
  const canEscalate = final === first && !first.hadMutatingToolCall && !opts.abortSignal?.aborted
    && !opts.pinnedModel && first.platform && first.model && !first.askQuestions;
  if (canEscalate) {
    const quality = assessAnswerQuality(first.text, taskKind);
    let shouldEscalate = first.stopReason === 'stuck' || quality.weak;
    let escalateWhy = quality.primary ? `quality:${quality.primary}` : (first.stopReason ?? '');
    // Static heuristics are deliberately conservative (they avoid false positives on terse-but-
    // correct answers), so a plausible-sounding non-answer can slip past them. When they pass but
    // the model produced only text with no side effects, run a semantic FULFILLMENT judge on a
    // different, stronger model: "did this reply actually complete the request?" If not, escalate
    // so a capable model finishes the work — the non-static check the keyword patterns can't do.
    // Skipped when heuristics already flagged it (no point judging a known-bad answer) and for
    // conversational task kinds (chat/ask/vision) where a follow-up question is legitimate.
    // Also skipped for a CLEAN answer (no quality signal at all and comfortably past the word
    // floor) — spending a full extra top-tier model call to double-check an answer the cheap
    // heuristics found nothing wrong with is not worth the cost/latency on every single reply.
    // The judge earns its keep on the borderline cases: some signal fired but not enough to
    // escalate alone, or the answer is short enough that "plausible but incomplete" is plausible.
    // Deterministic: a create/edit task (make/build/write/fix/… in the request) that the model
    // answered with a code block in chat but NO tool call — it showed the code instead of writing
    // the file, so nothing was actually built. Escalate directly to a model that will use the
    // tools, without spending a judge call. Discussion requests (explain/review/show me) don't
    // match CREATE_TASK_RE, so a legit "show me an example" reply is left alone.
    if (!shouldEscalate && !first.hadMutatingToolCall
        && (taskKind === 'agent' || taskKind === 'coding' || taskKind === 'debug' || taskKind === 'longContext')
        && first.text.includes('```') && CREATE_TASK_RE.test(lastUserText)) {
      shouldEscalate = true;
      escalateWhy = 'showed-code-no-tool';
      router.noteToolSoftFailure(first.platform, first.model);
    }
    const judgeFloor = (TASK_WORD_FLOOR[taskKind as Exclude<typeof taskKind, 'trivial'>] ?? 12) * 1.5;
    const judgeWords = first.text.trim().split(/\s+/).filter(Boolean).length;
    const borderline = quality.score > 0 || judgeWords < judgeFloor;
    if (!shouldEscalate && borderline && JUDGEABLE_TASK_KINDS.has(taskKind) && first.text.trim()) {
      const excludeKey = `${first.platform}::${first.model}`;
      const judge = await judgeFulfillment(router, lastUserText, first.text, taskKind, excludeKey);
      if (!judge.fulfilled) {
        shouldEscalate = true;
        escalateWhy = `unfulfilled:${judge.reason.slice(0, 48)}`;
      }
    }
    if (shouldEscalate) {
      const excludeKey = `${first.platform}::${first.model}`;
      diagLog('turn.escalate', `${escalateWhy} from ${excludeKey} (score=${quality.score} signals=${quality.signals.join(',')} stopReason=${first.stopReason ?? 'none'}) — retrying with a different model`);
      const escalated = await runAttempt(router, opts, taskKind, pruneAtTokens, maxTurnTokens, maxExplorationCalls, maxStepsPerTurn, {
        excludeModels: [excludeKey],
        maxIntelligenceRank: 2, // top-tier models only — the point of escalating is a smarter retry
      }, planGuidance);
      // Keep the escalated attempt if it produced something — but when the ONLY reason we
      // escalated was the semantic fulfillment judge, confirm with a real comparison first.
      //
      // The split matters. `quality.weak` / `stuck` / `showed-code-no-tool` are deterministic
      // signals that the first answer is genuinely bad, so replacing it is safe and comparing
      // would just risk keeping a known-bad answer (compareAnswers deliberately defaults to the
      // original on any failure). `unfulfilled:` is a single LLM opinion and the one path prone
      // to false positives on terse-but-correct answers — and escalation re-runs from
      // `opts.messages` with no memory of `first`, so an unchecked swap there is exactly how a
      // good answer got replaced by a short, unrelated one (measured complaint 2026-08-20).
      if (escalated.text.trim()) {
        if (!escalateWhy.startsWith('unfulfilled:')) final = escalated;
        else {
          const cmp = await compareAnswers(router, lastUserText, first.text, escalated.text, excludeKey);
          if (cmp.pick === 'B') final = escalated;
          else diagLog('turn.escalate', `comparison judge kept the original over the judge-triggered retry (${cmp.reason})`);
        }
      }
    }
  }

  // Self-correct retry (Ralph-Wiggum-style) — an edit/write tool call's own verifyNoteFor check
  // found a NEW diagnostic error right after the edit, surfaced as text in that tool's result.
  // Bounded to exactly one retry regardless of outcome — this never loops. Only ever considers
  // `final`'s OWN mutating tool call: escalation above is mutually exclusive with this (it
  // requires !hadMutatingToolCall), so there's no risk of double-retrying the same turn.
  const lastDiagnosticNote = final.hadMutatingToolCall
    ? [...final.workMessages].reverse().find((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes(NEW_DIAGNOSTICS_MARKER))
    : undefined;
  const canSelfCorrect = !!lastDiagnosticNote && !opts.abortSignal?.aborted && !final.stopReason;
  if (canSelfCorrect) {
    diagLog('turn.selfCorrect', 'edit/write introduced a new diagnostic error — retrying once with a fix-it nudge');
    const nudged: AgentOpts = {
      ...opts,
      messages: [
        ...opts.messages,
        ...final.workMessages,
        ...(final.text.trim() ? [{ role: 'assistant' as const, content: final.text }] : []),
        { role: 'user', content: SELF_CORRECT_NUDGE },
      ],
    };
    const corrected = await runAttempt(router, nudged, taskKind, pruneAtTokens, maxTurnTokens, maxExplorationCalls, maxStepsPerTurn);
    // Accept the retry's own outcome whatever it is (fixed, still broken, or gave up) — the
    // point is one genuine attempt to self-correct, not a guarantee of a clean result. Only
    // guard against regressing to a totally blank turn.
    if (corrected.text.trim() || corrected.hadToolCalls) final = corrected;
  }

  // Workspace-wide verify retry — the per-edit verifyNoteFor check above only sees the file that
  // was just edited. An edit can break a DIFFERENT file (rename a symbol used elsewhere, change a
  // shared type) whose error never appears in any single edit's tool result. After the work settles,
  // diff the workspace diagnostics against the pre-turn baseline: any NEW errors were introduced by
  // this turn. Bounded to exactly one retry, independent of the self-correct retry above (which keys
  // on the per-edit marker) — so a cross-file break the per-edit check missed still gets one fix
  // attempt. Never loops.
  if (final.hadMutatingToolCall && !opts.abortSignal?.aborted && !final.stopReason && baselineErrors) {
    let newErrs: string[] = [];
    try { newErrs = newErrorsSince(baselineErrors, await waitForWorkspaceDiagnosticsSettled()); }
    catch { /* diagnostics API unavailable — skip */ }
    if (newErrs.length) {
      diagLog('turn.verifyWs', `${newErrs.length} new workspace error(s) after this turn's edits — retrying once to fix`);
      const wsNudge: AgentOpts = {
        ...opts,
        messages: [
          ...opts.messages,
          ...final.workMessages,
          ...(final.text.trim() ? [{ role: 'assistant' as const, content: final.text }] : []),
          { role: 'user', content: `${SELF_CORRECT_NUDGE}\n\nNew errors introduced elsewhere in the workspace by your edits:\n${newErrs.join('\n')}` },
        ],
      };
      const corrected = await runAttempt(router, wsNudge, taskKind, pruneAtTokens, maxTurnTokens, maxExplorationCalls, maxStepsPerTurn);
      // Merge changedFiles so the recap reflects the fix attempt too — snapshotting the
      // pre-retry set first, since `final` is about to become `corrected` (which knows only
      // about its own edits).
      const preRetryChanged = final.changedFiles;
      if (corrected.text.trim() || corrected.hadToolCalls) final = corrected;
      if (corrected.changedFiles) final = { ...final, changedFiles: mergeChangedFiles(preRetryChanged, corrected.changedFiles) };
    }
  }

  // Command verify gate — the checks above prove the edited files PARSE (LSP diagnostics); this
  // one proves the project still WORKS. After a mutating turn settles, actually run the verify
  // command (the planner's explicit `Verify:` pick, else auto-detected from the project manifest
  // — package.json scripts / Makefile / Cargo.toml / …; `tiermux.agent.verifyCommand` overrides
  // or disables). A non-zero exit feeds the failure output back for exactly ONE self-correct
  // retry, then the command is re-run once; if it still fails, the final answer carries a
  // deterministic failure note instead of letting an untested "done" stand. `ok === null` (could
  // not run: declined, disabled, timed out, no command detected) is "no signal" — never treated
  // as a failure. This is the fleet pipeline's worker gate (implementPipeline.ts verifyCommand)
  // applied to the single-agent path, with the command auto-detected so the model can't skip it
  // by never naming one.
  const verifyCmd = turnVerifyCommand ?? resolveVerifyCommand();
  let verifyGateFailed: string | null = null;
  // Exposed on AgentResult.verifyOutcome: the step engine keys on 'failed' to refuse accepting
  // a "completed" checklist whose verify command still fails.
  let verifyOutcome: 'passed' | 'failed' | 'unverified' | undefined;
  if (final.hadMutatingToolCall && !final.stopReason && !opts.abortSignal?.aborted && verifyCmd) {
    opts.onStep('verifying', `Verifying with ${verifyCmd}…`);
    let run = await runVerifyCommand(verifyCmd);
    if (run.ok === false) {
      diagLog('turn.verifyCmd', `${verifyCmd} exited non-zero after this turn's edits — retrying once with the failure output`);
      const nudged: AgentOpts = {
        ...opts,
        messages: [
          ...opts.messages,
          ...final.workMessages,
          ...(final.text.trim() ? [{ role: 'assistant' as const, content: final.text }] : []),
          { role: 'user', content: `${VERIFY_FAILED_NUDGE}\n\nCommand: \`${verifyCmd}\`\n\nOutput:\n\`\`\`\n${run.output.slice(0, 4000)}\n\`\`\`` },
        ],
      };
      const corrected = await runAttempt(router, nudged, taskKind, pruneAtTokens, maxTurnTokens, maxExplorationCalls, maxStepsPerTurn);
      // Snapshot BEFORE `final` is replaced: the retry's result carries only ITS own edits, so
      // merging after the swap would merge corrected into corrected and silently drop the files
      // the first attempt already changed from the "Files changed" recap.
      const preRetryChanged = final.changedFiles;
      if (corrected.text.trim() || corrected.hadToolCalls) final = corrected;
      if (corrected.changedFiles) final = { ...final, changedFiles: mergeChangedFiles(preRetryChanged, corrected.changedFiles) };
      // Re-check only when the fix attempt actually changed something — re-running an
      // unchanged workspace can only reproduce the same failure and waste the timeout.
      if (corrected.hadMutatingToolCall && !opts.abortSignal?.aborted) {
        opts.onStep('verifying', `Re-running ${verifyCmd}…`);
        run = await runVerifyCommand(verifyCmd);
      }
    }
    if (run.ok === true) {
      // Observed pass — stronger than any LLM self-report, so it also satisfies the
      // unverified-claim backstop below.
      final = { ...final, verifiedAfterMutation: true };
      verifyOutcome = 'passed';
    } else if (run.ok === false) {
      verifyGateFailed = verifyCmd;
      verifyOutcome = 'failed';
    }
  } else if (final.hadMutatingToolCall) {
    // A mutating turn with no verify command available — honest "we don't know" signal for the
    // step engine (distinct from both passed and failed).
    verifyOutcome = 'unverified';
  }

  // Honesty backstop: the turn edited files, declared the problem solved, and never ran anything
  // that could have proved it wrong. Flag it rather than letting the claim stand unqualified —
  // see UNVERIFIED_CLAIM_CAVEAT for why this is deterministic instead of prompt-only. A failed
  // command gate above replaces this weaker caveat with the observed failure.
  let finalText = final.text;
  if (verifyGateFailed) {
    diagLog('turn.verifyCmd', `verify command still failing after fix attempt — appending failure note`);
    finalText += `\n\n> ❌ **Verification failed** — \`${verifyGateFailed}\` still exits non-zero after a fix attempt. `
      + 'The changes above are on disk but not proven to work; re-run the command to see the remaining failure.';
  } else if (final.hadMutatingToolCall && !final.verifiedAfterMutation && COMPLETION_CLAIM_RE.test(finalText)) {
    diagLog('turn.unverified', 'completion claim with no verify tool after the last mutating call — appending caveat');
    finalText += UNVERIFIED_CLAIM_CAVEAT;
  }

  // Guaranteed recap: a mutating turn should always end with a summary of what changed. If the
  // model's own final text already recaps the changes, leave it; otherwise run one short synthesis
  // pass to produce a recap (streamed live above the deterministic footer the host appends from
  // changedFiles). Skipped on abort/stuck/budget stops — a stopReason terminal turn isn't "done".
  const changedFiles = mergeChangedFiles(undefined, final.changedFiles);
  if (final.hadMutatingToolCall && !final.stopReason && !opts.abortSignal?.aborted && changedFiles?.length && !alreadyRecaps(finalText, changedFiles)) {
    diagLog('turn.recap', 'mutating turn ended without a change summary — synthesizing one');
    const recap = await recapChanges(router, opts, final.workMessages, changedFiles);
    if (recap) finalText = finalText.trim() ? `${finalText.trim()}\n\n${recap}` : recap;
  }

  // Deterministic "Files changed" footer — a compact, always-present recap of WHICH files changed
  // (the synthesis above is the prose WHAT). Appended (and streamed live) only when the final text
  // doesn't already list the files, so a turn that already named them isn't duplicated. This is the
  // guarantee that a mutating turn always surfaces what it changed, independent of model prose.
  if (changedFiles?.length && !alreadyRecaps(finalText, changedFiles) && !opts.abortSignal?.aborted) {
    const byStatus = (st: 'created' | 'modified' | 'deleted') => changedFiles.filter((f) => f.status === st).map((f) => f.path);
    const parts: string[] = [];
    const created = byStatus('created'), modified = byStatus('modified'), deleted = byStatus('deleted');
    if (created.length) parts.push(`created: ${created.join(', ')}`);
    if (modified.length) parts.push(`modified: ${modified.join(', ')}`);
    if (deleted.length) parts.push(`deleted: ${deleted.join(', ')}`);
    const footer = `\n\n**Files changed** — ${parts.join('; ')}.`;
    finalText += footer;
    opts.onChunk(footer);
  }

  // Carry what this turn established into the next one. Done here, after every retry/escalation
  // path has settled on `final`, so a discarded attempt's reads don't get promoted into a
  // standing fact. recordFindings itself refuses any path that isn't a real file.
  recordFindings(opts.sessionId, final.openedFiles, finalText);

  return {
    text: finalText,
    reasoning: final.reasoning || undefined,
    platform: final.platform,
    model: final.model,
    runtimeName: final.runtimeName,
    taskKind,
    paused: final.paused,
    stopReason: final.stopReason,
    askQuestions: final.askQuestions,
    workMessages: final.workMessages.length ? final.workMessages : undefined,
    changedFiles,
    verifyOutcome,
    // Only meaningful when nothing downstream salvaged the turn — every retry/escalation path
    // above already overwrites `final` with a candidate that has real text or tool calls, so a
    // surviving `failed` here means every attempt genuinely came back empty after an error.
    // Deliberately NOT gated on `!final.hadToolCalls`: a tool call running earlier in the turn
    // doesn't make a later stream error (e.g. AllModelsFailedError) any less real — see the
    // matching comment in runAttempt's own `failed` computation above.
    failed: final.failed && !final.text.trim(),
    errorMessage: final.errorMessage,
  };
}
