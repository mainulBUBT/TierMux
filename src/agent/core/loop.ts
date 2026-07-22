

// The agent turn: thin streamText() wiring, not a hand-rolled loop. Consumes the SDK's own
// stream directly (verified empirically to carry text-delta/reasoning-delta/tool-call/
// tool-result/tool-error/tool-approval-* parts in the expected order — see the plan's spike
// notes) and maps them onto the existing AgentOpts callbacks. No custom iteration, no custom
// permission gate, no custom hook system.
import { streamText, wrapLanguageModel, isStepCount } from 'ai';
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

function toCoreMessages(messages: ChatMessage[]): CoreMessage[] {
  return messages.map((m): CoreMessage => {
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
      return { role: 'tool', content: [{ type: 'tool-result', toolCallId: m.tool_call_id ?? '', output: { type: 'text', value: contentToString(m.content) } }] };
    }
    if (m.role === 'user') {
      return { role: 'user', content: toUserContent(m.content) };
    }
    return { role: m.role, content: contentToString(m.content) };
  });
}

export async function runTurn(router: Router, opts: AgentOpts): Promise<AgentResult> {
  const maxIterations = vscode.workspace.getConfiguration('tiermux.agent').get<number>('maxIterations', 25);
  const lastUserText = contentToString([...opts.messages].reverse().find((m) => m.role === 'user')?.content ?? '');
  const taskKind = classifyTask(lastUserText);

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
  const tools = createToolSet(opts, getMcpManager());

  let text = '';
  let reasoning = '';
  const workMessages: ChatMessage[] = [];

  try {
    const result = streamText({
      model: languageModel,
      system,
      messages: toCoreMessages(opts.messages) as any,
      tools: tools as any,
      toolApproval: createToolApproval(opts) as any,
      stopWhen: isStepCount(maxIterations),
      abortSignal: opts.abortSignal,
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
      workMessages: workMessages.length ? workMessages : undefined,
    };
  } catch (err) {
    if (opts.abortSignal?.aborted) return { text, reasoning: reasoning.trim() || undefined, platform, model, runtimeName };
    opts.onError(err instanceof Error ? err.message : String(err));
    return { text, reasoning: reasoning.trim() || undefined, platform, model, runtimeName };
  }
}
