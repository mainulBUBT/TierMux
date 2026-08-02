

// The agent turn: thin streamText() wiring, not a hand-rolled loop. Consumes the SDK's own
// stream directly (verified empirically to carry text-delta/reasoning-delta/tool-call/
// tool-result/tool-error/tool-approval-* parts in the expected order — see the plan's spike
// notes) and maps them onto the existing AgentOpts callbacks. No custom iteration, no custom
// permission gate, no custom hook system.
import { streamText, wrapLanguageModel, isStepCount, pruneMessages } from 'ai';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { Router } from '../../router/router';
import type { ChatMessage, ChatContentBlock } from '../../shared/types';
import type { AgentOpts, AgentResult } from '../agent';
import { classifyTask, attachmentKindsFromContent, type TaskKind } from '../routing';
import { assessAnswerQuality, TASK_WORD_FLOOR } from '../answerQuality';
import { judgeFulfillment, JUDGEABLE_TASK_KINDS } from '../fulfillment';
import { contentToString } from '../content';
import { buildSystemPrompt } from '../promptBuilder';
import { createRouterProvider } from './routerProvider';
import { createTelemetryMiddleware } from './middleware/telemetry';
import { createToolApproval, MUTATING_TOOLS } from './policies/permission';
import { createToolSet } from './tools';
import { getMcpManager } from './tools/mcp/manager';
import { NEW_DIAGNOSTICS_MARKER } from './tools/workspace/formatDiagnostics';
import { diagLog } from '../../util/diag';

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
  for (const block of content) {
    if (typeof block === 'string') { if (block) parts.push({ type: 'text', text: block }); continue; }
    const filePart = toFilePart(block);
    if (filePart) { parts.push(filePart); continue; }
    if (typeof block.text === 'string' && block.text) parts.push({ type: 'text', text: block.text });
  }
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
  + 'write your final answer to the user now — clear, plain language, no tool calls. Summarize '
  + 'what you did and what you found, and directly address the user\'s original request.';

/** System-prompt tail used instead of SYNTH_SUFFIX when the turn ended via stuckStop/budgetStop
 *  (loop.ts's stopReason) rather than finishing naturally — the model did NOT complete the task,
 *  so asking it to "give your final answer" would read as false completion. Ask for a progress
 *  report instead: what it found/concluded, and what's still unresolved. */
const SYNTH_SUFFIX_STUCK =
  '\n\nYou were stopped before finishing — you got stuck repeating the same action without making '
  + 'progress. Using ONLY what you learned from the tool results above, tell the user what you '
  + 'found/concluded so far and what is still unresolved. Do NOT claim the task is complete — this '
  + 'is a progress report, not a final answer.';

/** A reply that ENDS on an announced action ("…let me read the file and fix it:") — a weak model's
 *  classic "all talk, no action" turn. Matched only at the tail so a genuine explanation that
 *  merely mentions an action mid-text doesn't trip it. Combined with hadToolCalls===false in
 *  runTurn to detect a turn that promised work but called no tool. */
