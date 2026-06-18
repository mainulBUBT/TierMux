// Optional local codebase embeddings index: chunks workspace files, embeds them
// via the configured free embedding provider, persists vectors to globalStorage,
// and serves cosine-similarity search. Incrementally re-embeds files on save.
import * as vscode from 'vscode';
import type { SecretStore } from '../config/secrets';
import { getPlatformInfo } from '../providers';
import { Embedder, getEmbeddingConfig } from './embeddings';

const EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/.venv/**}';
const EXTS = '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,c,cc,cpp,h,hpp,cs,rb,php,swift,scala,md,txt,html,css,scss,yaml,yml,sql}';
const MAX_FILES = 600;
const CHUNK_LINES = 60;
const MAX_CHUNKS_PER_FILE = 40;
const MAX_TOTAL_CHUNKS = 6000;
const BATCH = 16;

interface Chunk { file: string; startLine: number; endLine: number; text: string; vector: number[] }
interface IndexData { model: string; chunks: Chunk[] }

export interface IndexStats { built: boolean; files: number; chunks: number; model: string; building: boolean; lastError?: string }

/** Live build progress, pushed to the chat webview so it can show a transient strip. */
export interface IndexProgress { building: boolean; done: number; total: number; phase: 'scanning' | 'embedding' | 'done' | 'error' }

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
function chunkFile(file: string, text: string): Array<{ file: string; startLine: number; endLine: number; text: string }> {
  const lines = text.split('\n');
  const out: Array<{ file: string; startLine: number; endLine: number; text: string }> = [];
  for (let i = 0; i < lines.length && out.length < MAX_CHUNKS_PER_FILE; i += CHUNK_LINES) {
    const slice = lines.slice(i, i + CHUNK_LINES);
    const body = slice.join('\n').trim();
    if (body.length > 0) out.push({ file, startLine: i + 1, endLine: Math.min(i + CHUNK_LINES, lines.length), text: `// ${file}\n${slice.join('\n')}` });
  }
  return out;
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CodebaseIndex {
  private chunks: Chunk[] = [];
  private model = '';
  private building = false;
  private lastError?: string;
  private loaded = false;
  private progressFn?: (p: IndexProgress) => void;

  constructor(private readonly storageUri: vscode.Uri, private readonly secrets: SecretStore) {}

  /** Subscribe to live build progress (the chat view forwards this to the webview). */
  onProgress(fn: (p: IndexProgress) => void): void { this.progressFn = fn; }
  private emit(p: IndexProgress): void { try { this.progressFn?.(p); } catch { /* listener error — ignore */ } }

  private fileUri(): vscode.Uri {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? 'global';
    return vscode.Uri.joinPath(this.storageUri, `index-${djb2(ws)}.json`);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri());
      const data = JSON.parse(new TextDecoder().decode(bytes)) as IndexData;
      this.chunks = data.chunks ?? [];
      this.model = data.model ?? '';
    } catch { /* no index yet */ }
  }

  private async save(): Promise<void> {
    try { await vscode.workspace.fs.createDirectory(this.storageUri); } catch { /* exists */ }
    const data: IndexData = { model: this.model, chunks: this.chunks };
    await vscode.workspace.fs.writeFile(this.fileUri(), new TextEncoder().encode(JSON.stringify(data)));
  }

  stats(): IndexStats {
    const files = new Set(this.chunks.map((c) => c.file)).size;
    return { built: this.chunks.length > 0, files, chunks: this.chunks.length, model: this.model, building: this.building, lastError: this.lastError };
  }

  isEnabled(): boolean {
    return vscode.workspace.getConfiguration('tiermux.embeddings').get<boolean>('enabled', false);
  }

  hasIndex(): boolean {
    return this.chunks.length > 0;
  }

  async build(): Promise<void> {
    if (this.building) return;
    this.building = true;
    this.lastError = undefined;
    this.emit({ building: true, done: 0, total: 0, phase: 'scanning' });
    const cfg = getEmbeddingConfig();
    const embedder = new Embedder(this.secrets, cfg);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Indexing codebase…', cancellable: true },
        async (progress, token) => {
          const files = await vscode.workspace.findFiles(EXTS, EXCLUDE, MAX_FILES);
          const pending: Array<{ file: string; startLine: number; endLine: number; text: string }> = [];
          for (const f of files) {
            if (token.isCancellationRequested) return;
            try {
              const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(f));
              for (const c of chunkFile(vscode.workspace.asRelativePath(f), text)) {
                if (pending.length < MAX_TOTAL_CHUNKS) pending.push(c);
              }
            } catch { /* skip */ }
          }
          const embCfg = vscode.workspace.getConfiguration('tiermux.embeddings');
          const batchSize = Math.max(1, embCfg.get<number>('batchSize', BATCH));
          const baseDelay = Math.max(0, embCfg.get<number>('requestDelayMs', 150));
          const built: Chunk[] = [];
          let rateLimitReason: string | undefined;
          for (let i = 0; i < pending.length; i += batchSize) {
            if (token.isCancellationRequested) break;
            const batch = pending.slice(i, i + batchSize);
            let vecs: number[][];
            try {
              vecs = await embedder.embed(batch.map((b) => b.text));
            } catch (e) {
              // embed() already retried with backoff — reaching here means the limit
              // is sticky (e.g. a daily quota). Keep what we embedded rather than
              // throwing away the whole run; the user can resume later.
              rateLimitReason = e instanceof Error ? e.message : String(e);
              break;
            }
            batch.forEach((b, j) => built.push({ ...b, vector: vecs[j] ?? [] }));
            const done = Math.min(i + batchSize, pending.length);
            progress.report({ message: `${done}/${pending.length} chunks`, increment: (batchSize / Math.max(1, pending.length)) * 100 });
            this.emit({ building: true, done, total: pending.length, phase: 'embedding' });
            await delay(baseDelay); // gentle on free-tier rate limits
          }
          // A sticky limit with nothing embedded is a real failure; with partial
          // results, save them and let search use the partial index.
          if (rateLimitReason && built.length === 0) throw new Error(rateLimitReason);
          this.chunks = built;
          this.model = `${cfg.platform}/${cfg.model}`;
          await this.save();
          if (rateLimitReason) {
            void vscode.window.showWarningMessage(
              `Indexed ${built.length}/${pending.length} chunks before the embedding provider rate-limited. Search uses this partial index — run “Build Index” again later to finish, or raise tiermux.embeddings.requestDelayMs.`,
            );
          }
        },
      );
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`Indexing failed: ${this.lastError}`);
    } finally {
      this.building = false;
      this.emit({ building: false, done: this.chunks.length, total: this.chunks.length, phase: this.lastError ? 'error' : 'done' });
    }
  }

  /** Whether the configured embedding provider has a usable key (or is keyless). */
  async providerConfigured(): Promise<boolean> {
    const { platform } = getEmbeddingConfig();
    if (getPlatformInfo(platform)?.keyless) return true;
    return !!(await this.secrets.resolveKey(platform));
  }

  /**
   * Cursor-style auto-indexing: build automatically the first time the index is
   * enabled with a configured provider and an open workspace — no manual click.
   * No-ops if already built, already building, disabled, keyless-unset, or no folder.
   */
  async maybeAutoBuild(): Promise<void> {
    if (this.building) return;
    if (!this.isEnabled()) return;
    if (!vscode.workspace.workspaceFolders?.length) return;
    await this.load();
    if (this.hasIndex()) return; // already built — incremental updates handle the rest
    if (!(await this.providerConfigured())) return;
    await this.build();
  }

  async clear(): Promise<void> {
    this.chunks = [];
    this.model = '';
    try { await vscode.workspace.fs.delete(this.fileUri()); } catch { /* none */ }
  }

  /** Re-embed a single saved file's chunks (incremental update). */
  async updateFile(uri: vscode.Uri): Promise<void> {
    if (!this.isEnabled() || !this.hasIndex() || this.building) return;
    const rel = vscode.workspace.asRelativePath(uri);
    if (!this.chunks.some((c) => c.file === rel)) return; // only update files already indexed
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      const pieces = chunkFile(rel, text);
      const embedder = new Embedder(this.secrets, getEmbeddingConfig());
      const vecs = await embedder.embed(pieces.map((p) => p.text));
      this.chunks = this.chunks.filter((c) => c.file !== rel);
      pieces.forEach((p, j) => this.chunks.push({ ...p, vector: vecs[j] ?? [] }));
      await this.save();
    } catch { /* leave stale chunks */ }
  }

  /** Semantic search: cosine recall → rerank → top-k chunks. */
  async search(query: string, k = 8): Promise<Array<{ file: string; startLine: number; endLine: number; text: string; score: number }>> {
    await this.load();
    if (!this.chunks.length) return [];
    const [qv] = await new Embedder(this.secrets, getEmbeddingConfig()).embed([query]);
    if (!qv) return [];
    const candidates = this.chunks
      .map((c) => ({ c, score: cosine(qv, c.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(k * 4, 24));
    const ranked = await this.rerank(query, candidates, k);
    return ranked.map((x) => ({ file: x.c.file, startLine: x.c.startLine, endLine: x.c.endLine, text: x.c.text, score: Number(x.score.toFixed(3)) }));
  }

  /** Rerank candidates: Cohere /rerank if a Cohere key is set, else a lexical blend. */
  private async rerank(query: string, candidates: Array<{ c: Chunk; score: number }>, k: number): Promise<Array<{ c: Chunk; score: number }>> {
    const on = vscode.workspace.getConfiguration('tiermux.embeddings').get<boolean>('rerank', true);
    if (!on || candidates.length <= k) return candidates.slice(0, k);
    try {
      const key = await this.secrets.resolveKey('cohere');
      if (key) {
        const res = await fetch('https://api.cohere.ai/v1/rerank', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'rerank-english-v3.0', query, documents: candidates.map((c) => c.c.text.slice(0, 2000)), top_n: k }),
        });
        if (res.ok) {
          const data = (await res.json()) as { results: Array<{ index: number; relevance_score: number }> };
          const order = data.results.map((r) => candidates[r.index] && { c: candidates[r.index].c, score: r.relevance_score }).filter((x): x is { c: Chunk; score: number } => !!x);
          if (order.length) return order.slice(0, k);
        }
      }
    } catch { /* fall through to lexical */ }
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return candidates
      .map(({ c, score }) => {
        const low = c.text.toLowerCase();
        const overlap = terms.length ? terms.filter((t) => low.includes(t)).length / terms.length : 0;
        return { c, score: score * 0.7 + overlap * 0.3 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
