

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  ChatToolCall,
  ChatToolChoice,
  ChatToolDefinition,
  ReasoningEffort,
  TokenUsage,
} from '../shared/types';
import { BaseProvider, providerHttpError } from './base';
import type { CompletionOptions } from './options';
import { contentToString } from '../agent/content';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: string; args?: unknown };
  functionResponse?: { id?: string; name?: string; response?: unknown };
}
interface GeminiCandidate { content?: { parts?: GeminiPart[] }; finishReason?: string }
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  /** Set when Gemini blocked the WHOLE prompt (e.g. a scanned PDF's rasterized pages
   *  tripping safety/recitation on the input side) — `candidates` is then empty/absent,
   *  which otherwise parses as an ordinary empty-but-successful 200 response. */
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { value: parsed };
  } catch {
    return { value: raw };
  }
}
function normalizeGeminiArgs(args: unknown): string {
  return typeof args === 'string' ? args : JSON.stringify(args ?? {});
}
function toGeminiFinishReason(finishReason?: string): string {
  const r = (finishReason ?? '').toUpperCase();
  if (!r) return 'stop';
  if (r === 'MAX_TOKENS') return 'length';
  if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(r)) return 'content_filter';
  return 'stop';
}

const UNSUPPORTED = new Set([
  '$schema', '$id', '$ref', '$defs', '$comment', 'definitions', 'exclusiveMinimum', 'exclusiveMaximum',
  'patternProperties', 'unevaluatedProperties', 'unevaluatedItems', 'if', 'then', 'else',
  'contentEncoding', 'contentMediaType', 'contentSchema', 'dependentRequired', 'dependentSchemas',
  'dependencies', 'additionalProperties', 'examples', 'const', 'readOnly', 'writeOnly', 'uniqueItems',
  'not', 'allOf', 'oneOf', 'prefixItems', 'contains', 'minContains', 'maxContains', 'propertyNames',
  'multipleOf', 'deprecated',
]);
function sanitizeForGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeForGemini);
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (UNSUPPORTED.has(k)) continue;
      out[k] = sanitizeForGemini(v);
    }
    return out;
  }
  return schema;
}

function toGeminiTools(tools?: ChatToolDefinition[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  const functionDeclarations = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: sanitizeForGemini(t.function.parameters),
  }));
  return functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined;
}
function toGeminiToolConfig(toolChoice?: ChatToolChoice): { functionCallingConfig: Record<string, unknown> } | undefined {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === 'string') {
    const mode = toolChoice === 'none' ? 'NONE' : toolChoice === 'required' ? 'ANY' : 'AUTO';
    return { functionCallingConfig: { mode } };
  }
  return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolChoice.function.name] } };
}

const MAX_INLINE_BYTES = 20 * 1024 * 1024; // Gemini's per-part cap is ~20MB inline; PDFs up to this are sent natively, larger fall back to text only.
function extractInlineDataUrl(block: unknown): string | undefined {

  const iu = (block as { image_url?: unknown })?.image_url;
  if (typeof iu === 'string') return iu;
  if (iu && typeof (iu as { url?: unknown }).url === 'string') return (iu as { url: string }).url;

  const f = (block as { file?: unknown })?.file;
  if (f && typeof (f as { file_data?: unknown }).file_data === 'string') return (f as { file_data: string }).file_data;
  return undefined;
}
async function dataUrlToInlineData(url: string): Promise<{ mimeType: string; data: string } | null> {
  const dataMatch = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (dataMatch) {
    const mimeType = dataMatch[1] || 'application/octet-stream';
    const isBase64 = Boolean(dataMatch[2]);
    const payload = dataMatch[3] ?? '';
    const data = isBase64 ? payload : Buffer.from(decodeURIComponent(payload)).toString('base64');
    if (data.length === 0) return null;
    return { mimeType, data };
  }
  if (/^https?:\/\//i.test(url)) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_INLINE_BYTES) return null;
      const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
      return { mimeType, data: buf.toString('base64') };
    } catch {
      return null;
    }
  }
  return null;
}
async function userContentToParts(content: ChatMessage['content']): Promise<GeminiPart[]> {
  const parts: GeminiPart[] = [];
  const text = contentToString(content);
  if (text.length > 0) parts.push({ text });
  if (Array.isArray(content)) {
    for (const block of content) {
      const type = (block as { type?: string })?.type;

      if (type !== 'image_url' && type !== 'image' && type !== 'file') continue;
      const url = extractInlineDataUrl(block);
      if (!url) continue;
      const inlineData = await dataUrlToInlineData(url);
      if (inlineData) parts.push({ inlineData });
    }
  }
  if (parts.length === 0) parts.push({ text: '' });
  return parts;
}

