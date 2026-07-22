

// Pure protocol adapter — AI SDK prompt/tool shapes <-> TierMux's own ChatMessage/ChatToolDefinition
// (OpenAI wire format, which Router.route() already speaks). No routing decisions, no scoring, no
// failover logic here — that's all Router.route()'s job. The model being called is still whatever
// the user picked (GPT/Claude/Qwen/...); this factory does not itself produce "a model."
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult, LanguageModelV4StreamResult, LanguageModelV4StreamPart, LanguageModelV4FunctionTool } from '@ai-sdk/provider';
import type { Router, RouteOptions } from '../../router/router';
import type { ChatMessage, ChatToolDefinition, ReasoningEffort } from '../../shared/types';

/** One scored candidate as reported to AgentOpts.onSelectionRationale — `model` is a
 *  "platform::modelId" key (matching onFailover's `from` shape), not a display name;
 *  chatViewProvider.ts's callback resolves it to a display name before it reaches the UI. */
export interface RationaleEntryInfo {
  model: string;
  selected: boolean;
  score: number;
  capability: number;
  runtime: number;
  preference: number;
  confidence: number;
  reason: string;
  skip?: string;
}

export interface RouterProviderOptions {
  effort?: ReasoningEffort;
  taskKind?: string;
  pinnedModel?: string;
  onFailover?: (from: string, reason: string) => void;
  onKeyRotated?: (info: { platform: string; keyIndex: number; keyTotal: number }) => void;
  onModelSelected?: (platform: string, model: string, runtimeName?: string) => void;
  onSelectionRationale?: (info: { taskKind: string; picked?: string; entries: RationaleEntryInfo[] }) => void;
}

const routeKey = (e: { platform: string; modelId: string }): string => `${e.platform}::${e.modelId}`;

/** Convert Router's own onSelectionRationale shape (scoring.ts's RationaleEntry[], which
 *  uses runtimeMultiplier/userPreference and platform+modelId as separate fields) into the
 *  flatter shape AgentOpts.onSelectionRationale/chatViewProvider.ts already expect. */
function toRationaleCallback(
  cb: RouterProviderOptions['onSelectionRationale'],
): RouteOptions['onSelectionRationale'] {
  if (!cb) return undefined;
  return (info) => cb({
    taskKind: info.taskKind,
    picked: info.picked ? routeKey(info.picked) : undefined,
    entries: info.rationale.map((r) => ({
      model: routeKey(r),
      selected: r.selected,
      score: r.score,
      capability: r.capability,
      runtime: r.runtimeMultiplier,
      preference: r.userPreference,
      confidence: r.confidence,
      reason: r.reason,
      skip: r.skip,
    })),
  });
}

/** Convert AI SDK prompt messages -> TierMux ChatMessage[] (OpenAI-wire format). */
function toRouterMessages(prompt: LanguageModelV4CallOptions['prompt']): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (const msg of prompt) {
    if (msg.role === 'system') {
      msgs.push({ role: 'system', content: msg.content });
    } else if (msg.role === 'user') {
      const text = msg.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('');
      msgs.push({ role: 'user', content: text || '' });
    } else if (msg.role === 'assistant') {
      const textParts = msg.content.filter((p): p is { type: 'text'; text: string } => p.type === 'text');
      const toolParts = msg.content.filter((p): p is any => p.type === 'tool-call');
      msgs.push({
        role: 'assistant',
        content: textParts.map((p) => p.text).join('') || null,
        tool_calls: toolParts.length > 0
          ? toolParts.map((p) => ({ id: p.toolCallId, type: 'function' as const, function: { name: p.toolName, arguments: JSON.stringify(p.input) } }))
          : undefined,
      });
    } else if (msg.role === 'tool') {
      for (const part of msg.content) {
        if (part.type === 'tool-result') {
          msgs.push({ role: 'tool', content: typeof part.output === 'string' ? part.output : JSON.stringify(part.output), tool_call_id: part.toolCallId });
        }
      }
    }
  }
  return msgs;
}

/** Convert AI SDK tool definitions -> TierMux ChatToolDefinition[]. */
function toRouterTools(tools?: LanguageModelV4CallOptions['tools']): ChatToolDefinition[] | undefined {
  if (!tools?.length) return undefined;
  return tools
    .filter((t): t is LanguageModelV4FunctionTool => t.type === 'function')
    .map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.inputSchema as Record<string, unknown> } }));
}

/**
 * Wraps Router as an AI-SDK-shaped LanguageModelV4. Router is the "model" from the SDK's
 * point of view — the SDK calls doGenerate/doStream, this translates to router.route() with
 * failover/key-rotation callbacks forwarded. See core/loop.ts for how this gets wired up.
 */
