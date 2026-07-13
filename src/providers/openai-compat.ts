

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  ChatToolCall,
  Platform,
  ReasoningEffort,
} from '../shared/types';
import { BaseProvider, providerHttpError } from './base';
import type { CompletionOptions } from './options';
import { repairToolArguments, rescueInlineToolCalls, toolSchemaMap, sanitizeToolName, stripHarmonyTokens } from '../agent/toolArgs';
import { flattenMessageContent, stripFileBlocks } from '../agent/content';

/** How a provider expects the reasoning-effort knob to be expressed. */
type ReasoningStyle = 'none' | 'effort' | 'openrouter';

export interface OpenAICompatOpts {
  platform: Platform;
  name: string;
  baseUrl: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  keyless?: boolean;
  forceSingleToolCall?: boolean;
  /** Flatten array/multimodal content to string (Cohere/Cloudflare-style). */
  flattenContent?: boolean;
  reasoningStyle?: ReasoningStyle;
  /** Runtime display name for custom endpoints (no-op for built-ins). */
  runtimeName?: string;
  /** Optional override for preflight health check timeout (ms). */
  preflightTimeoutMs?: number;
  /** Skip the preflight ping entirely for this provider. */
  skipPreflight?: boolean;
  /**
   * Floor applied to `max_tokens` when the caller doesn't specify one (OC often
   * doesn't). Needed for providers whose reasoning isn't optional and shares the
   * same output budget as the answer (e.g. Poolside) — a small/unset max_tokens
   * lets the model exhaust its budget mid-`<think>`, so ThinkStripper correctly
   * discards the (still-open) reasoning and the whole turn comes back empty even
   * though tokens were billed.
   */
  defaultMaxTokens?: number;
}