async function toGeminiContents(messages: ChatMessage[]) {
  const systemMessages = messages.filter((m) => m.role === 'system').map((m) => contentToString(m.content)).filter((s) => s.length > 0);
  const toolNameByCallId = new Map<string, string>();
  for (const m of messages) for (const tc of m.tool_calls ?? []) toolNameByCallId.set(tc.id, tc.function.name);

  const contents = (await Promise.all(
    messages.filter((m) => m.role !== 'system').map(async (m): Promise<{ role: 'user' | 'model'; parts: GeminiPart[] } | null> => {
      if (m.role === 'assistant') {
        const parts: GeminiPart[] = [];
        const assistantText = contentToString(m.content);
        if (assistantText.length > 0) parts.push({ text: assistantText });
        for (const call of m.tool_calls ?? []) {
          parts.push({ functionCall: { id: call.id, name: call.function.name, args: safeParseObject(call.function.arguments) } });
        }
        if (parts.length === 0) return null;
        return { role: 'model', parts };
      }
      if (m.role === 'tool') {
        const toolCallId = m.tool_call_id;
        if (!toolCallId) return null;
        const toolName = m.name ?? toolNameByCallId.get(toolCallId) ?? 'tool';
        return { role: 'user', parts: [{ functionResponse: { id: toolCallId, name: toolName, response: safeParseObject(contentToString(m.content)) } }] };
      }
      return { role: 'user', parts: await userContentToParts(m.content) };
    }),
  )).filter((e): e is { role: 'user' | 'model'; parts: GeminiPart[] } => e !== null);

  return {
    contents,
    systemInstruction: systemMessages.length > 0 ? { parts: [{ text: systemMessages.join('\n\n') }] } : undefined,
  };
}

function extractToolCalls(parts: GeminiPart[] | undefined): ChatToolCall[] {
  const calls: ChatToolCall[] = [];
  if (!parts) return calls;
  let i = 0;
  for (const part of parts) {
    if (!part.functionCall?.name) continue;
    calls.push({
      id: part.functionCall.id ?? `call_${Date.now()}_${i++}`,
      type: 'function',
      function: { name: part.functionCall.name, arguments: normalizeGeminiArgs(part.functionCall.args) },
    });
  }
  return calls;
}
function extractText(parts: GeminiPart[] | undefined): string | null {
  if (!parts) return null;
  const text = parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('');
  return text.length > 0 ? text : null;
}

/** Map reasoning effort to a Gemini thinking budget (tokens). */
function thinkingConfig(effort?: ReasoningEffort): Record<string, unknown> | undefined {
  if (!effort || effort === 'off') return { thinkingConfig: { thinkingBudget: 0 } };

  const budget = effort === 'xhigh' ? -1 : effort === 'high' ? 24576 : effort === 'medium' ? 8192 : 2048;
  return { thinkingConfig: { thinkingBudget: budget, includeThoughts: true } };
}

export class GoogleProvider extends BaseProvider {
  readonly platform = 'google' as const;
  readonly name = 'Google AI Studio';
  /** Actually converts `type:'file'` blocks into Gemini `inlineData` parts — see dataUrlToInlineData below. */
  carriesRawPdf = true;

