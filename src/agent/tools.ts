// Workspace tool implementations. All paths are confined to the workspace root.
import * as vscode from 'vscode';
import { EditGate } from '../edits/applyEdit';
import { CommandGate } from '../edits/commandGate';
import { buildRepoMapSummary } from './repoMap';
import { loadSkill, listSkills } from './skills';
import type { RunContext } from './runContext';
import { buildStructuralGraph, loadStructuralGraph, graphSummary, symbolGraph } from '../context/structuralGraph';
import { analyzeImpact, impactMarkdown } from '../context/impactAnalysis';
import { editConflicts, markEditing } from './editLock';
import { extractDocxText, extractPdfText, IMAGE_BYTE_LIMIT, isSupportedAttachmentPath, kindForPath, mimeForPath } from '../util/extractAttachments';
import type { ChatMessage } from '../shared/types';
import { search as ddgSearch, searchNews as ddgSearchNews, SafeSearchType } from 'duck-duck-scrape';

const MAX_READ_BYTES = 100 * 1024;
// Default cap on readFile return size. A 500-line file ≈ 30 KB; without a cap it sits in the
// transcript for every subsequent model call, causing 1M+ input-token blowouts on long tasks.
// The model sees totalLines + a notice, and can re-call with startLine/endLine for any range.
const READ_DEFAULT_CAP = 6000;
const MAX_SEARCH_RESULTS = 12; // was 40 — cut to match grep's MAX_FILES cap
const MAX_DOC_CHARS_DEFAULT = 60_000;
const EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/.venv/**}';
const SEARCH_CACHE_TTL_MS = 30_000; // 30 seconds

interface FileCacheEntry { mtime: number; content: string }
interface SearchCacheEntry { result: string; ts: number }

export interface CacheStats {
  fileCache: { entries: number; sizeKb: number; enabled: boolean };
  searchCache: { entries: number; enabled: boolean };
}

export interface ToolEvent {
  toolCallId: string;
  name: string;
  args: unknown;
  state: 'running' | 'done' | 'error';
  detail?: string;
}

export class WorkspaceTools {
  private fileCache = new Map<string, FileCacheEntry>();
  private searchCache = new Map<string, SearchCacheEntry>();
  private fileCacheEnabled: boolean;
  private searchCacheEnabled: boolean;

  constructor(
    private readonly editGate: EditGate,
    private readonly commandGate: CommandGate,
  ) {
    const cfg = vscode.workspace.getConfiguration('tiermux.cache');
    this.fileCacheEnabled = cfg.get<boolean>('fileEnabled', true);
    this.searchCacheEnabled = cfg.get<boolean>('searchEnabled', true);
  }

  setFileCacheEnabled(enabled: boolean): void { this.fileCacheEnabled = enabled; if (!enabled) this.fileCache.clear(); }
  setSearchCacheEnabled(enabled: boolean): void { this.searchCacheEnabled = enabled; if (!enabled) this.searchCache.clear(); }

  clearFileCache(): void { this.fileCache.clear(); }
  clearSearchCache(): void { this.searchCache.clear(); }

  getCacheStats(): CacheStats {
    let sizeBytes = 0;
    for (const v of this.fileCache.values()) sizeBytes += v.content.length * 2;
    return {
      fileCache: { entries: this.fileCache.size, sizeKb: Math.round(sizeBytes / 1024), enabled: this.fileCacheEnabled },
      searchCache: { entries: this.searchCache.size, enabled: this.searchCacheEnabled },
    };
  }

  private root(): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) throw new Error('No workspace folder is open.');
    return folders[0].uri;
  }

  /** Resolve a workspace-relative path, rejecting traversal outside the root. */
  private resolve(p: string): vscode.Uri {
    const root = this.root();
    const cleaned = p.replace(/^\/+/, '');
    const uri = vscode.Uri.joinPath(root, cleaned);
    if (!uri.path.startsWith(root.path)) throw new Error(`Path escapes the workspace: ${p}`);
    return uri;
  }

  /** Execute a tool by name. Returns either a string observation (most tools) or a
   *  multimodal content array (readImage). Never throws. */
  async execute(name: string, rawArgs: string, ctx?: RunContext): Promise<string | ChatMessage['content']> {
    let args: Record<string, unknown> = {};
    try {
      args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      return JSON.stringify({ error: 'Invalid JSON arguments.' });
    }
    try {
      switch (name) {
        case 'readFile': return await this.readFile(
          String(args.path ?? ''),
          args.startLine != null ? Number(args.startLine) : undefined,
          args.endLine != null ? Number(args.endLine) : undefined,
        );
        case 'listDir': return await this.listDir(String(args.path ?? '.'));
        case 'repoMap': return await this.repoMap();
        case 'searchWorkspace': return await this.searchWorkspace(String(args.query ?? ''));
        case 'getDiagnostics': return await this.getDiagnostics(args.path ? String(args.path) : undefined);
        case 'runCommand': return await this.runCommand(String(args.command ?? ''), args.cwd ? String(args.cwd) : undefined, ctx);
        case 'writeFile': return await this.writeFile(String(args.path ?? ''), String(args.content ?? ''), ctx);
        case 'createFile': return await this.createFile(String(args.path ?? ''), String(args.content ?? ''), ctx);
        case 'editFile': return await this.editFile(String(args.path ?? ''), String(args.search ?? ''), String(args.replace ?? ''), ctx);
        case 'deleteFile': return await this.deleteFile(String(args.path ?? ''), ctx);
        case 'glob': return await this.glob(String(args.pattern ?? ''), args.path ? String(args.path) : undefined);
        case 'grep': return await this.grep(String(args.pattern ?? ''), args.path ? String(args.path) : undefined, args.regex === true);
        case 'webFetch': return await this.webFetch(String(args.url ?? ''));
        case 'webSearch': return await this.webSearch(String(args.query ?? ''));
        case 'think': return JSON.stringify({ ok: true }); // visible reasoning step — no side effects
        case 'skill': return await this.skill(String(args.name ?? ''));
        case 'buildGraph': return await this.buildGraph();
        case 'getSymbolGraph': return await this.getSymbolGraph(String(args.file ?? ''));
        case 'impactAnalysis': return await this.impactAnalysis(args.files as string[] | undefined);
        case 'readImage': return await this.readImage(String(args.path ?? ''));
        case 'readDocument': return await this.readDocument(String(args.path ?? ''), typeof args.maxChars === 'number' ? args.maxChars : undefined);
        default: return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async readFile(p: string, startLine?: number, endLine?: number): Promise<string> {
    const uri = this.resolve(p);
    const key = uri.fsPath;
    // Full-file cache: store the decoded text (not the JSON wrapper) so line-range slices
    // can reuse it without a second disk read. The JSON result is re-built below.
    let fullText: string | undefined;
    if (this.fileCacheEnabled) {
      const stat = await vscode.workspace.fs.stat(uri);
      const cached = this.fileCache.get(key);
      if (cached && cached.mtime === stat.mtime) {
        // cached.content is the full JSON result — extract text to apply line range
        try { fullText = (JSON.parse(cached.content) as { content: string }).content; } catch { return cached.content; }
      } else {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const truncated = bytes.byteLength > MAX_READ_BYTES;
        fullText = new TextDecoder().decode(truncated ? bytes.slice(0, MAX_READ_BYTES) : bytes);
        // Cache the full file result for future full reads
        this.fileCache.set(key, { mtime: stat.mtime, content: JSON.stringify({ path: p, truncated, content: fullText }) });
      }
    } else {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const truncated = bytes.byteLength > MAX_READ_BYTES;
      fullText = new TextDecoder().decode(truncated ? bytes.slice(0, MAX_READ_BYTES) : bytes);
    }

    const allLines = fullText.split('\n');
    const totalLines = allLines.length;

    // Line-range slice: only return the requested window. Big win for large files —
    // model reads 30 lines instead of 500, saving 90% of input tokens.
    if (startLine !== undefined || endLine !== undefined) {
      const s = Math.max(0, (startLine ?? 1) - 1);
      const e = Math.min(totalLines, endLine ?? totalLines);
      const sliced = allLines.slice(s, e).join('\n');
      return JSON.stringify({ path: p, startLine: s + 1, endLine: e, totalLines, content: sliced });
    }

    // Default cap: prevents full large files from sitting in the transcript across 20+ iterations.
    // A 500-line file without a cap = 30 KB re-sent every model call = 600 KB over 20 iterations.
    // The model uses totalLines + the notice to call back with startLine/endLine as needed.
    if (fullText.length > READ_DEFAULT_CAP) {
      return JSON.stringify({
        path: p,
        totalLines,
        truncated: true,
        notice: `File has ${totalLines} lines. Only first ${READ_DEFAULT_CAP} chars shown. Call readFile with startLine/endLine to read a specific range.`,
        content: fullText.slice(0, READ_DEFAULT_CAP),
      });
    }
    return JSON.stringify({ path: p, totalLines, truncated: false, content: fullText });
  }

  private async listDir(p: string): Promise<string> {
    const uri = this.resolve(p);
    const entries = await vscode.workspace.fs.readDirectory(uri);
    return JSON.stringify({
      path: p,
      entries: entries.map(([name, type]) => ({ name, type: type === vscode.FileType.Directory ? 'dir' : 'file' })),
    });
  }

  /** Cheap workspace overview so the agent can orient itself. */
  private async repoMap(): Promise<string> {
    return JSON.stringify(await buildRepoMapSummary());
  }

  private async searchWorkspace(query: string): Promise<string> {
    const q = query.trim();
    if (!q) return JSON.stringify({ error: 'Empty query.' });
    if (this.searchCacheEnabled) {
      const key = `search:${q}`;
      const cached = this.searchCache.get(key);
      if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL_MS) return cached.result;
    }
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);

    // File-name / glob matches.
    const nameGlob = q.includes('*') || q.includes('/') ? q : `**/*${terms[0]}*`;
    const files = (await vscode.workspace.findFiles(nameGlob, EXCLUDE, 20)).map((f) => vscode.workspace.asRelativePath(f));

    // Content matches, ranked by how many query terms each file hits.
    const candidates = await vscode.workspace.findFiles(
      '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,c,cc,cpp,h,hpp,cs,rb,php,swift,scala,json,md,txt,html,css,scss,yaml,yml,sh,sql}',
      EXCLUDE, 500,
    );
    const perFile: Array<{ path: string; score: number; hits: Array<{ line: number; text: string }> }> = [];
    for (const f of candidates) {
      try {
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(f));
        const lines = text.split('\n');
        const hits: Array<{ line: number; text: string }> = [];
        let score = 0;
        for (let i = 0; i < lines.length; i++) {
          const low = lines[i].toLowerCase();
          const matched = terms.filter((t) => low.includes(t)).length;
          if (matched > 0) { score += matched; if (hits.length < 3) hits.push({ line: i + 1, text: lines[i].trim().slice(0, 200) }); }
        }
        if (score > 0) perFile.push({ path: vscode.workspace.asRelativePath(f), score, hits });
      } catch { /* skip unreadable */ }
    }
    perFile.sort((a, b) => b.score - a.score);
    const result = JSON.stringify({ files, matches: perFile.slice(0, MAX_SEARCH_RESULTS) });
    if (this.searchCacheEnabled) this.searchCache.set(`search:${q}`, { result, ts: Date.now() });
    return result;
  }

  private async getDiagnostics(p?: string): Promise<string> {
    const collect = (uri: vscode.Uri) =>
      vscode.languages.getDiagnostics(uri).map((d) => ({
        severity: vscode.DiagnosticSeverity[d.severity],
        line: d.range.start.line + 1,
        message: d.message,
      }));
    if (p) {
      const uri = this.resolve(p);
      return JSON.stringify({ path: p, diagnostics: collect(uri) });
    }
    const all = vscode.languages.getDiagnostics().slice(0, 50).map(([uri, diags]) => ({
      path: vscode.workspace.asRelativePath(uri),
      diagnostics: diags.map((d) => ({ severity: vscode.DiagnosticSeverity[d.severity], line: d.range.start.line + 1, message: d.message })),
    }));
    return JSON.stringify({ files: all });
  }

  private async runCommand(command: string, cwd: string | undefined, ctx?: RunContext): Promise<string> {
    return JSON.stringify(await this.commandGate.run(command, cwd, ctx));
  }

  /**
   * Concurrency guard: if another in-flight run is already mutating this file, defer with an
   * advisory error so the agent retries/picks another file instead of clobbering it. Otherwise
   * claim the file for this run. No-op when there's no requestId (non-session callers).
   * Returns an error observation string when blocked, or null when the write may proceed.
   */
  private claimEdit(p: string, ctx?: RunContext): string | null {
    const blocked = editConflicts(ctx?.requestId, [p]);
    if (blocked.length) {
      return JSON.stringify({ error: `${p} is being edited by another agent run right now — wait a moment and retry, or choose a different file to avoid overwriting each other.` });
    }
    markEditing(ctx?.requestId, [p]);
    return null;
  }

  private invalidateWriteCaches(p: string): void {
    // Invalidate file cache entry for the written path; clear search cache entirely
    // since content may have changed (too expensive to do partial invalidation).
    try { this.fileCache.delete(this.resolve(p).fsPath); } catch { /* best-effort */ }
    this.searchCache.clear();
  }

  private async writeFile(p: string, content: string, ctx?: RunContext): Promise<string> {
    const blocked = this.claimEdit(p, ctx);
    if (blocked) return blocked;
    const r = await this.editGate.write(this.resolve(p), content, ctx);
    if (r.applied) this.invalidateWriteCaches(p);
    return JSON.stringify(r.applied ? { ok: true, path: p } : { error: r.error ?? 'not applied' });
  }
  private async createFile(p: string, content: string, ctx?: RunContext): Promise<string> {
    const blocked = this.claimEdit(p, ctx);
    if (blocked) return blocked;
    const r = await this.editGate.create(this.resolve(p), content, ctx);
    if (r.applied) this.invalidateWriteCaches(p);
    return JSON.stringify(r.applied ? { ok: true, path: p } : { error: r.error ?? 'not applied' });
  }
  private async editFile(p: string, search: string, replace: string, ctx?: RunContext): Promise<string> {
    const blocked = this.claimEdit(p, ctx);
    if (blocked) return blocked;
    const r = await this.editGate.edit(this.resolve(p), search, replace, ctx);
    if (r.applied) {
      this.invalidateWriteCaches(p);
      return JSON.stringify({ ok: true, path: p });
    }
    // On failure: include the most relevant section of the file so the model can retry
    // with exact text — eliminating the "editFile fail → 14 greps" pattern.
    // Instead of blindly returning the first N chars, find the section with the most
    // keyword overlap with the failed search string (much more likely to contain the target).
    let currentContent = '';
    try {
      const bytes = await vscode.workspace.fs.readFile(this.resolve(p));
      const fullText = new TextDecoder().decode(bytes);
      const fileLines = fullText.split('\n');
      // Score each line by how many significant words from the search string it contains.
      const searchWords = search.split(/\s+/).filter((w) => w.length >= 4);
      let bestScore = 0;
      let bestLine = 0;
      for (let i = 0; i < fileLines.length; i++) {
        const score = searchWords.filter((w) => fileLines[i].includes(w)).length;
        if (score > bestScore) { bestScore = score; bestLine = i; }
      }
      // Return 50 lines centred on the best-matching line (or the top if no match).
      const start = Math.max(0, bestLine - 10);
      const end = Math.min(fileLines.length, bestLine + 40);
      currentContent = fileLines.slice(start, end).join('\n').slice(0, 3000);
    } catch { /* best-effort */ }
    return JSON.stringify({
      error: r.error ?? 'Search string not found in file — the text you searched for does not appear verbatim.',
      hint: 'Copy the exact text you want to replace from currentContent below, then retry editFile with that exact string.',
      currentContent,
    });
  }
  private async deleteFile(p: string, ctx?: RunContext): Promise<string> {
    const blocked = this.claimEdit(p, ctx);
    if (blocked) return blocked;
    const r = await this.editGate.remove(this.resolve(p), ctx);
    if (r.applied) this.invalidateWriteCaches(p);
    return JSON.stringify(r.applied ? { ok: true, path: p } : { error: r.error ?? 'not applied' });
  }

  /** Find files by glob pattern (optionally scoped under a folder). */
  private async glob(pattern: string, path?: string): Promise<string> {
    const p = (pattern || '').trim();
    if (!p) return JSON.stringify({ error: 'Empty pattern.' });
    const include = path ? `${path.replace(/\/+$/, '')}/${p}` : p;
    const files = (await vscode.workspace.findFiles(include, EXCLUDE, 100)).map((f) => vscode.workspace.asRelativePath(f));
    return JSON.stringify({ pattern: p, path: path ?? null, files });
  }

  /** Search file contents by substring or regex (optionally scoped under a folder). */
  private async grep(pattern: string, path: string | undefined, regex: boolean): Promise<string> {
    const p = pattern || '';
    if (!p) return JSON.stringify({ error: 'Empty pattern.' });
    if (this.searchCacheEnabled) {
      const key = `grep:${p}:${path ?? ''}:${regex}`;
      const cached = this.searchCache.get(key);
      if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL_MS) return cached.result;
    }
    let re: RegExp;
    try {
      re = regex ? new RegExp(p, 'i') : new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    } catch (e) {
      return JSON.stringify({ error: `Invalid pattern: ${e instanceof Error ? e.message : e}` });
    }
    const include = path ? `${path.replace(/\/+$/, '')}/**/*` : '**/*';
    const candidates = await vscode.workspace.findFiles(include, EXCLUDE, 500);
    // Limits: context lines increase output size ~5×, so reduce file+hit caps to compensate.
    // 12 files × 3 hits × 5 lines × 120 chars ≈ 21 KB max — manageable in a model context.
    // (Old: 40 × 5 × 200 = 40 KB; with context but no cap: 40 × 5 × 5 × 160 = 160 KB.)
    const MAX_FILES = 12;
    const MAX_HITS = 3;
    const CONTEXT = 2; // lines before/after each match
    const LINE_CAP = 120;
    const TOTAL_CHARS_CAP = 20_000; // hard ceiling regardless of file/hit counts
    let totalChars = 0;
    const matches: Array<{ path: string; hits: Array<{ line: number; text: string; context: string }> }> = [];
    for (const f of candidates) {
      if (totalChars >= TOTAL_CHARS_CAP) break;
      try {
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(f));
        const lines = text.split('\n');
        const hits: Array<{ line: number; text: string; context: string }> = [];
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]) && hits.length < MAX_HITS) {
            // Include surrounding lines so the model sees enough context to act without
            // a separate readFile call — eliminates 1 RPD slot per grep hit.
            const ctxStart = Math.max(0, i - CONTEXT);
            const ctxEnd = Math.min(lines.length - 1, i + CONTEXT);
            const context = lines.slice(ctxStart, ctxEnd + 1).map((l, idx) => {
              const lineNum = ctxStart + idx + 1;
              const marker = lineNum === i + 1 ? '>' : ' ';
              return `${marker} ${lineNum}: ${l.slice(0, LINE_CAP)}`;
            }).join('\n');
            hits.push({ line: i + 1, text: lines[i].trim().slice(0, LINE_CAP), context });
            totalChars += context.length;
          }
        }
        if (hits.length) matches.push({ path: vscode.workspace.asRelativePath(f), hits });
        if (matches.length >= MAX_FILES) break;
      } catch { /* skip unreadable */ }
    }
    const result = JSON.stringify({ pattern: p, path: path ?? null, matches });
    if (this.searchCacheEnabled) {
      const key = `grep:${p}:${path ?? ''}:${regex}`;
      this.searchCache.set(key, { result, ts: Date.now() });
    }
    return result;
  }

  /** Fetch a URL and return cleaned text (HTML stripped, truncated to ~8 KB). */
  private async webFetch(url: string): Promise<string> {
    const u = (url || '').trim();
    if (!/^https?:\/\//i.test(u)) return JSON.stringify({ error: 'Only http(s) URLs are allowed.' });
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(u, { signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(timer);
      if (!res.ok) return JSON.stringify({ error: `HTTP ${res.status}` });
      const type = res.headers.get('content-type') ?? '';
      const raw = await res.text();
      const text = /html/i.test(type) ? htmlToText(raw) : raw;
      return JSON.stringify({ url: u, content: text.slice(0, 8000) });
    } catch (e) {
      return JSON.stringify({ error: `Fetch failed: ${e instanceof Error ? e.message : e}` });
    }
  }

  /** Web search → {title, url, snippet}[]. Multi-provider chain based on settings:
   *  Auto mode tries Exa → Brave → custom endpoint → free DuckDuckGo in priority order,
   *  picking the first with a key configured. When every source comes back empty we return a
   *  clear error (not silent []) so the model tells the user the backend is blocked. */
  private async webSearch(query: string): Promise<string> {
    const q = (query || '').trim();
    if (!q) return JSON.stringify({ error: 'Empty query.' });

    const cfg = vscode.workspace.getConfiguration('tiermux.tools');
    const priority = cfg.get<string>('searchProviderPriority', 'auto');
    const exaKey = cfg.get<string>('exaApiKey', '').trim();
    const braveKey = cfg.get<string>('braveApiKey', '').trim();
    const customEndpoint = cfg.get<string>('searchEndpoint', '').trim();

    // Build the ordered list of providers to try based on the priority setting.
    const providers: Array<{ name: string; run: () => Promise<WebResult[]> }> = [];

    if (priority === 'auto') {
      if (exaKey) providers.push({ name: 'exa', run: () => searchExa(q, exaKey) });
      if (braveKey) providers.push({ name: 'brave', run: () => searchBrave(q, braveKey) });
      if (customEndpoint) providers.push({ name: 'custom', run: () => searchViaEndpoint(customEndpoint, q) });
      providers.push({ name: 'duckduckgo', run: () => searchDuckDuckGo(q) });
    } else if (priority === 'exa') {
      if (!exaKey) {
        return JSON.stringify({
          error: 'Search provider set to "exa" but no Exa API key configured. Set "tiermux.tools.exaApiKey" or switch searchProviderPriority to "auto" / "duckduckgo".',
          query: q,
        });
      }
      providers.push({ name: 'exa', run: () => searchExa(q, exaKey) });
    } else if (priority === 'brave') {
      if (!braveKey) {
        return JSON.stringify({
          error: 'Search provider set to "brave" but no Brave API key configured. Set "tiermux.tools.braveApiKey" or switch searchProviderPriority to "auto" / "duckduckgo".',
          query: q,
        });
      }
      providers.push({ name: 'brave', run: () => searchBrave(q, braveKey) });
    } else if (priority === 'custom') {
      if (!customEndpoint) {
        return JSON.stringify({
          error: 'Search provider set to "custom" but no endpoint configured. Set "tiermux.tools.searchEndpoint" or switch searchProviderPriority.',
          query: q,
        });
      }
      providers.push({ name: 'custom', run: () => searchViaEndpoint(customEndpoint, q) });
    } else {
      providers.push({ name: 'duckduckgo', run: () => searchDuckDuckGo(q) });
    }

    // Try each provider in order; return the first one that returns results.
    for (const p of providers) {
      try {
        const results = await p.run();
        if (results.length) {
          return JSON.stringify({ query: q, provider: p.name, results: results.slice(0, 5) });
        }
      } catch { /* try next provider */ }
    }

    // No provider returned results.
    const hasAnyKey = !!(exaKey || braveKey || customEndpoint);
    return JSON.stringify({
      error: hasAnyKey
        ? 'All configured search providers returned no results. Try rephrasing the query, or use webFetch on a known relevant URL (e.g. en.wikipedia.org/wiki/<topic>).'
        : 'Web search unavailable: no API keys configured and the free DuckDuckGo backend is rate-limited. Configure "tiermux.tools.exaApiKey" (free 1k/mo) or "tiermux.tools.braveApiKey" (free 2k/mo) for reliable search, or use webFetch on known relevant URLs (en.wikipedia.org, bbc.com/sport, wttr.in).',
      query: q,
    });
  }

  /** Load a named skill (.tiermux/skills/<name>.md) and return its instructions. */
  private async skill(name: string): Promise<string> {
    const loaded = await loadSkill(name);
    if (loaded) return JSON.stringify({ found: true, name: loaded.name, description: loaded.description, instructions: loaded.body });
    const available = await listSkills();
    const note = available.length
      ? `No skill named "${name}". Available: ${available.join(', ')}.`
      : `No skill named "${name}" (.tiermux/skills is empty).`;
    return JSON.stringify({ found: false, note });
  }

  /**
   * Read an image from the workspace and return it as multimodal content so a
   * vision-capable model can actually see it. The result is a block array — the
   * Google provider translates it to native inlineData; OpenAI-compat providers
   * see it as an `image_url` block.
   */
  private async readImage(p: string): Promise<ChatMessage['content']> {
    if (!p) return JSON.stringify({ error: 'Missing required parameter: path.' });
    const uri = this.resolve(p);
    if (!isSupportedAttachmentPath(uri.fsPath)) return JSON.stringify({ error: `Not an image: ${p}` });
    if (kindForPath(uri.fsPath) !== 'image') return JSON.stringify({ error: `Not an image: ${p}. Use readDocument for non-image files.` });
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength === 0) return JSON.stringify({ error: `Image is empty: ${p}` });
    if (bytes.byteLength > IMAGE_BYTE_LIMIT) return JSON.stringify({ error: `Image is too large (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; max ${IMAGE_BYTE_LIMIT / 1024 / 1024} MB). Resize or compress it and try again.` });
    const mime = mimeForPath(uri.fsPath);
    const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
    return [
      { type: 'text', text: `Image attached: ${p} (${(bytes.byteLength / 1024).toFixed(1)} KB, ${mime}).` },
      { type: 'image_url', image_url: { url: dataUrl } },
    ];
  }

  /**
   * Read a document from the workspace and return its extracted text. Supports
   * PDF, DOCX, MD, TXT, JSON. Returns plain text so any model — vision or not —
   * can answer from it.
   */
  private async readDocument(p: string, maxChars: number | undefined): Promise<string> {
    if (!p) return JSON.stringify({ error: 'Missing required parameter: path.' });
    const uri = this.resolve(p);
    if (!isSupportedAttachmentPath(uri.fsPath)) return JSON.stringify({ error: `Unsupported file type: ${p}. Supported: PDF, DOCX, MD, TXT, JSON, images.` });
    const kind = kindForPath(uri.fsPath);
    const cap = Math.max(1000, Math.min(maxChars ?? MAX_DOC_CHARS_DEFAULT, 200_000));
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength === 0) return JSON.stringify({ error: `File is empty: ${p}` });

    let text = '';
    try {
      if (kind === 'pdf') {
        text = await extractPdfText(Buffer.from(bytes));
      } else if (uri.fsPath.toLowerCase().endsWith('.docx')) {
        text = await extractDocxText(Buffer.from(bytes));
      } else {
        // Plain text / markdown / json / .doc (best-effort).
        text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      }
    } catch (e) {
      return JSON.stringify({ error: `Could not extract text from ${p}: ${e instanceof Error ? e.message : e}` });
    }

    const truncated = text.length > cap;
    const body = truncated ? text.slice(0, cap) : text;
    return JSON.stringify({
      path: p,
      kind,
      bytes: bytes.byteLength,
      chars: text.length,
      truncated,
      content: body,
      ...(truncated ? { notice: `Truncated to first ${cap} of ${text.length} characters. Use maxChars to control, or readFile for the raw bytes (text files only).` } : {}),
    });
  }

  private async buildGraph(): Promise<string> {
    try {
      const graph = await buildStructuralGraph(true);
      return JSON.stringify({ ok: true, files: graph.files.length, imports: graph.imports.length, calls: graph.calls.length, entrypoints: graph.entrypoints.length, summary: graphSummary(graph) });
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async getSymbolGraph(file: string): Promise<string> {
    if (!file) return JSON.stringify({ error: 'Missing required parameter: file.' });
    const graph = await loadStructuralGraph();
    if (!graph) return JSON.stringify({ error: 'No structural graph built yet. Call buildGraph first.' });
    const result = symbolGraph(graph, file);
    return JSON.stringify(result);
  }

  private async impactAnalysis(files: string[] | undefined): Promise<string> {
    if (!files || !Array.isArray(files) || files.length === 0) return JSON.stringify({ error: 'Missing required parameter: files (array of workspace-relative paths).' });
    const graph = await loadStructuralGraph();
    if (!graph) return JSON.stringify({ error: 'No structural graph built yet. Call buildGraph first.' });
    const analysis = analyzeImpact(graph, files);
    return JSON.stringify({ changedFiles: analysis.changedFiles, impactedCount: analysis.impacted.length, impacted: analysis.impacted.slice(0, 30), byLayer: Object.fromEntries(Object.entries(analysis.byLayer).map(([k, v]) => [k, v.length])), markdown: impactMarkdown(analysis) });
  }
}

// ---- web helpers (best-effort; web tools are on by default via `tiermux.tools.web`) ----

/** Strip tags/scripts/style, decode common entities, collapse whitespace. Good enough for reading. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface WebResult { title: string; url: string; snippet: string }

/** Browser-like headers so DuckDuckGo doesn't return an "anomaly" block page to a bare request. */
const DDG_HEADERS: Record<string, string> = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'referer': 'https://duckduckgo.com/',
};

