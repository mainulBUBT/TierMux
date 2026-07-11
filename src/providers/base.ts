// Provider base class. Uses the global `fetch` since the extension
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
  /**
   * Optional provider-specific preflight timeout (ms). If set, the router uses
   * this instead of the default 5s for health checks. Useful for models that
   * are slow to start (e.g., reasoning models with cold starts).
   */
  preflightTimeoutMs?: number;
  /** Skip the preflight ping entirely for this provider (e.g. slow platforms where ping costs real time). */
  skipPreflight = false;

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

  /**
   * Tiny pre-flight probe — a single-token request used by the router to
   * confirm the key works and the model exists before committing the real
   * (potentially long, token-heavy) request. Providers should implement this
   * with a SHORT timeout (default 5s) so a dead model fails over in seconds,
   * not after a full request timeout. The base implementation calls
   * `chatCompletion` with a stub user message and `max_tokens: 1`; providers
   * with a cheaper endpoint (e.g. /models) can override for less traffic.
   */
  async ping(apiKey: string, modelId: string, timeoutMs = 5000): Promise<void> {
    await this.chatCompletion(
      apiKey,
      [{ role: 'user', content: 'ping' }],
      modelId,
      { max_tokens: 1, temperature: 0, timeoutMs },
    );
  }

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
