// v3 engine (plan step 4) — the production runTurn that replaces core/loop.ts's 1,358 LOC.
// TierMux is the policy/orchestration layer; the AI SDK is the execution engine:
//   - streamText owns parsing/validation, tool execution, the multi-step loop, abort, and
//     execute-error wrapping (Path B).
//   - This file owns: message conversion, the mode-filtered toolset, the permission policy
//     (toolApproval), malformed-call self-correction (repairToolCall, Path A), compaction
//     (prepareStep), the 50-step cap (stopWhen), and AgentResult assembly.

import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type ToolSet,
  type LanguageModel,
} from 'ai';
import type { ChatMessage, ChatContentBlock } from '../../shared/types';
import type { AgentOpts, AgentResult, ToolEvent } from '../agent';
import { createRouterProvider } from './routerProvider';
import { buildV3ToolSet } from './tools/v3';
import { makeRepairViaModelSelfCorrection } from './repair';
import { compactIfNeeded } from './compact';
import { resolvePolicy, policyFromSettings } from '../../permissions/policy';
import { composeSystemPrompt } from '../../context/system';
import { diagLog } from '../../util/diag';

/** Compaction budget: ~32K tokens. The adaptive per-window scaling died with executionProfile;
 *  a sane mid-range constant keeps long turns from evicting the task on small free models. */
const COMPACT_BUDGET_TOKENS = 32_768;

// ── Wire-format conversion (OpenAI ChatMessage ↔ AI SDK ModelMessage) ──────────

function blocksToUserContent(content: ChatContentBlock[] | string): string | Array<{ type: 'text'; text: string } | { type: 'file'; data: string; mediaType: string }> {
  if (typeof content === 'string') return content;
  const parts: Array<{ type: 'text'; text: string } | { type: 'file'; data: string; mediaType: string }> = [];
  for (const b of content) {
    if (typeof b === 'string') { parts.push({ type: 'text', text: b }); continue; }
    if (b?.type === 'text' && typeof b.text === 'string') {
      parts.push({ type: 'text', text: b.text });
    } else if (b?.type === 'image_url') {
      const url = (b as { image_url?: { url?: string } }).image_url?.url ?? '';
      if (url.startsWith('data:')) {
        const mediaType = url.slice(5, url.indexOf(';')) || 'image/png';
        parts.push({ type: 'file', data: url, mediaType });
      }
    }
    // Raw PDF `file` blocks: dropped here — the old extractAttachments pipeline converted
    // them host-side before they ever reached the engine; v3.1 restores that flow.
  }
  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
}

/** ModelMessage assistant content is string | parts; narrow once, reuse everywhere. */
function assistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<{ type?: string; text?: string }>)
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
}

export function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  // toolName lookup for tool messages (the OpenAI wire shape carries only tool_call_id).
  const nameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string' && m.content) out.push({ role: 'system', content: m.content });
    } else if (m.role === 'user') {
      out.push({ role: 'user', content: blocksToUserContent(m.content ?? '') });
    } else if (m.role === 'assistant') {
      const text = assistantText(m.content);
      const calls = (m.tool_calls ?? []).map((tc) => {
        nameById.set(tc.id, tc.function.name);
        let input: unknown;
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = {}; }
        return { type: 'tool-call' as const, toolCallId: tc.id, toolName: tc.function.name, input };
      });
      const parts: Array<{ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }> = [];
      if (text) parts.push({ type: 'text', text });
      out.push({ role: 'assistant', content: [...parts, ...calls] });
    } else if (m.role === 'tool') {
      const name = nameById.get(m.tool_call_id ?? '') ?? 'tool';
      const value = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      out.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: m.tool_call_id ?? '', toolName: name, output: { type: 'text', value } }] });
    }
  }
  return out;
}

/** ModelMessage[] → ChatMessage[] (for AgentResult.workMessages — the host persists the
 *  OpenAI-wire shape in its session transcripts). */
