// Google Gemini provider. Adapted from freellmapi's server/src/providers/google.ts
// (MIT): translates the neutral OpenAI shape to Gemini's generateContent API,
// including function-calling and image inlineData, and maps reasoning effort to
// generationConfig.thinkingConfig.
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
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
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

// Gemini accepts only a subset of JSON Schema; strip unsupported keys.
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
  // Standard OpenAI-style image block.
  const iu = (block as { image_url?: unknown })?.image_url;
  if (typeof iu === 'string') return iu;
  if (iu && typeof (iu as { url?: unknown }).url === 'string') return (iu as { url: string }).url;
  // Generic file block (we emit one for PDF attachments).
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
      // Accept image_url / image (OpenAI vision) AND our own 'file' (PDFs).
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
  // 'xhigh' uses -1 = dynamic budget (model thinks as much as it needs).
  const budget = effort === 'xhigh' ? -1 : effort === 'high' ? 24576 : effort === 'medium' ? 8192 : 2048;
  return { thinkingConfig: { thinkingBudget: budget, includeThoughts: true } };
}

export class GoogleProvider extends BaseProvider {
  readonly platform = 'google' as const;
  readonly name = 'Google AI Studio';

  private buildBody(contents: unknown, systemInstruction: unknown, options?: CompletionOptions, modelId?: string) {
    const tools = toGeminiTools(options?.tools);
    // Gemma models don't support thinkingConfig — only include it for Gemini models.
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
    const usage: TokenUsage = {
      prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
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

  async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): AsyncGenerator<ChatCompletionChunk> {
    // The extension uses simulated typing, so streaming just yields a single
    // synthesized chunk from the non-streaming response.
    const resp = await this.chatCompletion(apiKey, messages, modelId, options);
    const msg = resp.choices[0]?.message;
    yield {
      id: resp.id,
      object: 'chat.completion.chunk',
      created: resp.created,
      model: resp.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: contentToString(msg?.content), tool_calls: msg?.tool_calls }, finish_reason: resp.choices[0]?.finish_reason ?? 'stop' }],
    };
  }
}