export class OpenAICompatProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly forceSingleToolCall: boolean;
  private readonly reasoningStyle: ReasoningStyle;
  /** Public so the router can exclude flatteners from vision turns — a provider that
   *  flattens multimodal content to plain text can never deliver an image, regardless
   *  of what the catalog's supportsVision says about the underlying model. */
  readonly flattenContent: boolean;
  private readonly defaultMaxTokens?: number;

  constructor(opts: OpenAICompatOpts) {
    super();
    this.platform = opts.platform;
    this.name = opts.name;
    this.runtimeName = opts.runtimeName ?? opts.name;
    this.baseUrl = opts.baseUrl;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.keyless = opts.keyless ?? false;
    this.forceSingleToolCall = opts.forceSingleToolCall ?? false;
    this.reasoningStyle = opts.reasoningStyle ?? 'effort';
    this.flattenContent = opts.flattenContent ?? false;
    this.preflightTimeoutMs = opts.preflightTimeoutMs;
    this.skipPreflight = opts.skipPreflight ?? false;
    this.defaultMaxTokens = opts.defaultMaxTokens;
  }

  private resolveBaseUrl(options?: CompletionOptions): string {
    const o = options?.baseUrlOverride?.trim();
    return o && o.length > 0 ? o.replace(/\/+$/, '') : this.baseUrl;
  }

  private authHeader(apiKey: string): Record<string, string> {
    return this.keyless ? {} : { Authorization: `Bearer ${apiKey}` };
  }

  private resolveParallelToolCalls(options?: CompletionOptions): boolean | undefined {
    if (this.forceSingleToolCall && options?.tools && options.tools.length > 0) return false;
    return options?.parallel_tool_calls;
  }

  /** Map the neutral reasoning effort to the provider's request fields. */
  private reasoningFields(effort?: ReasoningEffort): Record<string, unknown> {
    if (!effort || effort === 'off' || this.reasoningStyle === 'none') return {};

    const wire = effort === 'xhigh' ? 'high' : effort;
    if (this.reasoningStyle === 'openrouter') return { reasoning: { effort: wire } };
    return { reasoning_effort: wire };
  }

  private buildBody(messages: ChatMessage[], modelId: string, options: CompletionOptions | undefined, stream: boolean): string {

    const wireMessages = this.flattenContent
      ? flattenMessageContent(messages)
      : messages.map((m) => m.content === null || m.content === undefined || typeof m.content === 'string'
          ? m
          : { ...m, content: stripFileBlocks(m.content) });

    const wireModel = this.platform === 'custom' && modelId.includes('::')
      ? modelId.split('::').slice(1).join('::')
      : modelId;
    return JSON.stringify({
      model: wireModel,
      messages: wireMessages,
      temperature: options?.temperature,
      max_tokens: options?.max_tokens ?? this.defaultMaxTokens,
      top_p: options?.top_p,
      tools: options?.tools,
      tool_choice: options?.tool_choice,
      parallel_tool_calls: this.resolveParallelToolCalls(options),
      ...this.reasoningFields(options?.reasoningEffort),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    });
  }

  private rescueFailedGeneration(errBody: unknown, options?: CompletionOptions): ChatToolCall[] | null {
    const failed = (errBody as { error?: { failed_generation?: unknown } })?.error?.failed_generation;
    if (typeof failed !== 'string' || failed.length === 0) return null;
    const toolNames = new Set((options?.tools ?? []).map((t) => t.function.name));
    if (toolNames.size === 0) return null;
    const rescue = rescueInlineToolCalls(failed, toolNames);
    if (!rescue.detected || !rescue.calls.length) return null;
    const schemas = toolSchemaMap(options?.tools);
    return rescue.calls.map((c, i) => ({
      id: `call_rescued_${i + 1}`,
      type: 'function' as const,
      function: { name: c.name, arguments: repairToolArguments(c.arguments, schemas.get(c.name)) },
    }));
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const res = await this.fetchWithTimeout(`${this.resolveBaseUrl(options)}/chat/completions`, {
      method: 'POST',
      headers: { ...this.authHeader(apiKey), 'Content-Type': 'application/json', ...this.extraHeaders },
      body: this.buildBody(messages, modelId, options, false),
    }, options?.timeoutMs ?? this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const rescued = this.rescueFailedGeneration(err, options);
      if (rescued) {
        return {
          id: `chatcmpl-rescued-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: rescued }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          _routed_via: { platform: this.platform, model: modelId },
        };
      }
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${errMessage(err) ?? res.statusText}`);
    }

    let data: ChatCompletionResponse;
    try {
      data = (await res.json()) as ChatCompletionResponse;
    } catch {
      throw new Error(
        `${this.name} returned a non-JSON 200 body — the endpoint may not be OpenAI-compatible. Check the base URL (e.g. Ollama needs the /v1 path).`,
      );
    }
    const raw = data as unknown as {
      usage?: {
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    if (data.usage && raw.usage?.completion_tokens_details?.reasoning_tokens !== undefined) {
      data.usage.reasoning_tokens = raw.usage.completion_tokens_details.reasoning_tokens;
    }
    normalizeChoices(data);
    data._routed_via = { platform: this.platform, model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.fetchWithTimeout(`${this.resolveBaseUrl(options)}/chat/completions`, {
      method: 'POST',
      headers: { ...this.authHeader(apiKey), 'Content-Type': 'application/json', ...this.extraHeaders },
      body: this.buildBody(messages, modelId, options, true),
    }, options?.timeoutMs ?? this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${errMessage(err) ?? res.statusText}`);
    }
    yield* this.readSseStream(res);
  }
}

function errMessage(err: unknown): string | undefined {
  const e = err as { error?: { message?: unknown }; message?: unknown };
  if (typeof e?.error?.message === 'string') return e.error.message;
  if (typeof e?.message === 'string') return e.message;
  return undefined;
}

/**
 * Fold reasoning_content into content when content is empty (Z.ai, Ollama),
 * and flatten array content (Mistral magistral) to a string.
 */
function normalizeChoices(data: ChatCompletionResponse): void {
  for (const choice of data.choices ?? []) {
    const msg = choice.message as ChatMessage & { reasoning_content?: string; reasoning?: string; content: unknown };
    if (Array.isArray(msg.content)) {
      msg.content = (msg.content as Array<{ text?: string }>)
        .map((seg) => (typeof seg === 'string' ? seg : seg.text ?? ''))
        .join('');
    }

    for (const tc of msg.tool_calls ?? []) {
      if (tc?.function?.name) tc.function.name = sanitizeToolName(tc.function.name);
    }
    if (typeof msg.content === 'string') msg.content = stripHarmonyTokens(msg.content);
    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    if (!hasToolCalls && (msg.content === '' || msg.content == null)) {
      const fold =
        typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0
          ? msg.reasoning_content
          : typeof msg.reasoning === 'string' && msg.reasoning.length > 0
            ? msg.reasoning
            : null;
      if (fold !== null) msg.content = fold;
    }
  }
}
