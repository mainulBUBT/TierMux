

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  ChatToolCall,
  ChatToolChoice,
  ChatToolDefinition,
  Platform,
  ReasoningEffort,
  TokenUsage,
} from '../shared/types';
import { BaseProvider, providerHttpError } from './base';
import type { CompletionOptions } from './options';
import { contentToString } from '../agent/content';

/** Anthropic requires a pinned API version header — bump only after checking the new
 *  version doesn't change a response shape this adapter depends on. */
const ANTHROPIC_VERSION = '2023-06-01';
/** Anthropic (unlike OpenAI) REQUIRES max_tokens on every request — there is no server-side
 *  default to fall back to, so an unset value must still send something reasonable. */
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicMessagesOpts {
  platform: Platform;
  name: string;
  runtimeName?: string;
  baseUrl: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  anthropicVersion?: string;
  skipPreflight?: boolean;
  ttftTimeoutMs?: number;
}

/** A subset of Anthropic's content-block union — only the fields this adapter reads/writes. */
interface AnthropicBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  source?: { type: 'base64'; media_type: string; data: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}
interface AnthropicMessage { role: 'user' | 'assistant'; content: AnthropicBlock[] }
interface AnthropicResponse {
  id?: string;
  content?: AnthropicBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** `data:<mime>[;base64],<payload>` → raw base64 (re-encoding a non-base64 payload if needed). */
function base64FromDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  const mediaType = m[1] || 'application/octet-stream';
  const payload = m[3] ?? '';
  const data = m[2] ? payload : Buffer.from(decodeURIComponent(payload)).toString('base64');
  return data.length > 0 ? { mediaType, data } : null;
}

/** A user/assistant turn's content blocks → Anthropic's block union. Text/image/file blocks
 *  only — tool_use/tool_result are built separately by toAnthropicMessages, which needs the
 *  surrounding message's role/tool_call_id, not just its content. */
function toAnthropicContentBlocks(content: ChatMessage['content']): AnthropicBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (content == null) return [];
  const blocks: AnthropicBlock[] = [];
  for (const b of content) {
    if (typeof b === 'string') { if (b) blocks.push({ type: 'text', text: b }); continue; }
    const block = b as { type?: string; text?: string; image_url?: { url?: unknown; mime?: unknown }; file?: { file_data?: unknown; mime?: unknown } };
    if ((block.type === 'text' || block.type === undefined) && typeof block.text === 'string') {
      if (block.text) blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'image_url' && typeof block.image_url?.url === 'string') {
      const img = base64FromDataUrl(block.image_url.url);
      if (img) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
    } else if (block.type === 'file' && typeof block.file?.file_data === 'string') {
      const file = base64FromDataUrl(block.file.file_data);
      const mime = typeof block.file.mime === 'string' ? block.file.mime : file?.mediaType;
      if (file && mime === 'application/pdf') {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data } });
      } else if (file) {
        // Anthropic's `document` block is PDF-only; any other file type is sent as an image
        // block (works for the common case — a screenshot saved with a generic mime).
        blocks.push({ type: 'image', source: { type: 'base64', media_type: file.mediaType, data: file.data } });
      }
    }
  }
  return blocks;
}

/** Internal ChatMessage[] → Anthropic's {system, messages}. Two shape differences from every
 *  OpenAI-wire message list TierMux otherwise deals with: (1) system prompt is a top-level
 *  string, never a message with role:'system'; (2) a tool result is a `user` message carrying
 *  a `tool_result` block, not its own `role:'tool'` — and since ChatMessage models each tool
 *  result as a SEPARATE message, several in a row (multi-tool-call turn) would otherwise become
 *  several consecutive `user` messages, which the API rejects ("roles must alternate"). */
function toAnthropicMessages(messages: ChatMessage[]): { system?: string; messages: AnthropicMessage[] } {
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => contentToString(m.content))
    .filter((s) => s.length > 0)
    .join('\n\n');

  const turns: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      const blocks = toAnthropicContentBlocks(m.content);
      turns.push({ role: 'user', content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] });
    } else if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      const text = contentToString(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* malformed args from a rescued call — send empty */ }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      turns.push({ role: 'assistant', content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] });
    } else if (m.role === 'tool') {
      if (!m.tool_call_id) continue;
      turns.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: contentToString(m.content) }] });
    }
  }

  // Merge consecutive same-role turns (the tool_result case above, mainly) into one — Anthropic
  // 400s on back-to-back same-role messages.
  const merged: AnthropicMessage[] = [];
  for (const turn of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) last.content.push(...turn.content);
    else merged.push({ role: turn.role, content: [...turn.content] });
  }
  return { system: systemText || undefined, messages: merged };
}

