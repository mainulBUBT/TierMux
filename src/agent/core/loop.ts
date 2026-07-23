

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
import { classifyTask } from '../routing';
import { contentToString } from '../content';
import { buildSystemPrompt } from '../promptBuilder';
import { createRouterProvider } from './routerProvider';
import { createTelemetryMiddleware } from './middleware/telemetry';
import { createToolApproval } from './policies/permission';
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

export async function runTurn(router: Router, opts: AgentOpts): Promise<AgentResult> {
  const maxIterations = vscode.workspace.getConfiguration('tiermux.agent').get<number>('maxIterations', 25);
  // Once the running tool-loop context passes this many tokens, prune stale tool outputs and old
  // reasoning BEFORE each step so a long, tool-heavy turn stops re-sending megabytes of grep/read
  // dumps the model no longer needs. 0 disables. Complements the per-result cap in capOutput.ts:
  // that bounds each result; this evicts whole stale ones from the growing history.
  const pruneAtTokens = vscode.workspace.getConfiguration('tiermux.agent').get<number>('pruneAtTokens', 12000);
  // Hard per-turn token ceiling (0 = off). A safety cap against a runaway loop burning the whole
  // free-tier budget; distinct from maxIterations (which counts steps, not tokens).
  const maxTurnTokens = vscode.workspace.getConfiguration('tiermux.agent').get<number>('maxTurnTokens', 0);
  const lastUserText = contentToString([...opts.messages].reverse().find((m) => m.role === 'user')?.content ?? '');
  const taskKind = classifyTask(lastUserText);

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

  let platform: string | undefined;
  let model: string | undefined;
  let runtimeName: string | undefined;

  const provider = createRouterProvider(router, {
    effort: opts.effort,
    taskKind,
    pinnedModel: opts.pinnedModel,
    onFailover: opts.onFailover,
    onKeyRotated: opts.onKeyRotated,
    onModelSelected: (p, m, rt) => { platform = p; model = m; runtimeName = rt; opts.onModel(p, m, rt); },
    onSelectionRationale: opts.onSelectionRationale,
  });
  const languageModel = wrapLanguageModel({
    model: provider,
    middleware: createTelemetryMiddleware({ profiler: opts.profiler, traceId: opts.sessionId as any }),
  });

  const system = await buildSystemPrompt(opts.mode);
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
      stopWhen: [isStepCount(maxIterations), budgetStop, stuckStop],
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

    for await (const part of (result as any).fullStream) {
      if (part.type === 'text-delta') { text += part.text ?? part.delta ?? ''; opts.onChunk(part.text ?? part.delta ?? ''); }
      else if (part.type === 'reasoning-delta') { const d = part.text ?? part.delta ?? ''; reasoning += d; opts.onReasoning(d); }
      else if (part.type === 'tool-call') {
        opts.onTool({ toolCallId: part.toolCallId, name: part.toolName, args: part.input, state: 'running' });
      } else if (part.type === 'tool-result') {
        const detail = typeof part.output === 'string' ? part.output : JSON.stringify(part.output ?? '');
        opts.onTool({ toolCallId: part.toolCallId, name: part.toolName, args: part.input, state: 'done', detail });
      } else if (part.type === 'tool-error') {
        const detail = part.error instanceof Error ? part.error.message : String(part.error ?? 'tool error');
        opts.onTool({ toolCallId: part.toolCallId, name: part.toolName, args: part.input, state: 'error', detail });
      } else if (part.type === 'error') {
        opts.onError(part.error instanceof Error ? part.error.message : String(part.error));
      }
    }

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
    if (stopReason === 'stuck' && !text.trim()) {
      // The model looped on the same tool call and produced no answer — say so instead of
      // returning a blank turn (which reads like the old silent "0 out" symptom).
      text = 'Stopped: the model kept repeating the same action without making progress. Try rephrasing the request, or switch models.';
    }

    const steps: any[] = (await (result as any).steps) ?? [];
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

    return {
      text,
      reasoning: reasoning.trim() || undefined,
      platform,
      model,
      runtimeName,
      taskKind,
      paused,
      workMessages: workMessages.length ? workMessages : undefined,
    };
  } catch (err) {
    diagLog('turn.gate', `traceId=${opts.sessionId ?? '<none>'} · CAUGHT aborted=${!!opts.abortSignal?.aborted} isAbort=${isAbortError(err)} err=${err instanceof Error ? err.message : String(err)}`);
    // Only treat as a clean abort if the error is GENUINELY an abort. A real failure
    // (provider rejection, message-shape validation, empty response) that merely
    // coincides with an aborted signal used to vanish here as an empty, error-less
    // turn — the "0 in / 0 out / 0s" silent-idle symptom on follow-up sends. Surface
    // every other error so the user sees what actually went wrong.
    if (opts.abortSignal?.aborted && isAbortError(err)) {
      return { text, reasoning: reasoning.trim() || undefined, platform, model, runtimeName, paused: false };
    }
    opts.onError(err instanceof Error ? err.message : String(err));
    return { text, reasoning: reasoning.trim() || undefined, platform, model, runtimeName, paused: false };
  }
}