/** Decode a DuckDuckGo redirect-wrapped URL (//duckduckgo.com/l/?uddg=ENCODED&...). */
function decodeDdgUrl(raw: string): string {
  const uddg = raw.match(/uddg=([^&]+)/i);
  if (uddg) { try { return decodeURIComponent(uddg[1]); } catch { /* fall through */ } }
  return raw;
}

/** Free search via DuckDuckGo using the duck-duck-scrape library (handles anti-bot properly).
 *  Falls back to the Instant-Answer JSON API for encyclopedic queries, then the old HTML/lite
 *  scrapers as last resort. */
async function searchDuckDuckGo(query: string): Promise<WebResult[]> {
  // 1. duck-duck-scrape — TypeScript library that uses DDG's internal JSON API
  const lib = await searchDdgLib(query);
  if (lib.length) return lib;

  // 2. Instant-Answer API — no anti-bot, but limited to factual/encyclopedic queries
  const instant = await ddgInstant(query);
  if (instant.length) return instant;

  // 3. Old HTML/lite scrapers — often blocked, kept as absolute last resort
  const html = await ddgHtml(query);
  if (html.length) return html;
  return ddgLite(query);
}

/** Primary search via duck-duck-scrape library. Tries text search first, then news. */
async function searchDdgLib(query: string): Promise<WebResult[]> {
  try {
    const results = await ddgSearch(query, { safeSearch: SafeSearchType.OFF });
    if (results.results?.length) {
      return results.results.slice(0, 8).map((r) => ({
        title: (r.title ?? '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim(),
        url: r.url ?? '',
        snippet: (r.description ?? '').replace(/<[^>]+>/g, '').trim(),
      })).filter((r) => r.title && r.url);
    }
  } catch { /* fall through to news */ }

  // News search as fallback for time-sensitive queries
  try {
    const news = await ddgSearchNews(query);
    if (news.results?.length) {
      return news.results.slice(0, 8).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: (r.excerpt ?? '').trim(),
      })).filter((r) => r.title && r.url);
    }
  } catch { /* fall through */ }
  return [];
}