  private buildBody(contents: unknown, systemInstruction: unknown, options?: CompletionOptions, modelId?: string) {
    const tools = toGeminiTools(options?.tools);

    const isGemma = modelId?.startsWith('gemma-');
    const thinking = isGemma ? undefined : thinkingConfig(options?.reasoningEffort);
    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: options?.temperature,
        maxOutputTokens: options?.max_tokens,
        topP: options?.top_p,
        ...(thinking ?? {}),
      },
      tools,
      toolConfig: tools ? toGeminiToolConfig(options?.tool_choice) : undefined,
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    return body;
  }

  async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): Promise<ChatCompletionResponse> {
    const { contents, systemInstruction } = await toGeminiContents(messages);
    const base = options?.baseUrlOverride?.trim()?.replace(/\/+$/, '') || API_BASE;
    const url = `${base}/models/${modelId}:generateContent`;
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(this.buildBody(contents, systemInstruction, options, modelId)),
      signal: options?.abortSignal,
    }, options?.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `Google API error ${res.status}: ${(err as { error?: { message?: string } })?.error?.message ?? res.statusText}`);
    }

    const data = (await res.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts;
    const toolCalls = extractToolCalls(parts);
    const text = extractText(parts);
    // A blocked prompt (`promptFeedback.blockReason`) or a safety/recitation candidate with no
    // parts looks like an ordinary empty 200; throw a specific error so the user learns it was a
    // content block (rasterised-PDF requests trip this). A STOP with no parts falls through.
    const BLOCK_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'OTHER']);
    const promptBlockReason = data.promptFeedback?.blockReason;
    const candidateBlockReason = candidate?.finishReason && BLOCK_REASONS.has(candidate.finishReason.toUpperCase())
      ? candidate.finishReason
      : undefined;
    if (!parts?.length && toolCalls.length === 0 && (promptBlockReason || candidateBlockReason)) {
      const reason = promptBlockReason ?? candidateBlockReason;
      throw new Error(`Google blocked this request before generating a reply (${reason}). Try a different model, or remove/replace the attachment.`);
    }
    // Gemini reports thoughtsTokenCount SEPARATELY from candidatesTokenCount,
    // but TokenUsage's contract (and Gemini billing) treats reasoning as part
    // of completion — fold thoughts in so totals and $-savings price them.
    const thoughts = data.usageMetadata?.thoughtsTokenCount ?? 0;
    const usage: TokenUsage = {
      prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: (data.usageMetadata?.candidatesTokenCount ?? 0) + thoughts,
      total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
      ...(data.usageMetadata?.thoughtsTokenCount !== undefined ? { reasoning_tokens: thoughts } : {}),
    };
    return {
      id: this.makeId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : toGeminiFinishReason(candidate?.finishReason),
      }],
      usage,
      _routed_via: { platform: 'google', model: modelId },
    };
  }

  /** Real token-by-token streaming via `:streamGenerateContent?alt=sse`. This used to await the
   *  blocking call and yield one chunk, so every Gemini turn "splashed". Frames are Gemini-shaped,
   *  not OpenAI-shaped, so base.readSseStream cannot be reused — each is converted here. */
  async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): AsyncGenerator<ChatCompletionChunk> {
    const { contents, systemInstruction } = await toGeminiContents(messages);
    const base = options?.baseUrlOverride?.trim()?.replace(/\/+$/, '') || API_BASE;
    const url = `${base}/models/${modelId}:streamGenerateContent?alt=sse`;
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(this.buildBody(contents, systemInstruction, options, modelId)),
      signal: options?.abortSignal,
    }, options?.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `Google API error ${res.status}: ${(err as { error?: { message?: string } })?.error?.message ?? res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const id = this.makeId();
    const created = Math.floor(Date.now() / 1000);
    const frame = (choices: ChatCompletionChunk['choices'], usage?: TokenUsage): ChatCompletionChunk =>
      ({ id, object: 'chat.completion.chunk', created, model: modelId, choices, ...(usage ? { usage } : {}) });

    const decoder = new TextDecoder();
    let buffer = '';
    let sawText = false;
    let sawToolCall = false;
    let lastUsage: GeminiResponse['usageMetadata'];
    let finishReason: string | undefined;
    let promptBlockReason: string | undefined;
    let candidateBlockReason: string | undefined;
    const BLOCK_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'OTHER']);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(trimmed.indexOf(':') + 1).trim();
          if (!payload || payload === '[DONE]') continue;
          let data: GeminiResponse;
          try { data = JSON.parse(payload) as GeminiResponse; } catch { continue; }

          if (data.usageMetadata) lastUsage = data.usageMetadata;
          if (data.promptFeedback?.blockReason) promptBlockReason = data.promptFeedback.blockReason;
          const candidate = data.candidates?.[0];
          if (candidate?.finishReason) {
            finishReason = candidate.finishReason;
            if (BLOCK_REASONS.has(candidate.finishReason.toUpperCase())) candidateBlockReason = candidate.finishReason;
          }

          const parts = candidate?.content?.parts;
          // Tool calls arrive whole in Gemini (not fragmented across frames like OpenAI's
          // argument deltas), so each one is emitted as a complete tool_calls entry.
          const toolCalls = extractToolCalls(parts);
          if (toolCalls.length > 0) {
            sawToolCall = true;
            yield frame([{ index: 0, delta: { role: 'assistant', tool_calls: toolCalls }, finish_reason: null }]);
          }
          const text = extractText(parts);
          if (text) {
            sawText = true;
            yield frame([{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]);
          }
        }
      }
    } finally {
      reader.cancel().catch(() => { /* stream already closed */ });
    }

    // Same block detection the non-streaming path does: a blocked prompt otherwise looks like an
    // ordinary empty-but-200 answer, and the generic "I wasn't able to produce a response"
    // fallback upstream gives the user no clue it was a content block.
    if (!sawText && !sawToolCall && (promptBlockReason || candidateBlockReason)) {
      throw new Error(`Google blocked this request before generating a reply (${promptBlockReason ?? candidateBlockReason}). Try a different model, or remove/replace the attachment.`);
    }

    // Closing frame: real finish_reason, then a usage-only frame (the router treats usage frames
    // as data-free) so the streamed path records real token counts instead of char/4 estimates.
    yield frame([{ index: 0, delta: {}, finish_reason: sawToolCall ? 'tool_calls' : toGeminiFinishReason(finishReason) }]);
    if (lastUsage) {
      const thoughts = lastUsage.thoughtsTokenCount ?? 0;
      yield frame([], {
        prompt_tokens: lastUsage.promptTokenCount ?? 0,
        // Gemini reports thoughtsTokenCount separately from candidatesTokenCount, but TokenUsage's
        // contract (and Gemini billing) treats reasoning as part of completion — fold it in.
        completion_tokens: (lastUsage.candidatesTokenCount ?? 0) + thoughts,
        total_tokens: lastUsage.totalTokenCount ?? 0,
        ...(lastUsage.thoughtsTokenCount !== undefined ? { reasoning_tokens: thoughts } : {}),
      });
    }
  }
}
