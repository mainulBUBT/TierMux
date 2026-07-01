// Embedding provider client for the optional codebase index. Supports the free
// embedding endpoints: Google (gemini-embedding-001), Cohere (/embed), and any
// OpenAI-compatible /embeddings endpoint. Uses the SecretStore key for the
// chosen platform.
import * as vscode from 'vscode';
import type { Platform } from '../shared/types';
import type { SecretStore } from '../config/secrets';
import { getPlatformInfo } from '../providers';

export interface EmbeddingConfig {
  platform: Platform;
  model: string;
}

/** Carries the HTTP status so the retry layer can tell rate limits / server errors from hard failures. */
class EmbeddingHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | undefined, message: string) {
    super(message);
    this.name = 'EmbeddingHttpError';
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Honor a Retry-After header (seconds or HTTP-date); undefined when absent/unparseable. */
function parseRetryAfter(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  if (!Number.isNaN(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** Read the configured embedding provider/model. */
export function getEmbeddingConfig(): EmbeddingConfig {
  const cfg = vscode.workspace.getConfiguration('tiermux.embeddings');
  const platform = cfg.get<string>('provider', 'google') as Platform;
  const model = cfg.get<string>('model') || defaultEmbeddingModel(platform);
  return { platform, model };
}

function defaultEmbeddingModel(platform: Platform): string {
  switch (platform) {
    case 'google': return 'gemini-embedding-001';
    case 'cohere': return 'embed-english-v3.0';
    case 'mistral': return 'mistral-embed';
    default: return 'text-embedding-3-small';
  }
}

export class Embedder {
  constructor(private readonly secrets: SecretStore, private readonly cfg: EmbeddingConfig) {}

  /**
   * Embed a batch of texts → one vector each (same order). Retries on rate limits
   * (429) and transient server errors with exponential backoff, honoring any
   * Retry-After header — so a momentary free-tier limit pauses instead of aborting.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const key = await this.secrets.resolveKey(this.cfg.platform);
    if (key === undefined) throw new Error(`No API key set for ${this.cfg.platform} (embeddings).`);
    const MAX_RETRIES = 5;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.embedOnce(texts, key);
      } catch (e) {
        const rateLimited = e instanceof EmbeddingHttpError && (e.status === 429 || e.status >= 500);
        if (!rateLimited || attempt >= MAX_RETRIES) throw e;
        // Prefer the server's Retry-After; otherwise exponential backoff (1s,2s,4s…) capped at 30s, plus jitter.
        const base = (e as EmbeddingHttpError).retryAfterMs ?? Math.min(30000, 1000 * 2 ** attempt);
        await delay(base + Math.floor(Math.random() * 400));
      }
    }
  }

  private async embedOnce(texts: string[], key: string): Promise<number[][]> {
    if (this.cfg.platform === 'google') return this.embedGoogle(texts, key);
    if (this.cfg.platform === 'cohere') return this.embedCohere(texts, key);
    return this.embedOpenAI(texts, key);
  }

  private async embedOpenAI(texts: string[], key: string): Promise<number[][]> {
    const base = getPlatformInfo(this.cfg.platform)?.defaultBaseUrl?.replace(/\/+$/, '') ?? '';
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.cfg.model, input: texts }),
    });
    if (!res.ok) throw new EmbeddingHttpError(res.status, parseRetryAfter(res), `Embeddings ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => d.embedding);
  }

  private async embedCohere(texts: string[], key: string): Promise<number[][]> {
    const res = await fetch('https://api.cohere.ai/v1/embed', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.cfg.model, texts, input_type: 'search_document' }),
    });
    if (!res.ok) throw new EmbeddingHttpError(res.status, parseRetryAfter(res), `Cohere embed ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings;
  }

  private async embedGoogle(texts: string[], key: string): Promise<number[][]> {
    const model = this.cfg.model.startsWith('models/') ? this.cfg.model : `models/${this.cfg.model}`;
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${model}:batchEmbedContents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        requests: texts.map((t) => ({ model, content: { parts: [{ text: t }] } })),
      }),
    });
    if (!res.ok) throw new EmbeddingHttpError(res.status, parseRetryAfter(res), `Google embed ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    const data = (await res.json()) as { embeddings: Array<{ values: number[] }> };
    return data.embeddings.map((e) => e.values);
  }
}