function toAnthropicTools(tools?: ChatToolDefinition[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters ?? { type: 'object', properties: {} },
  }));
}
function toAnthropicToolChoice(choice?: ChatToolChoice): Record<string, unknown> | undefined {
  if (!choice) return undefined;
  if (choice === 'none') return { type: 'none' };
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  return { type: 'tool', name: choice.function.name };
}

/** Extended-thinking budget tiers. Anthropic has no notion of "effort" — just on/off plus a
 *  token budget — so the neutral effort knob maps onto budget size instead. */
function thinkingConfig(effort?: ReasoningEffort): { type: 'enabled'; budget_tokens: number } | undefined {
  if (!effort || effort === 'off') return undefined;
  const budget = effort === 'xhigh' ? 32000 : effort === 'high' ? 16000 : effort === 'medium' ? 8000 : 2000;
  return { type: 'enabled', budget_tokens: budget };
}

function errMessage(err: unknown): string | undefined {
  const e = err as { error?: { message?: unknown } };
  return typeof e?.error?.message === 'string' ? e.error.message : undefined;
}

export class AnthropicMessagesProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly anthropicVersion: string;

  constructor(opts: AnthropicMessagesOpts) {
    super();
    this.platform = opts.platform;
    this.name = opts.name;
    this.runtimeName = opts.runtimeName ?? opts.name;
    this.baseUrl = opts.baseUrl;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.anthropicVersion = opts.anthropicVersion ?? ANTHROPIC_VERSION;
    this.skipPreflight = opts.skipPreflight ?? false;
    this.ttftTimeoutMs = opts.ttftTimeoutMs;
  }

  private resolveBaseUrl(options?: CompletionOptions): string {
    const o = options?.baseUrlOverride?.trim();
    return (o && o.length > 0 ? o : this.baseUrl).replace(/\/+$/, '');
  }

  private headers(apiKey: string): Record<string, string> {
    return {
      'x-api-key': apiKey,
      'anthropic-version': this.anthropicVersion,
      'content-type': 'application/json',
      ...this.extraHeaders,
    };
  }

  private buildBody(messages: ChatMessage[], modelId: string, options: CompletionOptions | undefined, stream: boolean): string {
    const { system, messages: wireMessages } = toAnthropicMessages(messages);
    const wireModel = this.platform === 'custom' && modelId.includes('::') ? modelId.split('::').slice(1).join('::') : modelId;
    const thinking = thinkingConfig(options?.reasoningEffort);
    const requestedMax = options?.max_tokens ?? DEFAULT_MAX_TOKENS;
    // budget_tokens must stay below max_tokens or the API rejects the request outright.
    const maxTokens = thinking ? Math.max(requestedMax, thinking.budget_tokens + 1024) : requestedMax;
    const tools = toAnthropicTools(options?.tools);
    const body: Record<string, unknown> = {
      model: wireModel,
      max_tokens: maxTokens,
      messages: wireMessages,
      ...(system ? { system } : {}),
      ...(tools ? { tools, tool_choice: toAnthropicToolChoice(options?.tool_choice) } : {}),
      // Thinking mode forbids a custom temperature/top_p (Anthropic 400s if either is set).
      ...(thinking ? { thinking } : { temperature: options?.temperature, top_p: options?.top_p }),
      ...(stream ? { stream: true } : {}),
    };
    return JSON.stringify(body);
  }

  async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): Promise<ChatCompletionResponse> {
    const res = await this.fetchWithTimeout(`${this.resolveBaseUrl(options)}/messages`, {
      method: 'POST',
      headers: this.headers(apiKey),
      body: this.buildBody(messages, modelId, options, false),
      signal: options?.abortSignal,
    }, options?.timeoutMs ?? this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${errMessage(err) ?? res.statusText}`);
    }

    let data: AnthropicResponse;
    try {
      data = (await res.json()) as AnthropicResponse;
    } catch {
      throw new Error(`${this.name} returned a non-JSON 200 body — check the base URL (it should point at the account root, e.g. https://api.anthropic.com/v1).`);
    }

    let text = '';
    let reasoningText = '';
    const toolCalls: ChatToolCall[] = [];
    for (const block of data.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      else if (block.type === 'thinking' && typeof block.thinking === 'string') reasoningText += block.thinking;
      else if (block.type === 'tool_use' && block.id && block.name) {
        toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
      }
    }
    const usage: TokenUsage = {
      prompt_tokens: data.usage?.input_tokens ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    };
    return {
      id: data.id ?? this.makeId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          ...(reasoningText ? { reasoning_content: reasoningText } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : data.stop_reason === 'max_tokens' ? 'length' : 'stop',
      }],
      usage,
      _routed_via: { platform: this.platform, model: modelId },
    };
  }

  /**
   * Anthropic's SSE events are its own shape (`message_start`/`content_block_start`/
   * `content_block_delta`/`message_delta`/`message_stop`), not OpenAI's — `base.readSseStream`
   * (which JSON.parses each frame straight into a ChatCompletionChunk) cannot be reused. Each
   * event is translated to TierMux's internal chunk shape here instead, mirroring how
   * google.ts's real-SSE path does the same thing for Gemini.
   *
   * Tool-call arguments stream as `input_json_delta` fragments (`partial_json`) keyed by block
   * index — emitted here as OpenAI-style incremental `tool_calls[].function.arguments` deltas
   * (first fragment carries `id`+`name`, later ones omit them), which is exactly the shape
   * router.ts's own accumulator (see the `toolCallsByIndex` loop) already concatenates.
   */
  async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.fetchWithTimeout(`${this.resolveBaseUrl(options)}/messages`, {
      method: 'POST',
      headers: this.headers(apiKey),
      body: this.buildBody(messages, modelId, options, true),
      signal: options?.abortSignal,
    }, options?.timeoutMs ?? this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${errMessage(err) ?? res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const id = this.makeId();
    const created = Math.floor(Date.now() / 1000);
    type WireToolCallDelta = { index: number; id?: string; type?: 'function'; function?: { name?: string; arguments?: string } };
    type WireDelta = { role?: 'assistant'; content?: string; reasoning_content?: string; tool_calls?: WireToolCallDelta[] };
    const frame = (choices: Array<{ index: number; delta: WireDelta; finish_reason: string | null }>, usage?: TokenUsage): ChatCompletionChunk =>
      ({ id, object: 'chat.completion.chunk', created, model: modelId, choices, ...(usage ? { usage } : {}) } as unknown as ChatCompletionChunk);

    const decoder = new TextDecoder();
    let buffer = '';
    const blockTypes = new Map<number, string>();
    let inputTokens = 0;
    let outputTokens = 0;
    let sawToolCall = false;
    let stopReason: string | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload) continue;
          let evt: Record<string, unknown>;
          try { evt = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }

          const evtType = evt.type as string | undefined;
          if (evtType === 'message_start') {
            const usage = (evt.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
            inputTokens = usage?.input_tokens ?? 0;
          } else if (evtType === 'content_block_start') {
            const index = evt.index as number;
            const block = evt.content_block as { type?: string; id?: string; name?: string } | undefined;
            blockTypes.set(index, block?.type ?? '');
            if (block?.type === 'tool_use' && block.id && block.name) {
              sawToolCall = true;
              yield frame([{ index: 0, delta: { role: 'assistant', tool_calls: [{ index, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] }, finish_reason: null }]);
            }
          } else if (evtType === 'content_block_delta') {
            const index = evt.index as number;
            const delta = evt.delta as Record<string, unknown> | undefined;
            const deltaType = delta?.type as string | undefined;
            if (deltaType === 'text_delta' && typeof delta?.text === 'string') {
              yield frame([{ index: 0, delta: { role: 'assistant', content: delta.text }, finish_reason: null }]);
            } else if (deltaType === 'thinking_delta' && typeof delta?.thinking === 'string') {
              yield frame([{ index: 0, delta: { role: 'assistant', reasoning_content: delta.thinking as string }, finish_reason: null }]);
            } else if (deltaType === 'input_json_delta' && typeof delta?.partial_json === 'string') {
              yield frame([{ index: 0, delta: { role: 'assistant', tool_calls: [{ index, function: { arguments: delta.partial_json as string } }] }, finish_reason: null }]);
            }
          } else if (evtType === 'message_delta') {
            const d = evt.delta as { stop_reason?: string } | undefined;
            const usage = evt.usage as { output_tokens?: number } | undefined;
            if (d?.stop_reason) stopReason = d.stop_reason;
            if (usage?.output_tokens !== undefined) outputTokens = usage.output_tokens;
          } else if (evtType === 'error') {
            const err = evt.error as { message?: string } | undefined;
            throw new Error(`${this.name} stream error: ${err?.message ?? 'unknown error'}`);
          }
        }
      }
    } finally {
      reader.cancel().catch(() => { /* stream already closed */ });
    }

    yield frame([{ index: 0, delta: {}, finish_reason: sawToolCall ? 'tool_calls' : stopReason === 'max_tokens' ? 'length' : 'stop' }]);
    yield frame([], { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens });
  }
}