export function createRouterProvider(router: Router, providerOpts: RouterProviderOptions = {}): LanguageModelV4 {
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
        taskKind: providerOpts.taskKind as RouteOptions['taskKind'],
        onFailover: providerOpts.onFailover ? (info) => providerOpts.onFailover!(`${info.from.platform}::${info.from.modelId}`, info.reason) : undefined,
        onKeyRotated: providerOpts.onKeyRotated ? (info) => providerOpts.onKeyRotated!({ platform: info.platform, keyIndex: info.keyIndex, keyTotal: info.keyTotal }) : undefined,
        onSelectionRationale: toRationaleCallback(providerOpts.onSelectionRationale),
      };

      const result = await router.route(messages, routeOpts);
      providerOpts.onModelSelected?.(result.platform, result.model, result.runtimeName);

      const msg = result.response.choices?.[0]?.message;
      const content: LanguageModelV4GenerateResult['content'] = [];
      if (msg?.content) content.push({ type: 'text', text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
      if (msg?.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          content.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, input: tc.function.arguments ?? '{}', providerExecuted: false });
        }
      }
      const hasCalls = !!msg?.tool_calls?.length;
      return {
        content,
        finishReason: { unified: hasCalls ? 'tool-calls' : 'stop', raw: hasCalls ? 'tool_calls' : 'stop' },
        usage: {
          inputTokens: { total: result.response.usage?.prompt_tokens },
          outputTokens: { total: result.response.usage?.completion_tokens },
        },
        warnings: [],
      } as unknown as LanguageModelV4GenerateResult;
    },

    async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
      const messages = toRouterMessages(options.prompt);
      const tools = toRouterTools(options.tools);
      const hasTools = !!tools?.length;

      let streamController!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
      const stream = new ReadableStream<LanguageModelV4StreamPart>({ start(c) { streamController = c; } });

      streamController.enqueue({ type: 'stream-start', warnings: [] });
      const textId = 'text-0';
      let chunkCount = 0;
      let textStarted = false;

      const routeOpts: RouteOptions = {
        model: providerOpts.pinnedModel ?? 'auto',
        temperature: options.temperature,
        max_tokens: options.maxOutputTokens,
        tools,
        requireTools: hasTools,
        reasoningEffort: providerOpts.effort,
        taskKind: providerOpts.taskKind as RouteOptions['taskKind'],
        // Router.route() now streams even when tools are offered (tool-call deltas are
        // accumulated by index internally); live text deltas still arrive here as they land.
        onChunk: (delta: string) => {
          chunkCount++;
          if (!textStarted) { textStarted = true; streamController.enqueue({ type: 'text-start', id: textId }); }
          streamController.enqueue({ type: 'text-delta', id: textId, delta });
        },
        onFailover: providerOpts.onFailover ? (info) => providerOpts.onFailover!(`${info.from.platform}::${info.from.modelId}`, info.reason) : undefined,
        onKeyRotated: providerOpts.onKeyRotated ? (info) => providerOpts.onKeyRotated!({ platform: info.platform, keyIndex: info.keyIndex, keyTotal: info.keyTotal }) : undefined,
        onSelectionRationale: toRationaleCallback(providerOpts.onSelectionRationale),
      };

      router.route(messages, routeOpts).then((result) => {
        providerOpts.onModelSelected?.(result.platform, result.model, result.runtimeName);
        const msg = result.response.choices?.[0]?.message;
        const hasToolCalls = !!msg?.tool_calls?.length;

        if (chunkCount === 0 && msg?.content) {
          if (!textStarted) { textStarted = true; streamController.enqueue({ type: 'text-start', id: textId }); }
          const fullText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          streamController.enqueue({ type: 'text-delta', id: textId, delta: fullText });
        }
        if (textStarted) streamController.enqueue({ type: 'text-end', id: textId });

        if (hasToolCalls) {
          for (const tc of msg!.tool_calls!) {
            const argsStr = tc.function.arguments ?? '{}';
            streamController.enqueue({ type: 'tool-input-start', id: tc.id, toolName: tc.function.name });
            streamController.enqueue({ type: 'tool-input-delta', id: tc.id, delta: argsStr });
            streamController.enqueue({ type: 'tool-input-end', id: tc.id });
            streamController.enqueue({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, input: argsStr });
          }
        }

        streamController.enqueue({
          type: 'finish',
          finishReason: { unified: hasToolCalls ? 'tool-calls' : 'stop', raw: hasToolCalls ? 'tool_calls' : 'stop' },
          usage: { inputTokens: { total: result.response.usage?.prompt_tokens }, outputTokens: { total: result.response.usage?.completion_tokens } },
        } as unknown as LanguageModelV4StreamPart);
        streamController.close();
      }).catch((err: unknown) => {
        streamController.enqueue({ type: 'error', error: err });
        streamController.close();
      });

      return { stream };
    },
  };
}