const ACTION_INTENT_RE = /\b(let me|i'?ll|i will|let'?s|i'?m going to|now i'?ll|i can|i'?d|i should|let me go ahead and)\b[^.!?\n]*\b(read|open|look at|inspect|examine|check|review|fix|edit|update|change|modify|rewrite|replace|implement|create|add|remove|delete|run|execute|search|grep|find|explore|apply|write)\b[^.!?\n]*[:.]?\s*$/i;

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

/** Nudge appended (as a user turn) when an edit/write tool call's own verifyNoteFor check found a
 *  NEW diagnostic error right after the edit (Ralph-Wiggum-style self-correct). The diagnostic
 *  text is already in context (it's part of the tool result in workMessages) — this just tells
 *  the model to act on it instead of finishing with a broken file. */
const SELF_CORRECT_NUDGE =
  'The edit you just made introduced a new error, reported above in the tool result. Fix it now: '
  + 'read the surrounding code if you need to, then correct the error with another edit before '
  + 'finishing. Do not just acknowledge the error — actually fix it.';

/** The user's request asks to PRODUCE something (a file/feature/change), not just discuss it.
 *  Used to detect the "model showed the code in chat but never called writeFile/editFile" failure:
 *  a create/edit task answered with a code block and no tool call means nothing was actually built,
 *  so runTurn escalates to a model that will use the tools. Discussion verbs (explain/review/show)
 *  are deliberately excluded — those legitimately produce text/code without a tool call. */
const CREATE_TASK_RE = /\b(?:make|create|build|write|add|fix|implement|develop|generate|set ?up|put together|scaffold|generate|produce|write me|build me|create me)\b/i;

/** Intelligence rank at/above which an executor counts as "weak" for the planner→execute
 *  pipeline — rank 3+ means a mid-tier-or-worse model will serve the turn, so a planner step
 *  that decomposes the task first is worth its latency. Lower = smarter; 1 is frontier. */
const WEAK_EXECUTOR_RANK = 3;

/** System prompt for the planner step of the mixture pipeline. The planner is a read-only,
 *  single-step call routed to a `planner`-tagged model (via taskKind 'plan') that decomposes
 *  the task into an execution plan WITHOUT calling tools or executing anything — its output is
 *  appended to the executor's system prompt as guidance. Keeping it tool-less is what makes the
 *  pipeline safe: no side effects, so it can never collide with the no-retry-after-mutation rule. */
const PLANNER_SYSTEM =
  'You are a planning model. Decompose the user\'s task into a concise, ordered execution plan: '
  + 'the goal, the relevant files/paths to touch, concrete steps in order, and edge cases to watch. '
  + 'Do NOT execute, write code, or call tools — only produce the plan. Be specific and brief.\n\n'
  + 'Example — task: "add a loading spinner to the submit button":\n'
  + 'Goal: show a spinner on the submit button while the form request is in flight.\n'
  + 'Files: src/components/SubmitButton.tsx, src/components/SubmitButton.css\n'
  + 'Steps:\n'
  + '1. Add an `isLoading` prop to SubmitButton and disable the button when true.\n'
  + '2. Render a spinner element in place of the label when isLoading is true.\n'
  + '3. Pass isLoading from the form\'s submit-in-flight state into SubmitButton.\n'
  + 'Edge cases: rapid double-submit while loading; spinner must clear on request failure, not just success.';

/**
 * Forced synthesis turn — run after the main loop when the model acted via tools but produced no
 * final text. Re-invokes the SAME routed model with the full tool transcript plus an explicit
 * "answer now" instruction, with the tool loop disabled (single step, no tools) so the only way
 * out is natural-language text. Returns "" if it also yields nothing (caller applies a fallback).
 *
 * `onChunk`/`onReasoning` keep streaming the synthesis live into the UI as if it were a normal
 * answer turn — the user sees "Writing answer…" then the text, not a silent stall.
 */
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
    const messages = toCoreMessages([...opts.messages, ...workMessages]);
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
    for await (const part of (synth as any).fullStream) {
      if (part.type === 'text-delta') { const t = part.text ?? part.delta ?? ''; out += t; onChunk(t); }
      else if (part.type === 'reasoning-delta') { const d = part.text ?? part.delta ?? ''; onReasoning(d); }
      else if (part.type === 'error') { break; }
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

/** Extra instruction appended AFTER the plan (not before) in the executor's system prompt when
 *  the mixture pipeline is active — weak models weight the tail of a system prompt most heavily,
 *  and the one thing that must not get buried is "one thought, one action per turn", the ReAct
 *  pattern most consistently credited for tool-call reliability on small/free models. */
const REACT_SCAFFOLD =
  '\n\nBefore each action, write one short line starting "Thought:" stating what you are about to '
  + 'do and why, then either call exactly one tool or give your final answer. Do not describe '
  + 'multiple future steps in the same turn — one thought, one action.';

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
  stopReason?: 'budget' | 'stuck';
  hadToolCalls: boolean;
  /** True if any write/create/edit/delete/runCommand tool call happened this attempt — once
   *  true, retrying with a different model is unsafe (side effects already occurred), so
   *  runTurn must not escalate past this attempt. */
  hadMutatingToolCall: boolean;
  /** Set when the attempt ended via the genuine-error catch path (not abort) with no text —
   *  `onError` already surfaced a message to the UI; runTurn must not also report success. */
  failed?: boolean;
  /** The failure text, same as what went to `onError` — carried through so the caller can show
   *  it as a real reply bubble instead of leaving the user with only the thin error notice. */
  errorMessage?: string;
}

async function runAttempt(
  router: Router,
  opts: AgentOpts,
  taskKind: TaskKind,
  pruneAtTokens: number,
  maxTurnTokens: number,
  maxExplorationCalls: number,
  escalation?: { excludeModels: string[]; maxIntelligenceRank: number },
  planGuidance?: string,
): Promise<AttemptResult> {
  // Loop-control stop conditions beyond the step cap. `stopReason` is set by whichever custom
  // condition fires so the finish handling below can treat it as TERMINAL (not paused) — these
  // are "the model is stuck / over budget" stops, and auto-continuing them would just repeat the
  // waste. Kept out of the paused→auto-continue path on purpose.
  let stopReason: 'budget' | 'stuck' | undefined;
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
  // Exact-repeat detection (above) misses the more common weak-model failure: re-searching the
  // SAME thing with slightly different wording each time ("submitproduct", "submitProduct",
  // "submit") — never an exact duplicate, so it never trips stuckStop, yet zero real progress
  // (no mutating tool call) happens. With no step-count cap anymore, this can now run
  // indefinitely. Cap read-only tool calls made before the FIRST mutating call — past this many,
  // the model is thrashing on exploration, not investigating.
  const explorationStop = ({ steps }: { steps: Array<{ toolCalls?: Array<{ toolName?: string }> }> }): boolean => {
    if (maxExplorationCalls <= 0) return false;
    let readOnlyCount = 0;
    for (const s of steps) {
      for (const tc of s.toolCalls ?? []) {
        if (!tc.toolName) continue;
        if (MUTATING_TOOLS.has(tc.toolName)) return false; // real progress happened — no cap
        readOnlyCount++;
      }
    }
    if (readOnlyCount > maxExplorationCalls) {
      stopReason = 'stuck';
      diagLog('turn.stop', `stuck: ${readOnlyCount} read-only tool calls with zero mutating progress`);
      return true;
    }
    return false;
  };

  let platform: string | undefined;
  let model: string | undefined;
  let runtimeName: string | undefined;

  const provider = createRouterProvider(router, {
    effort: opts.effort,
    taskKind,
    // An escalation retry must not stay pinned to the model the user (or a prior attempt)
    // picked — that would just repeat the same weak/stuck answer. Auto-select among the
    // excluded/higher-tier candidates instead.
    pinnedModel: escalation ? undefined : opts.pinnedModel,
    excludeModels: escalation?.excludeModels,
    maxIntelligenceRank: escalation?.maxIntelligenceRank,
    onFailover: opts.onFailover,
    onKeyRotated: opts.onKeyRotated,
    onModelSelected: (p, m, rt) => { platform = p; model = m; runtimeName = rt; opts.onModel(p, m, rt); },
    onSelectionRationale: opts.onSelectionRationale,
  });
  const languageModel = wrapLanguageModel({
    model: provider,
    middleware: createTelemetryMiddleware({ profiler: opts.profiler, traceId: opts.sessionId as any }),
  });

  const system = (await buildSystemPrompt(opts.mode, taskKind)) + (planGuidance ?? '');
  diagLog('turn.gate', `traceId=${opts.sessionId ?? '<none>'} · buildSystemPrompt done`);
  const tools = createToolSet(opts, getMcpManager(), router);
  diagLog('turn.gate', `traceId=${opts.sessionId ?? '<none>'} · createToolSet done (${Object.keys(tools).length} tools)`);

  let text = '';
  let reasoning = '';
  const workMessages: ChatMessage[] = [];

  try {
    diagLog('turn.gate', `traceId=${opts.sessionId ?? '<none>'} · streamText starting`);
    const result = streamText({
      model: languageModel,
      system,
      messages: toCoreMessages(opts.messages) as any,
      tools: tools as any,
      toolApproval: createToolApproval(opts) as any,
      // No hard step-count cap — a long multi-step task no longer pauses just for running past an
      // arbitrary iteration count (see the Resume-button "paused" path, now unreachable for a
      // normal in-progress task). budgetStop/stuckStop are the remaining backstops against a
      // genuinely runaway/stuck turn — the abortSignal (Stop button) is always available too.
      stopWhen: [budgetStop, stuckStop, explorationStop],
      abortSignal: opts.abortSignal,
      // Per-step context compression (AI SDK native). Runs before each model call in the tool
      // loop; only rewrites history once it exceeds the threshold, so short turns are untouched.
      // Keeps the last 2 messages' tool outputs (the model's active working set) and the most
      // recent reasoning, dropping older ones — the SDK keeps the result well-formed (call+result
      // pruned together), so this can't reintroduce the orphaned-tool-call shape sanitize fixes.
      prepareStep: pruneAtTokens > 0
        ? ({ messages }: { messages: CoreMessage[] }) => {
            const before = roughTokens(messages);
            if (before < pruneAtTokens) return {};
            const pruned = pruneMessages({
              messages: messages as any,
              reasoning: 'before-last-message',
              toolCalls: 'before-last-2-messages',
              emptyMessages: 'remove',
            }) as unknown as CoreMessage[];
            diagLog('turn.prune', `~${before}tok ≥ ${pruneAtTokens} → pruned ${messages.length}→${pruned.length} msgs (~${roughTokens(pruned)}tok)`);
            return { messages: pruned as any };
          }
        : undefined,
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

    let hadToolCalls = false;
    let hadMutatingToolCall = false;

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
    let stepHasTool = false; // current step issued a tool call → its text is narration
    // Per-step live streaming: once we've SEEN a tool call in the current step, further text in
    // this step is narration being generated alongside the tool call — route to reasoning. We
    // can only route text emitted BEFORE the tool call retroactively, at finish-step.
    let streamedThisStep = false; // did we already stream this step's text live to onChunk?
    let streamErrored = false; // an 'error' part arrived on fullStream (routerProvider surfaced a router.route() rejection)
    let streamErrorMessage = '';

    for await (const part of (result as any).fullStream) {
      if (part.type === 'start-step') {
        stepText = ''; stepHasTool = false; streamedThisStep = false;
      } else if (part.type === 'finish-step') {
        // Commit/discard by intent. A pure-text step (no tool call) is an answer step — its text
        // is canonical; the LAST such step wins (earlier ones, if any, are superseded). A tool
        // step's text was narration → route it to reasoning (CoT) instead of the chat reply.
        if (stepHasTool) {
          if (stepText.trim()) {
            // Retrospective routing: this text streamed live to the chat bubble as a draft, but
            // the step turned out to be a tool-planning step. Treat it as thinking instead. The
            // webview's toolStatus/reasoning path will render it in the CoT block, and the
            // assistantMessage reconciliation drops the draft bubble.
            reasoning += stepText;
            opts.onReasoning(stepText);
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
          opts.onChunk(t);
        }
        if (phase === 'idle') phase = 'text';
        else if (phase === 'waiting_final') phase = 'final';
      } else if (part.type === 'reasoning-delta') {
        const d = part.text ?? part.delta ?? ''; reasoning += d; opts.onReasoning(d);
      } else if (part.type === 'tool-call') {
        hadToolCalls = true; stepHasTool = true; phase = 'planning';
        if (MUTATING_TOOLS.has(part.toolName)) hadMutatingToolCall = true;
        // If text from THIS step already streamed live to the chat bubble as a tentative reply,
        // it's now revealed to be narration (a tool call arrived in the same step). Retract the
        // draft so it doesn't linger in the chat; the finish-step handler re-routes it to reasoning.
        if (streamedThisStep) opts.onRetractDraft?.();
        opts.onTool({ toolCallId: part.toolCallId, name: part.toolName, args: part.input, state: 'running' });
      } else if (part.type === 'tool-result') {
        phase = 'waiting_final';
        const detail = typeof part.output === 'string' ? part.output : JSON.stringify(part.output ?? '');
        opts.onTool({ toolCallId: part.toolCallId, name: part.toolName, args: part.input, state: 'done', detail });
      } else if (part.type === 'tool-error') {
        phase = 'waiting_final';
        const detail = part.error instanceof Error ? part.error.message : String(part.error ?? 'tool error');
        opts.onTool({ toolCallId: part.toolCallId, name: part.toolName, args: part.input, state: 'error', detail });
      } else if (part.type === 'error') {
        streamErrored = true;
        streamErrorMessage = part.error instanceof Error ? part.error.message : String(part.error);
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
      for (const tr of step.toolResults ?? []) {
        workMessages.push({ role: 'tool', content: typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output ?? ''), tool_call_id: tr.toolCallId });
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
    if (!text.trim() && hadToolCalls && !paused && !opts.abortSignal?.aborted) {
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
    if (!text.trim() && !paused && !streamErrored) {
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
      hadToolCalls,
      hadMutatingToolCall,
      failed: streamErrored && !text.trim() && !hadToolCalls,
      errorMessage: streamErrored ? streamErrorMessage : undefined,
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
    if (genuineFailure) {
      opts.onError(errMsg);
    }
    return { text, reasoning: reasoning.trim(), platform, model, runtimeName, paused: false, workMessages, hadToolCalls: false, hadMutatingToolCall: false, failed: genuineFailure && !text.trim(), errorMessage: genuineFailure ? errMsg : undefined };
  }
}

export async function runTurn(router: Router, opts: AgentOpts): Promise<AgentResult> {
  // Once the running tool-loop context passes this many tokens, prune stale tool outputs and old
  // reasoning BEFORE each step so a long, tool-heavy turn stops re-sending megabytes of grep/read
  // dumps the model no longer needs. 0 disables. Complements the per-result cap in capOutput.ts:
  // that bounds each result; this evicts whole stale ones from the growing history.
  const pruneAtTokens = vscode.workspace.getConfiguration('tiermux.agent').get<number>('pruneAtTokens', 12000);
  // Hard per-turn token ceiling (0 = off). With the step-count cap removed, this is now the
  // ONLY backstop against a runaway loop besides stuckStop's exact-repeat detection — hence a
  // real non-zero default rather than 0/off. A stuck free-model turn was observed burning
  // ~367k tokens before stuckStop caught it; this caps that kind of run earlier even when
  // stuckStop's narrower exact-repeat check doesn't fire.
  const maxTurnTokens = vscode.workspace.getConfiguration('tiermux.agent').get<number>('maxTurnTokens', 500_000);
  // Cap on read-only tool calls before the first mutating one (see explorationStop above). 0 disables.
  const maxExplorationCalls = vscode.workspace.getConfiguration('tiermux.agent').get<number>('maxExplorationCalls', 20);
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
    : classifyTask(lastUserText, { attachmentKinds, attachments: attachmentKinds.length });

  // Planner→execute mixture pipeline: when the best executor for this task is weak (or the user
  // forces 'on'), first run a read-only planner step that decomposes the task, then hand the plan
  // to the executor as system-prompt guidance. Skipped for read-only modes (plan/ask already
  // non-mutating), when a model is pinned (respect the explicit choice), and for trivial/chat/vision
  // kinds. The planner is tool-less, so it has no side effects and can't violate the no-retry-after-
  // mutation rule below. Best-effort: a failed/empty planner just yields no plan.
  const mixture = vscode.workspace.getConfiguration('tiermux.agent').get<string>('mixturePipeline', 'auto');
  let planGuidance: string | undefined;
  const mixtureEligible = mixture !== 'off'
    && opts.mode !== 'plan' && opts.mode !== 'ask'
    && !opts.pinnedModel
    && (taskKind === 'agent' || taskKind === 'coding' || taskKind === 'debug' || taskKind === 'longContext');
  if (mixtureEligible) {
    const top = router.peekTopSelection(taskKind);
    const executorRank = top?.model?.intelligenceRank ?? 5;
    const weak = mixture === 'on' || executorRank >= WEAK_EXECUTOR_RANK;
    if (weak) {
      diagLog('turn.pipeline', `planner step before execute (executor ${top?.entry.platform}/${top?.entry.modelId ?? '?'} rank ${executorRank}, mode=${mixture})`);
      const plan = await runPlannerStep(router, opts);
      let guidance = '';
      if (plan.trim()) {
        guidance += '\n\n## Execution plan (produced by the planner — follow it, adapt as needed)\n' + plan.trim();
      }
      // REACT_SCAFFOLD goes LAST, after the plan — weak models weight the tail of a system
      // prompt most heavily (recency bias), and "one thought, one action" must not get buried
      // under the plan content.
      guidance += REACT_SCAFFOLD;
      planGuidance = guidance;
    }
  }

  const first = await runAttempt(router, opts, taskKind, pruneAtTokens, maxTurnTokens, maxExplorationCalls, undefined, planGuidance);
  let final = first;

  // Force-action retry — a weak model announced an action but called NO tool ("Let me read the
  // file and fix it:") and then stopped, so nothing happened and the turn died on a coherent-looking
  // but empty promise (assessAnswerQuality can't catch it — the text is long and well-formed). Only
  // for action task kinds, only when zero tools ran, and not after a budget/stuck stop or abort.
  // Re-invoke the SAME model with the model's own promise plus an explicit "actually do it now"
  // nudge so it follows through instead of re-describing. One retry only; accept whatever it yields.
  const wantsAction = taskKind === 'agent' || taskKind === 'coding' || taskKind === 'debug' || taskKind === 'longContext';
  const canRetryToolUse = !first.hadToolCalls && !first.stopReason && !opts.abortSignal?.aborted;
  const announcedNoAction = wantsAction && ACTION_INTENT_RE.test(first.text.trim());
  // Declined-websearch fires for ANY taskKind (a plain chat question is exactly where a weak
  // model tells the user to "switch modes" instead of calling the webSearch tool it was given).
  const declinedWebSearch = canRetryToolUse && DECLINED_WEBSEARCH_RE.test(first.text.trim());
  if (canRetryToolUse && (announcedNoAction || declinedWebSearch)) {
    const nudgeText = declinedWebSearch ? FORCE_WEBSEARCH_NUDGE : FORCE_ACTION_NUDGE;
    diagLog('turn.forceAction', declinedWebSearch
      ? 'declined to search the web despite having webSearch — retrying with a use-the-tool nudge'
      : 'announced an action but made no tool call — retrying with an act-now nudge');
    // Learn-by-failure: announcing an action but calling no tool is a tool-use failure this model
    // "succeeded" (HTTP 200) on. Record a strike so repeat offenders get benched from tool routing.
    router.noteToolSoftFailure(first.platform, first.model);
    const nudged: AgentOpts = {
      ...opts,
      messages: [...opts.messages, { role: 'assistant', content: first.text }, { role: 'user', content: nudgeText }],
    };
    const acted = await runAttempt(router, nudged, taskKind, pruneAtTokens, maxTurnTokens, maxExplorationCalls);
    // Prefer the retry only if it actually acted or produced non-empty text — never regress to blank.
    if (acted.hadToolCalls || acted.text.trim()) final = acted;
  }

  // Quality-based escalation — restores a pipeline that existed under the old OpenCode-backed
  // engine (assessAnswerQuality → maybeEscalateWeak → tryEscalate → onFailover) and was lost in
  // the migration to this native loop. Only safe when NO mutating tool call happened yet: once a
  // write/edit/delete/command has actually run, retrying with a different model would either
  // repeat that side effect or silently strand it — never retry past that point.
  const canEscalate = final === first && !first.hadMutatingToolCall && !opts.abortSignal?.aborted && first.platform && first.model;
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
      const escalated = await runAttempt(router, opts, taskKind, pruneAtTokens, maxTurnTokens, maxExplorationCalls, {
        excludeModels: [excludeKey],
        maxIntelligenceRank: 2, // top-tier models only — the point of escalating is a smarter retry
      }, planGuidance);
      // Keep the escalated attempt only if it actually produced something — an empty/failed
      // retry is worse than the first attempt's own (already-synthesized) progress report.
      if (escalated.text.trim()) final = escalated;
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
    const corrected = await runAttempt(router, nudged, taskKind, pruneAtTokens, maxTurnTokens, maxExplorationCalls);
    // Accept the retry's own outcome whatever it is (fixed, still broken, or gave up) — the
    // point is one genuine attempt to self-correct, not a guarantee of a clean result. Only
    // guard against regressing to a totally blank turn.
    if (corrected.text.trim() || corrected.hadToolCalls) final = corrected;
  }

  return {
    text: final.text,
    reasoning: final.reasoning || undefined,
    platform: final.platform,
    model: final.model,
    runtimeName: final.runtimeName,
    taskKind,
    paused: final.paused,
    stopReason: final.stopReason,
    workMessages: final.workMessages.length ? final.workMessages : undefined,
    // Only meaningful when nothing downstream salvaged the turn — every retry/escalation path
    // above already overwrites `final` with a candidate that has real text or tool calls, so a
    // surviving `failed` here means every attempt genuinely came back empty after an error.
    failed: final.failed && !final.text.trim() && !final.hadToolCalls,
    errorMessage: final.errorMessage,
  };
}
