// TierMux's Smart Router as a Cline `AgentModel`. Every model request the Cline loop makes
// lands in stream(), which resolves the failover chain through the picker and serves it from
// the provider fleet — the same chain, cooldown, key-rotation and platform-condemn logic
// routeOnce used with the AI SDK engine, now behind Cline's loop. Fully in-process: no HTTP
// hop, no gateway registration.
import type { AgentModel, AgentModelEvent, AgentToolDefinition, AgentMessage } from '@cline/shared';
import type { ChatMessage, ChatToolCall, ChatToolDefinition, ReasoningEffort, TokenUsage } from '../../../shared/types';
import { findCatalogModel, recordOutcome, recordRequest } from '../../../router/picker';
import { resolveCandidates } from '../routerProvider';
import { resolveProvider } from '../../../providers';
import { ProviderHttpError } from '../../../providers/base';
import type { TaskKind } from '../../routing';
import { diagLog } from '../../../util/diag';

/** Account-level failures (401/403/402) condemn the PLATFORM, not just the model — a sibling
 *  model on the same key cannot succeed. Mirrors routeOnce. */
function isPlatformFatal(e: unknown): boolean {
  return e instanceof ProviderHttpError && [401, 402, 403].includes(e.status ?? 0);
}

/** Cline AgentMessage[] → OpenAI-wire ChatMessage[]. The host owns the transcript in the wire
 *  shape; this is the projection the fleet serves. System content never appears here — it
 *  travels via request.systemPrompt. */
