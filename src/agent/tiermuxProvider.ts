// SDK isolation boundary — only this file implements LanguageModelV4.
// If AI SDK changes the provider interface, fix here only.
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult, LanguageModelV4StreamResult, LanguageModelV4StreamPart, LanguageModelV4FunctionTool } from '@ai-sdk/provider';
import type { Router, RouteOptions } from '../router/router';
import type { ChatMessage, ChatToolDefinition } from '../shared/types';
import type { ReasoningEffort } from '../shared/types';

export interface TiermuxProviderOptions {
  effort?: ReasoningEffort;
  taskKind?: string;
  pinnedModel?: string;
  onFailover?: (info: { from: string; reason: string }) => void;
  onKeyRotated?: (info: { platform: string; keyIndex: number; keyTotal: number }) => void;
  onModelSelected?: (platform: string, model: string) => void;
}

/** Convert AI SDK V4 prompt messages → Tiermux ChatMessage[] (OpenAI-wire format). */
function toRouterMessages(prompt: LanguageModelV4CallOptions['prompt']): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (const msg of prompt) {
    if (msg.role === 'system') {
      msgs.push({ role: 'system', content: msg.content });
    } else if (msg.role === 'user') {
      const text = msg.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map(p => p.text)
        .join('');
      msgs.push({ role: 'user', content: text || '' });
    } else if (msg.role === 'assistant') {
      const textParts = msg.content.filter((p): p is { type: 'text'; text: string } => p.type === 'text');
      const toolParts = msg.content.filter((p): p is any => p.type === 'tool-call');
      msgs.push({
        role: 'assistant',
        content: textParts.map(p => p.text).join('') || null,
        tool_calls: toolParts.length > 0 ? toolParts.map(p => ({
          id: p.toolCallId,
          type: 'function' as const,
          function: { name: p.toolName, arguments: JSON.stringify(p.args) },
        })) : undefined,
      });
    } else if (msg.role === 'tool') {
      for (const part of msg.content) {
        if (part.type === 'tool-result') {
          msgs.push({
            role: 'tool',
            content: typeof part.output === 'string' ? part.output : JSON.stringify(part.output),
            tool_call_id: part.toolCallId,
          });
        }
      }
    }
  }
  return msgs;
}

/** Convert AI SDK tool definitions → Tiermux ChatToolDefinition[]. */
function toRouterTools(tools?: LanguageModelV4CallOptions['tools']): ChatToolDefinition[] | undefined {
  if (!tools?.length) return undefined;
  return tools
    .filter((t): t is LanguageModelV4FunctionTool => t.type === 'function')
    .map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));
}

/**
 * Wraps Tiermux's Router as a Vercel AI SDK LanguageModelV4.
 * The router is the "model" — AI SDK calls doStream/doGenerate,
 * this translates to router.route() with key rotation and failover.
 */
