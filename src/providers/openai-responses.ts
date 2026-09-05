

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

export interface OpenAIResponsesOpts {
  platform: Platform;
  name: string;
  runtimeName?: string;
  baseUrl: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  skipPreflight?: boolean;
  ttftTimeoutMs?: number;
}

/** A subset of the Responses API's `input` item union — only what this adapter emits. */
type ResponsesInputItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

interface ResponsesOutputItem {
  type?: string;
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  summary?: Array<{ type?: string; text?: string }>;
  call_id?: string;
  name?: string;
  arguments?: string;
}
interface ResponsesResponse {
  id?: string;
  output?: ResponsesOutputItem[];
  status?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };
}

function base64FromDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  const mediaType = m[1] || 'application/octet-stream';
  const payload = m[3] ?? '';
  const data = m[2] ? payload : Buffer.from(decodeURIComponent(payload)).toString('base64');
  return data.length > 0 ? { mediaType, data } : null;
}

/** A user/assistant turn's content → the Responses API's content-item array. Unlike Chat
 *  Completions, an image is `input_image` with a bare `image_url` STRING (not `{url:...}`),
 *  and a replayed assistant turn uses `output_text` items, not `input_text`. */
function toResponsesContent(content: ChatMessage['content'], role: 'user' | 'assistant'): Array<Record<string, unknown>> {
  const textType = role === 'assistant' ? 'output_text' : 'input_text';
  if (typeof content === 'string') return content ? [{ type: textType, text: content }] : [];
  if (content == null) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const b of content) {
    if (typeof b === 'string') { if (b) out.push({ type: textType, text: b }); continue; }
    const block = b as { type?: string; text?: string; image_url?: { url?: unknown }; file?: { file_data?: unknown; filename?: unknown } };
    if ((block.type === 'text' || block.type === undefined) && typeof block.text === 'string') {
      if (block.text) out.push({ type: textType, text: block.text });
    } else if (block.type === 'image_url' && typeof block.image_url?.url === 'string' && role === 'user') {
      out.push({ type: 'input_image', image_url: block.image_url.url });
    } else if (block.type === 'file' && typeof block.file?.file_data === 'string' && role === 'user') {
      const decoded = base64FromDataUrl(block.file.file_data);
      out.push({
        type: 'input_file',
        filename: typeof block.file.filename === 'string' ? block.file.filename : 'attachment.pdf',
        file_data: decoded ? `data:${decoded.mediaType};base64,${decoded.data}` : block.file.file_data,
      });
    }
  }
  return out;
}

/** Internal ChatMessage[] → {instructions, input}. Tool calls/results are FLAT typed items in
 *  `input` (function_call / function_call_output), not nested inside a message — unlike
 *  Anthropic, the Responses API has no role-alternation constraint to work around. */
function toResponsesInput(messages: ChatMessage[]): { instructions?: string; input: ResponsesInputItem[] } {
  const instructions = messages
    .filter((m) => m.role === 'system')
    .map((m) => contentToString(m.content))
    .filter((s) => s.length > 0)
    .join('\n\n');

  const input: ResponsesInputItem[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      const content = toResponsesContent(m.content, 'user');
      if (content.length > 0) input.push({ type: 'message', role: 'user', content });
    } else if (m.role === 'assistant') {
      const content = toResponsesContent(m.content, 'assistant');
      if (content.length > 0) input.push({ type: 'message', role: 'assistant', content });
      for (const tc of m.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}' });
      }
    } else if (m.role === 'tool') {
      if (!m.tool_call_id) continue;
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: contentToString(m.content) });
    }
  }
  return { instructions: instructions || undefined, input };
}