async function ddgHtml(query: string): Promise<WebResult[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      signal: ctrl.signal, headers: DDG_HEADERS, redirect: 'follow',
    });
    // 202 = DDG's "unusual activity" challenge page (big HTML, zero results). Treat anything but
    // a clean 200 as blocked so we fall through to the lite/instant fallbacks instead of parsing
    // a challenge page and returning [].
    if (res.status !== 200) return [];
    const html = await res.text();
    const out: WebResult[] = [];
    const blocks = html.split(/class="result[^"]*"/).slice(1);
    for (const b of blocks) {
      if (out.length >= 8) break;
      const titleM = b.match(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
      const hrefM = b.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"/i);
      const snipM = b.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
      const title = titleM ? htmlToText(titleM[1]) : '';
      const url = hrefM ? decodeDdgUrl(hrefM[1]) : '';
      const snippet = snipM ? htmlToText(snipM[1]) : '';
      if (title) out.push({ title, url, snippet });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** DuckDuckGo Instant-Answer API — a JSON endpoint that's far less aggressively blocked than the
 *  HTML scraper. Returns an abstract + related topics for encyclopedic queries (great for "what
 *  is X"); returns nothing for fresh/live data like today's scores, but it's a useful no-key fallback. */
async function ddgInstant(query: string): Promise<WebResult[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {
      signal: ctrl.signal, headers: { 'user-agent': DDG_HEADERS['user-agent'] }, redirect: 'follow',
    });
    if (res.status !== 200) return [];
    const data = await res.json() as Record<string, unknown>;
    const out: WebResult[] = [];
    const abstract = String(data.AbstractText ?? '').trim();
    if (abstract) out.push({ title: String(data.Heading ?? query), url: String(data.AbstractURL ?? ''), snippet: abstract });
    const topics = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
    for (const t of topics) {
      if (out.length >= 8) break;
      const o = t as Record<string, unknown>;
      const text = String(o.Text ?? '').trim();
      const url = String(o.FirstURL ?? '').trim();
      if (text && url) out.push({ title: text.slice(0, 80), url, snippet: text });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** DuckDuckGo's `lite` endpoint — simpler HTML, less aggressively blocked; a fallback when the
 *  main HTML endpoint returns nothing. Links are `result-link`, snippets `result-snippet`. */
async function ddgLite(query: string): Promise<WebResult[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}&kl=us-en`, {
      signal: ctrl.signal, headers: DDG_HEADERS, redirect: 'follow',
    });
    if (!res.ok) return [];
    const html = await res.text();
    const out: WebResult[] = [];
    const rows = html.split(/<a[^>]*class="result-link"[^>]*>/).slice(1);
    for (const r of rows) {
      if (out.length >= 8) break;
      const hrefM = r.match(/href="([^"]+)"/i);
      const titleM = r.match(/^([\s\S]*?)<\/a>/i);
      const title = titleM ? htmlToText(titleM[1]) : '';
      const url = hrefM ? decodeDdgUrl(hrefM[1]) : '';
      if (!title) continue;
      out.push({ title, url, snippet: '' });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Search via a user-configured endpoint that returns JSON. Best-effort shape extraction. */
async function searchViaEndpoint(endpoint: string, query: string): Promise<WebResult[]> {
  const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return [];
    const data = await res.json() as unknown;
    const pick = (o: Record<string, unknown>): WebResult | undefined => {
      const t = String(o.title ?? o.name ?? o.titleField ?? '').trim();
      const u = String(o.url ?? o.link ?? o.href ?? '').trim();
      const s = String(o.snippet ?? o.description ?? o.body ?? o.content ?? '').trim();
      return t || u ? { title: t, url: u, snippet: s } : undefined;
    };
    const arr = Array.isArray(data) ? data
      : Array.isArray((data as Record<string, unknown>)?.results) ? (data as Record<string, unknown[]>).results
      : Array.isArray((data as Record<string, unknown>)?.data) ? (data as Record<string, unknown[]>).data
      : [];
    return arr.map((x) => pick(x as Record<string, unknown>)).filter((x): x is WebResult => !!x);
  } finally {
    clearTimeout(timer);
  }
}

// ---- Exa AI search (free tier: 1,000 searches/month, semantic search optimized for AI) ----

interface ExaResult {
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  summary?: string;
  text?: string;
}

async function searchExa(query: string, apiKey: string): Promise<WebResult[]> {
  if (!apiKey) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        query,
        numResults: 8,
        contents: {
          summary: { query },
        },
      }),
    });
    if (!res.ok) return [];
    const data = await res.json() as { results?: ExaResult[] };
    if (!Array.isArray(data.results)) return [];
    return data.results.slice(0, 8).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.summary ?? r.text?.slice(0, 300) ?? '',
    })).filter((r) => r.title && r.url);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ---- Brave Search API (free tier: 2,000 queries/month) ----

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
}

async function searchBrave(query: string, apiKey: string): Promise<WebResult[]> {
  if (!apiKey) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`,
      {
        signal: ctrl.signal,
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
      }
    );
    if (!res.ok) return [];
    const data = await res.json() as { web?: { results?: BraveResult[] } };
    const results = data.web?.results;
    if (!Array.isArray(results)) return [];
    return results.slice(0, 8).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: (r.description ?? '').replace(/<[^>]+>/g, '').trim(),
    })).filter((r) => r.title && r.url);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