export function createTiermuxProvider(router: Router, providerOpts: TiermuxProviderOptions = {}): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'tiermux',
    modelId: `auto-${providerOpts.effort ?? 'medium'}`,
    supportedUrls: {},

    async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      const messages = toRouterMessages(options.prompt);
      const tools = toRouterTools(options.tools);

      const routeOpts: RouteOptions = {
        model: providerOpts.pinnedModel ?? 'auto',
        temperature: options.temperature,
        max_tokens: options.maxOutputTokens,
        tools,
        requireTools: !!tools?.length,
        reasoningEffort: providerOpts.effort,

        onFailover: providerOpts.onFailover
          ? (info) => providerOpts.onFailover!({ from: `${info.from.platform}::${info.from.modelId}`, reason: info.reason })
          : undefined,
        onKeyRotated: providerOpts.onKeyRotated
          ? (info) => providerOpts.onKeyRotated!({ platform: info.platform, keyIndex: info.keyIndex, keyTotal: info.keyTotal })
          : undefined,
      };

      const result = await router.route(messages, routeOpts);

      if (providerOpts.onModelSelected) {
        providerOpts.onModelSelected(result.platform, result.model);
      }

      const msg = result.response.choices?.[0]?.message;
      const content: LanguageModelV4GenerateResult['content'] = [];

      if (msg?.content) {
        content.push({ type: 'text', text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
      }

      if (msg?.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.function.name,
            input: tc.function.arguments ?? '{}',
            providerExecuted: false,
          });
        }
      }

      const hasCalls = !!(msg?.tool_calls?.length);
      return {
        content,
        finishReason: { unified: hasCalls ? 'tool-calls' : 'stop', raw: hasCalls ? 'tool_calls' : 'stop' },
        usage: {
          inputTokens: { total: result.response.usage?.prompt_tokens, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: result.response.usage?.completion_tokens, text: undefined, reasoning: undefined },
        },
        warnings: [],
      };
    },

    async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
      const messages = toRouterMessages(options.prompt);
      const tools = toRouterTools(options.tools);
      const hasTools = !!tools?.length;

      let streamController!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(c) { streamController = c; },
      });

      // Emit stream-start immediately
      streamController.enqueue({ type: 'stream-start', warnings: [] });

      const textId = 'text-0';
      let chunkCount = 0;

      // For non-tool turns: open the text block BEFORE the first delta so the
      // AI SDK sees text-start → text-delta* → text-end in the correct order.
      if (!hasTools) {
        streamController.enqueue({ type: 'text-start', id: textId });
      }

      const routeOpts: RouteOptions = {
        model: providerOpts.pinnedModel ?? 'auto',
        temperature: options.temperature,
        max_tokens: options.maxOutputTokens,
        tools,
        requireTools: hasTools,
        reasoningEffort: providerOpts.effort,

        // Stream text deltas for non-tool turns
        onChunk: hasTools ? undefined : (delta: string) => {
          chunkCount++;
          streamController.enqueue({ type: 'text-delta', id: textId, delta });
        },
        onFailover: providerOpts.onFailover
          ? (info) => providerOpts.onFailover!({ from: `${info.from.platform}::${info.from.modelId}`, reason: info.reason })
          : undefined,
        onKeyRotated: providerOpts.onKeyRotated
          ? (info) => providerOpts.onKeyRotated!({ platform: info.platform, keyIndex: info.keyIndex, keyTotal: info.keyTotal })
          : undefined,
      };

      // Run the route call asynchronously — don't await here so stream returns immediately
      router.route(messages, routeOpts).then((result) => {
        if (providerOpts.onModelSelected) {
          providerOpts.onModelSelected(result.platform, result.model);
        }

        const msg = result.response.choices?.[0]?.message;
        const hasToolCalls = !!(msg?.tool_calls?.length);

        if (!hasTools) {
          // Non-tool path: text-start was emitted upfront.
          // If the router didn't stream (chunkCount === 0), emit the full content as one delta now.
          if (chunkCount === 0 && msg?.content) {
            const fullText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            streamController.enqueue({ type: 'text-delta', id: textId, delta: fullText });
          }
          streamController.enqueue({ type: 'text-end', id: textId });
        } else if (!hasToolCalls && msg?.content) {
          // Agent mode but model replied with text only (no tool calls) — emit as a text block.
          const fullText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          streamController.enqueue({ type: 'text-start', id: textId });
          streamController.enqueue({ type: 'text-delta', id: textId, delta: fullText });
          streamController.enqueue({ type: 'text-end', id: textId });
        }

        // Emit tool calls
        if (hasToolCalls) {
          for (const tc of msg!.tool_calls!) {
            const argsStr = tc.function.arguments ?? '{}';
            streamController.enqueue({ type: 'tool-input-start', id: tc.id, toolName: tc.function.name });
            streamController.enqueue({ type: 'tool-input-delta', id: tc.id, delta: argsStr });
            streamController.enqueue({ type: 'tool-input-end', id: tc.id });
          }
        }

        streamController.enqueue({
          type: 'finish',
          finishReason: { unified: hasToolCalls ? 'tool-calls' : 'stop', raw: hasToolCalls ? 'tool_calls' : 'stop' },
          usage: {
            inputTokens: { total: result.response.usage?.prompt_tokens, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: result.response.usage?.completion_tokens, text: undefined, reasoning: undefined },
          },
        });
        streamController.close();
      }).catch((err: unknown) => {
        streamController.enqueue({ type: 'error', error: err });
        streamController.close();
      });

      return { stream };
    },
  };
}
