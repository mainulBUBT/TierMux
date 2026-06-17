// Provider base class. Adapted from freellmapi's server/src/providers/base.ts
// (MIT) — `proxyFetch` is replaced with the global `fetch` since the extension
// talks to providers directly (no proxy server).
import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage, Platform } from '../shared/types';
import type { CompletionOptions } from './options';

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
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
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
  /** Providers whose free tier needs no API key (Kilo/Pollinations/OVH anon). */
  keyless = false;

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

  protected async fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 60000): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new ProviderHttpError(`${this.name} request timed out after ${timeoutMs}ms`, 408);
      }
      throw e;
    } finally {
      clearTimeout(timeout);
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
          const data = trimmed.slice(trimmed.indexOf(':') + 1).trim();
          if (data === '[DONE]') return;
          try {
            yield JSON.parse(data) as ChatCompletionChunk;
          } catch {
            // skip malformed chunk
          }
        }
      }
    } finally {
      reader.cancel().catch(() => { /* upstream already gone */ });
    }
  }
}
