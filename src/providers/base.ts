

import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage, Platform } from '../shared/types';
import type { CompletionOptions } from './options';
import { diagLog } from '../util/diag';

/** A provider HTTP error carrying the upstream status and optional Retry-After. */
export class ProviderHttpError extends Error {
  status?: number;
  retryAfterMs?: number;
  constructor(message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parse an HTTP `Retry-After` header (delta-seconds or HTTP-date) into ms. */
function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}

export function providerHttpError(res: Response, message: string): ProviderHttpError {
  return new ProviderHttpError(message, res.status, parseRetryAfterMs(res.headers?.get('retry-after')));
}

export abstract class BaseProvider {
  abstract readonly platform: Platform;
  abstract readonly name: string;
  /** Runtime display name for custom endpoints (no-op for built-ins, which leave undefined). */
  runtimeName?: string;
  /** Providers whose free tier needs no API key (Kilo/Pollinations/OVH anon). */
  keyless = false;
  /** Registry metadata from the retired scoring Router's preflight/TTFT machinery. Nothing
   *  reads these any more; kept because the auto-synced registry (scripts/sync-providers.mjs)
   *  still emits `skipPreflight: true`. */
  preflightTimeoutMs?: number;
  skipPreflight = false;
  ttftTimeoutMs?: number;
  /** Whether this provider forwards a `type:'file'` block (raw PDF bytes) rather than dropping it.
   *  Distinct from image support: most OpenAI-compat providers forward `image_url` but have no
   *  code path for file parts. */
  carriesRawPdf = false;

  abstract chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse>;

  abstract streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk>;

  /** `init.signal` is combined with the timeout controller (it used to be overwritten, so Stop
   *  never reached the in-flight request). timeoutMs <= 0 means NO self-imposed timeout — custom
   *  endpoints, where a local cold load may legally take minutes. */
  protected async fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 60000): Promise<Response> {
    const controller = new AbortController();
    const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    const signal = init.signal ? AbortSignal.any([init.signal as AbortSignal, controller.signal]) : controller.signal;
    try {
      return await fetch(url, { ...init, signal });
    } catch (e) {
      if (timeout !== undefined && controller.signal.aborted) {
        throw new ProviderHttpError(`${this.name} request timed out after ${timeoutMs}ms`, 408);
      }
      throw e;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  protected makeId(): string {
    return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Shared SSE reader for OpenAI-wire streaming endpoints. */
  protected async *readSseStream(res: Response): AsyncGenerator<ChatCompletionChunk> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    let buffer = '';
    // Diagnostic capture (tiermux.agent.diagTrace): the reader drops any non-`data:` line, so a
    // plain JSON body or HTML error page on stream:true came back "instant empty" with no trace.
    let rawSampled = 0;
    let chunkCount = 0;
    const ctype = res.headers.get('content-type') || '<none>';
    // Some gateways answer a stream:true request with a single non-SSE JSON body (no `data:`
    // prefix). The line loop skips it entirely → 0 chunks → instant empty. Accumulate the raw
    // bytes (capped) so we can fall back to a one-shot JSON parse when no SSE chunks arrived.
    let fullRaw = '';
    const RAW_CAP = 2_000_000;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const piece = decoder.decode(value, { stream: true });
        buffer += piece;
        // Only needed for the zero-chunk fallback below — once a real chunk has parsed this
        // stream is a normal SSE stream, so stop copying every subsequent piece into it too.
        if (chunkCount === 0 && fullRaw.length < RAW_CAP) fullRaw += piece;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (rawSampled < 5 && trimmed) {
            diagLog('sse.raw', `content-type=${ctype} line=${JSON.stringify(trimmed.slice(0, 200))}`);
            rawSampled++;
          }
          if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(trimmed.indexOf(':') + 1).trim();
          if (data === '[DONE]') return;
          try {
            const chunk = JSON.parse(data) as ChatCompletionChunk;
            chunkCount++;
            // OpenAI-wire streams report reasoning tokens under
            // usage.completion_tokens_details; lift them to our flat
            // reasoning_tokens field (mirrors the non-stream path).
            const details = (chunk.usage as unknown as { completion_tokens_details?: { reasoning_tokens?: number } } | undefined)?.completion_tokens_details;
            if (chunk.usage && chunk.usage.reasoning_tokens === undefined && details?.reasoning_tokens !== undefined) {
              chunk.usage.reasoning_tokens = details.reasoning_tokens;
            }
            yield chunk;
          } catch (e) {
            diagLog('sse.parsefail', `content-type=${ctype} data=${JSON.stringify(data.slice(0, 200))} err=${(e as Error).message}`);
          }
        }
      }
      // Fallback: the upstream ignored stream:true and returned one JSON object (common with
      // thin gateways). Re-parse it as a non-streaming completion so the turn isn't blank.
      if (chunkCount === 0 && fullRaw.trim()) {
        const bodyText = fullRaw.trim();
        try {
          const parsed = JSON.parse(bodyText) as ChatCompletionResponse;
          if (parsed?.choices?.length) {
            diagLog('sse.fallback', `content-type=${ctype} 0 SSE chunks; recovered one-shot JSON with ${parsed.choices.length} choice(s)`);
            yield {
              id: parsed.id ?? `chatcmpl-fb-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: parsed.created ?? Math.floor(Date.now() / 1000),
              model: parsed.model ?? '',
              choices: (parsed.choices).map((c, i) => ({
                index: c.index ?? i,
                delta: {
                  role: 'assistant',
                  ...(typeof c.message?.content === 'string' ? { content: c.message.content } : {}),
                  ...(c.message?.tool_calls ? { tool_calls: c.message.tool_calls } : {}),
                },
                finish_reason: c.finish_reason ?? 'stop',
              })),
              ...(parsed.usage ? { usage: parsed.usage } : {}),
            };
            chunkCount = parsed.choices.length;
          }
        } catch (e) {
          diagLog('sse.fallbackfail', `content-type=${ctype} bodyHead=${JSON.stringify(bodyText.slice(0, 200))} err=${(e as Error).message}`);
        }
      }
    } finally {
      diagLog('sse.summary', `content-type=${ctype} parsedChunks=${chunkCount} (0 chunks ⇒ instant-empty bug)`);
      reader.cancel().catch(() => { /* upstream already gone */ });
    }
  }
}