function toChatMessages(messages: ModelMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: m.content });
    } else if (m.role === 'user') {
      const text = typeof m.content === 'string' ? m.content : m.content.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('');
      out.push({ role: 'user', content: text });
    } else if (m.role === 'assistant') {
      const text = assistantText(m.content);
      const calls = (Array.isArray(m.content) ? m.content : [])
        .filter((p): p is { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown } => p?.type === 'tool-call')
        .map((p) => ({ id: p.toolCallId, type: 'function' as const, function: { name: p.toolName, arguments: JSON.stringify(p.input ?? {}) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (m.role === 'tool') {
      for (const part of m.content) {
        if (part.type === 'tool-result') {
          const value = typeof part.output === 'string' ? part.output
            : (part.output as { type?: string; value?: unknown })?.type === 'text'
              ? String((part.output as { value?: unknown }).value ?? '')
              : JSON.stringify(part.output);
          out.push({ role: 'tool', content: value, tool_call_id: part.toolCallId });
        }
      }
    }
  }
  return out;
}

/** Files this turn touched, derived deterministically from the executed tool calls. */
function changedFilesFrom(messages: ChatMessage[]): Array<{ path: string; status: 'created' | 'modified' | 'deleted' }> {
  const out: Array<{ path: string; status: 'created' | 'modified' | 'deleted' }> = [];
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      let input: { path?: string } = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch { continue; }
      if (!input.path || seen.has(`${tc.function.name}:${input.path}`)) continue;
      seen.add(`${tc.function.name}:${input.path}`);
      if (tc.function.name === 'editFile') out.push({ path: input.path, status: 'modified' });
      if (tc.function.name === 'writeFile') out.push({ path: input.path, status: 'created' });
      if (tc.function.name === 'deleteFile') out.push({ path: input.path, status: 'deleted' });
    }
  }
  return out;
}

// ── The turn ────────────────────────────────────────────────────────────────────

/** Test seam ONLY (foundation-gate scenarios 11-14): when set, the engine uses this model
 *  instead of the picker-backed createRouterProvider — letting the e2e drive the REAL
 *  runTurn (toolset filtering, policy, history round-trip) with a scripted LanguageModelV4.
 *  Production never sets it. */
let modelOverride: LanguageModel | undefined;
export function __setEngineModelForTests(m: LanguageModel | undefined): void {
  modelOverride = m;
}

/** v3 turn entry. The `router` argument is IGNORED — model selection lives in
 *  router/picker.ts (injected via setModelSources at activation). Kept in the signature so
 *  every existing call site compiles unchanged. */
export async function runTurn(_router: unknown, opts: AgentOpts): Promise<AgentResult> {
  const modelMessages = toModelMessages(opts.messages);
  const tools: ToolSet = buildV3ToolSet(opts.mode, {
    abortSignal: opts.abortSignal,
    sessionId: opts.sessionId,
    requestId: opts.requestId,
  }) as ToolSet;

  const model: LanguageModel = modelOverride ?? createRouterProvider({
    effort: opts.effort,
    taskKind: opts.taskKind,
    pinnedModel: opts.pinnedModel,
    sessionId: opts.sessionId,
    excludeModels: opts.excludeModels,
    requireTools: true, // the engine always offers tools — non-tool models would deflect
    onFailover: opts.onFailover,
    onModelSelected: (platform, mdl, runtimeName) => {
      served = { platform, model: mdl, runtimeName };
      opts.onModel(platform, mdl, runtimeName);
    },
    onUsage: opts.usageSink
      ? (info) => opts.usageSink?.({ inputTokens: info.inputTokens, outputTokens: info.outputTokens, contextTokens: info.inputTokens, model: info.model })
      : undefined,
  });

  const { repair } = makeRepairViaModelSelfCorrection({ model, signal: opts.abortSignal });
  const policy = policyFromSettings(false, opts.mode);
  const toolEvents: ToolEvent[] = [];
  let reasoningText = '';

  let outcome: { finishReason: string; text: string; responseMessages: ModelMessage[] } = {
    finishReason: 'unknown', text: '', responseMessages: [],
  };
  // Which model actually served the turn — surfaced in AgentResult so the host's per-bubble
  // footer shows the real model (failover can switch it mid-turn; the LAST server wins).
  let served: { platform?: string; model?: string; runtimeName?: string } = {};

  const result = streamText({
    model,
    system: composeSystemPrompt(opts.mode),
    messages: modelMessages,
    tools,

    toolApproval: ({ toolCall }) =>
      resolvePolicy({ toolName: toolCall.toolName, input: toolCall.input }, policy, async (req) => {
        if (!opts.onPermissionAsk) return 'deny';
        const verdict = await opts.onPermissionAsk({ title: `Allow ${req.tool}?`, toolName: req.tool });
        return verdict === 'once' ? 'allow' : verdict === 'always' ? 'allow-always' : 'deny';
      }),

    repairToolCall: repair,
    prepareStep: ({ messages }) => compactIfNeeded(messages, COMPACT_BUDGET_TOKENS),
    stopWhen: [stepCountIs(50)],
    abortSignal: opts.abortSignal,
    maxRetries: 1,

    onChunk: ({ chunk }) => {
      if (chunk.type === 'text-delta') opts.onChunk(chunk.text);
      else if (chunk.type === 'reasoning-delta') {
        reasoningText += chunk.text;
        opts.onReasoning(chunk.text);
      }
    },

    onStepEnd: (step) => {
      for (const tc of step.toolCalls ?? []) {
        const ev: ToolEvent = { toolCallId: tc.toolCallId, name: tc.toolName, args: tc.input, state: 'running' };
        toolEvents.push(ev);
        opts.onTool(ev);
      }
      const failed = new Set(
        (step.content as Array<{ type?: string; toolName?: string }>)
          .filter((p) => p.type === 'tool-error' && p.toolName)
          .map((p) => p.toolName as string),
      );
      for (const tr of step.toolResults ?? []) {
        const isFailed = failed.has(tr.toolName);
        const ev: ToolEvent = {
          toolCallId: tr.toolCallId,
          name: tr.toolName,
          args: tr.input,
          state: isFailed ? 'error' : 'done',
        };
        toolEvents.push(ev);
        opts.onTool(ev);
      }
    },

    onError: ({ error }) => {
      diagLog('engine.error', String(error));
    },

    onEnd: ({ steps, finishReason }) => {
      outcome = {
        finishReason: String(finishReason),
        text: steps.at(-1)?.text ?? '',
        responseMessages: steps.flatMap((s) => s.response.messages),
      };
    },
  });

  try {
    await result.consumeStream();
  } catch (e) {
    const aborted = opts.abortSignal?.aborted || (e as Error)?.name === 'AbortError';
    const message = e instanceof Error ? e.message : String(e);
    if (!aborted) opts.onError(message);
    return {
      text: outcome.text,
      reasoning: reasoningText || undefined,
      platform: served.platform,
      model: served.model,
      runtimeName: served.runtimeName,
      workMessages: toChatMessages(outcome.responseMessages),
      failed: !aborted,
      ...(aborted ? {} : { errorMessage: message }),
      changedFiles: changedFilesFrom(toChatMessages(outcome.responseMessages)),
    };
  }

  const workMessages = toChatMessages(outcome.responseMessages);
  return {
    text: outcome.text,
    reasoning: reasoningText || undefined,
    platform: served.platform,
    model: served.model,
    runtimeName: served.runtimeName,
    workMessages,
    changedFiles: changedFilesFrom(workMessages),
  };
}
