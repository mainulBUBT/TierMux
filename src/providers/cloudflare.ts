

import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '../shared/types';
import { BaseProvider, providerHttpError } from './base';
import type { CompletionOptions } from './options';
import { flattenMessageContent } from '../agent/content';

export class CloudflareProvider extends BaseProvider {
  readonly platform = 'cloudflare' as const;
  readonly name = 'Cloudflare Workers AI';

  private parseKey(apiKey: string): { accountId: string; token: string } {
    const sep = apiKey.indexOf(':');
    if (sep === -1) throw new Error('Cloudflare key must be "account_id:api_token"');
    return { accountId: apiKey.slice(0, sep), token: apiKey.slice(sep + 1) };
  }

  private url(accountId: string): string {
    return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
  }

  private body(messages: ChatMessage[], modelId: string, options: CompletionOptions | undefined, stream: boolean): string {
    return JSON.stringify({
      model: modelId,
      messages: flattenMessageContent(messages),
      temperature: options?.temperature,
      max_tokens: options?.max_tokens,
      top_p: options?.top_p,
      tools: options?.tools,
      tool_choice: options?.tool_choice,
      ...(stream ? { stream: true } : {}),
    });
  }

  async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): Promise<ChatCompletionResponse> {
    const { accountId, token } = this.parseKey(apiKey);
    const res = await this.fetchWithTimeout(this.url(accountId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: this.body(messages, modelId, options, false),
    }, options?.timeoutMs);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `Cloudflare API error ${res.status}: ${cfErr(err) ?? res.statusText}`);
    }
    const data = (await res.json()) as ChatCompletionResponse;
    data._routed_via = { platform: 'cloudflare', model: modelId };
    return data;
  }

  async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): AsyncGenerator<ChatCompletionChunk> {
    const { accountId, token } = this.parseKey(apiKey);
    const res = await this.fetchWithTimeout(this.url(accountId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: this.body(messages, modelId, options, true),
    }, options?.timeoutMs);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `Cloudflare API error ${res.status}: ${cfErr(err) ?? res.statusText}`);
    }
    yield* this.readSseStream(res);
  }
}

function cfErr(err: unknown): string | undefined {
  const e = err as { error?: { message?: string }; errors?: Array<{ message?: string }> };
  return e?.error?.message ?? e?.errors?.[0]?.message;
}
