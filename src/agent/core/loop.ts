

// The agent turn: thin streamText() wiring, not a hand-rolled loop. Consumes the SDK's own
// stream directly (verified empirically to carry text-delta/reasoning-delta/tool-call/
// tool-result/tool-error/tool-approval-* parts in the expected order — see the plan's spike
// notes) and maps them onto the existing AgentOpts callbacks. No custom iteration, no custom
// permission gate, no custom hook system.
import { streamText, wrapLanguageModel, isStepCount, pruneMessages } from 'ai';
import * as vscode from 'vscode';
import type { Router } from '../../router/router';
import type { ChatMessage, ChatContentBlock } from '../../shared/types';
import type { AgentOpts, AgentResult } from '../agent';
import { classifyTask, type TaskKind } from '../routing';
import { assessAnswerQuality } from '../answerQuality';
import { contentToString } from '../content';
import { buildSystemPrompt } from '../promptBuilder';
import { createRouterProvider } from './routerProvider';
import { createTelemetryMiddleware } from './middleware/telemetry';
import { createToolApproval, MUTATING_TOOLS } from './policies/permission';
import { createToolSet } from './tools';
import { getMcpManager } from './tools/mcp/manager';
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
}

async function runAttempt(
  router: Router,
  opts: AgentOpts,
  taskKind: TaskKind,
  pruneAtTokens: number,
  maxTurnTokens: number,
  maxExplorationCalls: number,
  escalation?: { excludeModels: string[]; maxIntelligenceRank: number },
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

  const system = await buildSystemPrompt(opts.mode, taskKind);
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
        opts.onError(part.error instanceof Error ? part.error.message : String(part.error));
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
    if (!text.trim() && !paused) {
      text = stopReason === 'stuck'
        ? 'Stopped: the model kept repeating the same action without making progress, and couldn\'t summarize its findings either. Try rephrasing the request, or switch models.'
        : hadToolCalls
        ? 'I looked into this and ran some tools, but couldn\'t produce a final answer. Try rephrasing the request, or switch to a stronger model.'
        : 'I wasn\'t able to produce a response. Try rephrasing the request, or switch to a stronger model.';
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
    };
  } catch (err) {
    diagLog('turn.gate', `traceId=${opts.sessionId ?? '<none>'} · CAUGHT aborted=${!!opts.abortSignal?.aborted} isAbort=${isAbortError(err)} err=${err instanceof Error ? err.message : String(err)}`);
    // Only treat as a clean abort if the error is GENUINELY an abort. A real failure
    // (provider rejection, message-shape validation, empty response) that merely
    // coincides with an aborted signal used to vanish here as an empty, error-less
    // turn — the "0 in / 0 out / 0s" silent-idle symptom on follow-up sends. Surface
    // every other error so the user sees what actually went wrong.
    if (!(opts.abortSignal?.aborted && isAbortError(err))) {
      opts.onError(err instanceof Error ? err.message : String(err));
    }
    return { text, reasoning: reasoning.trim(), platform, model, runtimeName, paused: false, workMessages, hadToolCalls: false, hadMutatingToolCall: false };
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
  const lastUserText = contentToString([...opts.messages].reverse().find((m) => m.role === 'user')?.content ?? '');
  const taskKind = classifyTask(lastUserText);

  const first = await runAttempt(router, opts, taskKind, pruneAtTokens, maxTurnTokens, maxExplorationCalls);
  let final = first;

  // Quality-based escalation — restores a pipeline that existed under the old OpenCode-backed
  // engine (assessAnswerQuality → maybeEscalateWeak → tryEscalate → onFailover) and was lost in
  // the migration to this native loop. Only safe when NO mutating tool call happened yet: once a
  // write/edit/delete/command has actually run, retrying with a different model would either
  // repeat that side effect or silently strand it — never retry past that point.
  const canEscalate = !first.hadMutatingToolCall && !opts.abortSignal?.aborted && first.platform && first.model;
  if (canEscalate) {
    const quality = assessAnswerQuality(first.text, taskKind);
    if (first.stopReason === 'stuck' || quality.weak) {
      const excludeKey = `${first.platform}::${first.model}`;
      diagLog('turn.escalate', `weak/stuck answer from ${excludeKey} (score=${quality.score} signals=${quality.signals.join(',')} stopReason=${first.stopReason ?? 'none'}) — retrying with a different model`);
      const escalated = await runAttempt(router, opts, taskKind, pruneAtTokens, maxTurnTokens, maxExplorationCalls, {
        excludeModels: [excludeKey],
        maxIntelligenceRank: 2, // top-tier models only — the point of escalating is a smarter retry
      });
      // Keep the escalated attempt only if it actually produced something — an empty/failed
      // retry is worse than the first attempt's own (already-synthesized) progress report.
      if (escalated.text.trim()) final = escalated;
    }
  }

  return {
    text: final.text,
    reasoning: final.reasoning || undefined,
    platform: final.platform,
    model: final.model,
    runtimeName: final.runtimeName,
    taskKind,
    paused: final.paused,
    workMessages: final.workMessages.length ? final.workMessages : undefined,
  };
}