function toResponsesTools(tools?: ChatToolDefinition[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  // Flat shape — {type,name,description,parameters} — unlike Chat Completions' nested
  // {type:'function', function:{name,...}}.
  return tools.map((t) => ({
    type: 'function',
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters ?? { type: 'object', properties: {} },
  }));
}
function toResponsesToolChoice(choice?: ChatToolChoice): unknown {
  if (!choice) return undefined;
  if (typeof choice === 'string') return choice; // 'auto' | 'none' | 'required' pass straight through
  return { type: 'function', name: choice.function.name };
}

/** Reasoning models (o-series, gpt-5-thinking, …) take a coarse effort enum, not a token
 *  budget — 'xhigh' has no separate tier here and folds into 'high'. */
function reasoningField(effort?: ReasoningEffort): { effort: 'low' | 'medium' | 'high' } | undefined {
  if (!effort || effort === 'off') return undefined;
  return { effort: effort === 'xhigh' ? 'high' : effort };
}

function errMessage(err: unknown): string | undefined {
  const e = err as { error?: { message?: unknown } };
  return typeof e?.error?.message === 'string' ? e.error.message : undefined;
}

export class OpenAIResponsesProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(opts: OpenAIResponsesOpts) {
    super();
    this.platform = opts.platform;
    this.name = opts.name;
    this.runtimeName = opts.runtimeName ?? opts.name;
    this.baseUrl = opts.baseUrl;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.skipPreflight = opts.skipPreflight ?? false;
    this.ttftTimeoutMs = opts.ttftTimeoutMs;
  }

  private resolveBaseUrl(options?: CompletionOptions): string {
    const o = options?.baseUrlOverride?.trim();
    return (o && o.length > 0 ? o : this.baseUrl).replace(/\/+$/, '');
  }

  private authHeader(apiKey: string): Record<string, string> {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }

  private buildBody(messages: ChatMessage[], modelId: string, options: CompletionOptions | undefined, stream: boolean): string {
    const { instructions, input } = toResponsesInput(messages);
    const wireModel = this.platform === 'custom' && modelId.includes('::') ? modelId.split('::').slice(1).join('::') : modelId;
    const reasoning = reasoningField(options?.reasoningEffort);
    const body: Record<string, unknown> = {
      model: wireModel,
      input,
      ...(instructions ? { instructions } : {}),
      temperature: options?.temperature,
      top_p: options?.top_p,
      max_output_tokens: options?.max_tokens,
      tools: toResponsesTools(options?.tools),
      tool_choice: options?.tools?.length ? toResponsesToolChoice(options?.tool_choice) : undefined,
      ...(reasoning ? { reasoning } : {}),
      ...(stream ? { stream: true } : {}),
    };
    return JSON.stringify(body);
  }

  /** A response's `output` array holds message items (assistant text) and function_call items
   *  side by side, in emission order — both are folded into one internal ChatMessage here. */
  private parseOutput(output: ResponsesOutputItem[] | undefined): { text: string; reasoning: string; toolCalls: ChatToolCall[] } {
    let text = '';
    let reasoning = '';
    const toolCalls: ChatToolCall[] = [];
    for (const item of output ?? []) {
      if (item.type === 'message') {
        for (const c of item.content ?? []) {
          if ((c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string') text += c.text;
        }
      } else if (item.type === 'function_call' && item.call_id && item.name) {
        toolCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments ?? '{}' } });
      } else if (item.type === 'reasoning') {
        for (const c of item.summary ?? []) {
          if (typeof c.text === 'string') reasoning += c.text;
        }
      }
    }
    return { text, reasoning, toolCalls };
  }

  async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): Promise<ChatCompletionResponse> {
    const res = await this.fetchWithTimeout(`${this.resolveBaseUrl(options)}/responses`, {
      method: 'POST',
      headers: { ...this.authHeader(apiKey), 'Content-Type': 'application/json', ...this.extraHeaders },
      body: this.buildBody(messages, modelId, options, false),
      signal: options?.abortSignal,
    }, options?.timeoutMs ?? this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${errMessage(err) ?? res.statusText}`);
    }

    let data: ResponsesResponse;
    try {
      data = (await res.json()) as ResponsesResponse;
    } catch {
      throw new Error(`${this.name} returned a non-JSON 200 body — the endpoint may not implement the Responses API. Check the base URL and protocol type.`);
    }

    const { text, reasoning, toolCalls } = this.parseOutput(data.output);
    const reasoningTokens = data.usage?.output_tokens_details?.reasoning_tokens;
    const usage: TokenUsage = {
      prompt_tokens: data.usage?.input_tokens ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens: data.usage?.total_tokens ?? 0,
      ...(reasoningTokens !== undefined ? { reasoning_tokens: reasoningTokens } : {}),
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
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : data.status === 'incomplete' ? 'length' : 'stop',
      }],
      usage,
      _routed_via: { platform: this.platform, model: modelId },
    };
  }

  /** Responses API SSE events (`response.output_text.delta`, `response.function_call_arguments.
   *  delta`, …) are their own shape; translated to the internal chunk shape here like google.ts
   *  and anthropic-messages.ts do. */
  async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.fetchWithTimeout(`${this.resolveBaseUrl(options)}/responses`, {
      method: 'POST',
      headers: { ...this.authHeader(apiKey), 'Content-Type': 'application/json', ...this.extraHeaders },
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
    // output_index -> call_id, so an arguments-delta event (which repeats only the index) can
    // still be attributed to the right tool_calls[].index slot.
    const callIdByIndex = new Map<number, string>();
    let sawToolCall = false;
    let finalStatus: string | undefined;
    let usage: TokenUsage | undefined;

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
          if (!payload || payload === '[DONE]') continue;
          let evt: Record<string, unknown>;
          try { evt = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }

          const evtType = evt.type as string | undefined;
          if (evtType === 'response.output_item.added') {
            const item = evt.item as { type?: string; call_id?: string; name?: string } | undefined;
            const outputIndex = (evt.output_index as number | undefined) ?? 0;
            if (item?.type === 'function_call' && item.call_id && item.name) {
              sawToolCall = true;
              callIdByIndex.set(outputIndex, item.call_id);
              yield frame([{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: outputIndex, id: item.call_id, type: 'function', function: { name: item.name, arguments: '' } }] }, finish_reason: null }]);
            }
          } else if (evtType === 'response.output_text.delta') {
            const delta = evt.delta as string | undefined;
            if (typeof delta === 'string') yield frame([{ index: 0, delta: { role: 'assistant', content: delta }, finish_reason: null }]);
          } else if (evtType === 'response.function_call_arguments.delta') {
            const outputIndex = (evt.output_index as number | undefined) ?? 0;
            const delta = evt.delta as string | undefined;
            if (typeof delta === 'string' && callIdByIndex.has(outputIndex)) {
              yield frame([{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: outputIndex, function: { arguments: delta } }] }, finish_reason: null }]);
            }
          } else if (evtType === 'response.reasoning_summary_text.delta' || evtType === 'response.reasoning.delta') {
            const delta = evt.delta as string | undefined;
            if (typeof delta === 'string') yield frame([{ index: 0, delta: { role: 'assistant', reasoning_content: delta }, finish_reason: null }]);
          } else if (evtType === 'response.completed' || evtType === 'response.incomplete') {
            const response = evt.response as ResponsesResponse | undefined;
            finalStatus = response?.status;
            const reasoningTokens = response?.usage?.output_tokens_details?.reasoning_tokens;
            usage = {
              prompt_tokens: response?.usage?.input_tokens ?? 0,
              completion_tokens: response?.usage?.output_tokens ?? 0,
              total_tokens: response?.usage?.total_tokens ?? 0,
              ...(reasoningTokens !== undefined ? { reasoning_tokens: reasoningTokens } : {}),
            };
          } else if (evtType === 'error' || evtType === 'response.failed') {
            const err = (evt.error ?? (evt.response as { error?: { message?: string } } | undefined)?.error) as { message?: string } | undefined;
            throw new Error(`${this.name} stream error: ${err?.message ?? 'unknown error'}`);
          }
        }
      }
    } finally {
      reader.cancel().catch(() => { /* stream already closed */ });
    }

    yield frame([{ index: 0, delta: {}, finish_reason: sawToolCall ? 'tool_calls' : finalStatus === 'incomplete' ? 'length' : 'stop' }]);
    if (usage) yield frame([], usage);
  }
}