export function agentMessagesToChat(messages: readonly AgentMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const parts = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'user') {
      const text = parts.filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('\n');
      if (text) out.push({ role: 'user', content: text });
    } else if (m.role === 'assistant') {
      const text = parts.filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('');
      const calls = parts
        .filter((p): p is Extract<typeof p, { type: 'tool-call' }> => p.type === 'tool-call')
        .map((p) => ({ id: p.toolCallId, type: 'function' as const, function: { name: p.toolName, arguments: JSON.stringify(p.input ?? {}) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (m.role === 'tool') {
      for (const p of parts) {
        if (p.type !== 'tool-result') continue;
        const value = typeof p.output === 'string' ? p.output
          : p.output === undefined || p.output === null ? ''
          : JSON.stringify(p.output);
        out.push({ role: 'tool', content: value, tool_call_id: p.toolCallId });
      }
    }
  }
  return out;
}

/** At/below this window the schema tax stops being affordable (mirrors the old engine). */
const SMALL_WINDOW_MAX = 16_384;
/** Coordination tools withdrawn from small-window models' view (schema tax). */
const COORDINATION_TOOLS = ['todoWrite'];

/** The model's tool offer for a given context window: at/below SMALL_WINDOW_MAX the
 *  coordination tools are withdrawn from view (schema tax); undefined window (uncatalogued
 *  model) falls back to the FULL offer — never guess a model small. */
export function offerForWindow<T extends AgentToolDefinition>(contextWindow: number | undefined, tools: readonly T[]): T[] {
  if (contextWindow != null && contextWindow <= SMALL_WINDOW_MAX) {
    return tools.filter((d) => !COORDINATION_TOOLS.includes(d.name));
  }
  return [...tools];
}

/** Assembles streamed tool-call deltas (identified by slot index) into complete calls. */
class ToolCallAssembler {
  private slots = new Map<number, { id: string; name: string; args: string }>();

  push(calls: ChatToolCall[]): Array<{ id: string; name: string; args: string }> {
    const started: Array<{ id: string; name: string; args: string }> = [];
    for (const tc of calls) {
      const idx = tc.index ?? 0;
      let slot = this.slots.get(idx);
      if (!slot) {
        slot = { id: tc.id || `call_${idx}`, name: '', args: '' };
        this.slots.set(idx, slot);
        started.push(slot);
      } else if (tc.id) {
        slot.id = tc.id;
      }
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
    return started;
  }

  complete(): Array<{ id: string; name: string; args: string }> {
    return [...this.slots.values()].filter((s) => s.name);
  }
}

export interface TierMuxAgentModelOptions {
  taskKind: TaskKind;
  effort?: ReasoningEffort;
  temperature?: number;
  pinnedModel?: string;
  excludeModels?: string[];
  abortSignal?: AbortSignal;
  onModel?: (platform: string, model: string, runtimeName?: string) => void;
  onFailover?: (from: string, reason: string) => void;
  /** Per-request provider-measured usage, for the turn telemetry sink. */
  onUsage?: (info: { inputTokens: number; outputTokens: number; contextTokens: number; model: string }) => void;
}

/** Wires the failover chain into Cline's model boundary. One instance per turn. */
export function createTierMuxAgentModel(opts: TierMuxAgentModelOptions): AgentModel {
  return {
    stream: async function* (request: Parameters<AgentModel['stream']>[0]): AsyncGenerator<AgentModelEvent> {
      const messages = agentMessagesToChat(request.messages);
      if (!messages.length) {
        yield { type: 'finish', reason: 'stop' };
        return;
      }
      const chain = await resolveCandidates({
        taskKind: opts.taskKind,
        pinnedModel: opts.pinnedModel,
        excludeModels: opts.excludeModels,
        effort: opts.effort,
      });
      if (!chain.length) {
        yield { type: 'finish', reason: 'error', error: 'No usable model candidate resolved.', errorRetryable: false };
        return;
      }
      // The head candidate is known only here (the router resolves inside stream()), so the
      // small-window schema tax is applied at the same boundary that picks the model.
      const head = chain[0];
      const headWindow = head ? (findCatalogModel(head.platform, head.modelId)?.contextWindow ?? undefined) : undefined;
      const tools: ChatToolDefinition[] = offerForWindow(headWindow, request.tools ?? []).map((d: AgentToolDefinition) => ({
        type: 'function',
        function: { name: d.name, description: d.description, parameters: d.inputSchema },
      }));
      const attempts: string[] = [];
      const deadPlatforms = new Set<string>();
      for (const c of chain) {
        if (deadPlatforms.has(c.platform)) continue;
        if (opts.abortSignal?.aborted) { yield { type: 'finish', reason: 'aborted' }; return; }
        const provider = resolveProvider(c.platform, c.modelId);
        if (!provider) { attempts.push(`${c.platform}::${c.modelId}: no provider resolved`); continue; }
        const key = `${c.platform}::${c.modelId}`;
        // Key rotation within one candidate: a dead or quota'd key must not cost the whole model.
        for (const apiKey of c.apiKeys) {
          try {
            const assembler = new ToolCallAssembler();
            let usage: TokenUsage | undefined;
            let finishReason: string | null = null;
            for await (const chunk of provider.streamChatCompletion(apiKey, messages, c.modelId, {
              tools,
              temperature: opts.temperature ?? 0.2,
              reasoningEffort: opts.effort,
              abortSignal: opts.abortSignal,
            })) {
              const choice = chunk.choices?.[0];
              const rawDelta = (choice?.delta ?? {}) as {
                content?: string;
                reasoning_content?: string;
                reasoning?: string;
                tool_calls?: ChatToolCall[];
              };
              const delta = rawDelta;
              const reasoning = rawDelta.reasoning_content ?? rawDelta.reasoning;
              if (reasoning) yield { type: 'reasoning-delta', text: reasoning };
              if (rawDelta.content) yield { type: 'text-delta', text: rawDelta.content };
              if (delta?.tool_calls?.length) {
                for (const started of assembler.push(delta.tool_calls)) {
                  if (started.name) yield { type: 'tool-call-delta', toolCallId: started.id, toolName: started.name, inputText: '' };
                }
              }
              if (chunk.usage) usage = chunk.usage;
              if (choice?.finish_reason) finishReason = choice.finish_reason;
            }
            recordRequest(c.platform, c.modelId);
            recordOutcome(c.platform, c.modelId, true);
            opts.onModel?.(c.platform, c.modelId, provider.name);
            // Complete calls carry the parsed `input` so the runtime can build tool-call parts
            // without re-assembling argument text across deltas.
            for (const call of assembler.complete()) {
              let input: unknown;
              try { input = JSON.parse(call.args || '{}'); } catch { input = {}; }
              yield { type: 'tool-call-delta', toolCallId: call.id, toolName: call.name, input };
            }
            if (usage) {
              const inputTokens = usage.prompt_tokens ?? 0;
              const outputTokens = usage.completion_tokens ?? 0;
              opts.onUsage?.({ inputTokens, outputTokens, contextTokens: inputTokens, model: key });
              yield { type: 'usage', usage: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 } };
            }
            diagLog('cline.model.served', `${key} finish=${finishReason ?? 'none'}`);
            yield {
              type: 'finish',
              reason: finishReason === 'tool_calls' ? 'tool-calls'
                : finishReason === 'length' ? 'max-tokens'
                : finishReason === 'aborted' ? 'aborted'
                : 'stop',
            };
            return;
          } catch (e) {
            recordOutcome(c.platform, c.modelId, false);
            const reason = e instanceof Error ? e.message : String(e);
            attempts.push(`${key}: ${reason.slice(0, 160)}`);
            opts.onFailover?.(key, reason);
            diagLog('cline.model.failover', `${key} — ${reason.slice(0, 120)}`);
            if (isPlatformFatal(e)) deadPlatforms.add(c.platform);
          }
        }
      }
      yield {
        type: 'finish',
        reason: 'error',
        error: attempts.join(' | ').slice(0, 400) || 'Every model in the chain failed.',
        errorRetryable: false,
      };
    },
  };
}
