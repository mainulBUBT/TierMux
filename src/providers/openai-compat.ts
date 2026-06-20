// Generic OpenAI-compatible provider. Adapted from freellmapi's
// server/src/providers/openai-compat.ts (MIT). Covers Groq, Cerebras, NVIDIA,
// Mistral, OpenRouter, GitHub Models, Zhipu, HuggingFace router, Ollama, Kilo,
// Pollinations, LLM7, OpenCode Zen, OVH, Agnes, and user `custom` endpoints.
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
export type ReasoningStyle = 'none' | 'effort' | 'openrouter';

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
}

export class OpenAICompatProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly forceSingleToolCall: boolean;
  private readonly reasoningStyle: ReasoningStyle;
  private readonly flattenContent: boolean;

  constructor(opts: OpenAICompatOpts) {
    super();
    this.platform = opts.platform;
    this.name = opts.name;
    this.baseUrl = opts.baseUrl;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.keyless = opts.keyless ?? false;
    this.forceSingleToolCall = opts.forceSingleToolCall ?? false;
    this.reasoningStyle = opts.reasoningStyle ?? 'effort';
    this.flattenContent = opts.flattenContent ?? false;
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
    // The OpenAI-wire reasoning_effort field only accepts low/medium/high; our
    // extra 'xhigh' tier maps down to 'high' so providers don't reject it.
    const wire = effort === 'xhigh' ? 'high' : effort;
    if (this.reasoningStyle === 'openrouter') return { reasoning: { effort: wire } };
    return { reasoning_effort: wire };
  }

  private buildBody(messages: ChatMessage[], modelId: string, options: CompletionOptions | undefined, stream: boolean): string {
    // Two content transforms:
    //  - flattenContent (Cohere/Cloudflare-style): collapse every block array to a string.
    //  - stripFileBlocks: drop our custom `file` (PDF) envelope on the wire, since most
    //    OpenAI-compat providers don't recognize it. The PDF's extracted text is already
    //    part of the user message (buildUserContent inlines it), so nothing is lost.
    const wireMessages = this.flattenContent
      ? flattenMessageContent(messages)
      : messages.map((m) => m.content === null || m.content === undefined || typeof m.content === 'string'
          ? m
          : { ...m, content: stripFileBlocks(m.content) });
    return JSON.stringify({
      model: modelId,
      messages: wireMessages,
      temperature: options?.temperature,
      max_tokens: options?.max_tokens,
      top_p: options?.top_p,
      tools: options?.tools,
      tool_choice: options?.tool_choice,
      parallel_tool_calls: this.resolveParallelToolCalls(options),
      ...this.reasoningFields(options?.reasoningEffort),
      ...(stream ? { stream: true } : {}),
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
    // gpt-oss / Harmony models leak control tokens into tool-call names and
    // sometimes into content — clean both so calls resolve and answers read right.
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
