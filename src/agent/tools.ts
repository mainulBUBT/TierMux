// Workspace tool implementations. All paths are confined to the workspace root.
import * as vscode from 'vscode';
import { EditGate } from '../edits/applyEdit';
import { CommandGate } from '../edits/commandGate';
import { buildRepoMapSummary } from './repoMap';
import { loadSkill, listSkills } from './skills';
import type { RunContext } from './runContext';

const MAX_READ_BYTES = 100 * 1024;
const MAX_SEARCH_RESULTS = 40;
const EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/.venv/**}';

export interface ToolEvent {
  toolCallId: string;
  name: string;
  args: unknown;
  state: 'running' | 'done' | 'error';
  detail?: string;
}

export class WorkspaceTools {
  constructor(
    private readonly editGate: EditGate,
    private readonly commandGate: CommandGate,
  ) {}

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

  /** Execute a tool by name. Returns a string observation; never throws. */
  async execute(name: string, rawArgs: string, ctx?: RunContext): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      return JSON.stringify({ error: 'Invalid JSON arguments.' });
    }
    try {
      switch (name) {
        case 'readFile': return await this.readFile(String(args.path ?? ''));
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
        case 'skill': return await this.skill(String(args.name ?? ''));
        default: return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async readFile(p: string): Promise<string> {
    const uri = this.resolve(p);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const truncated = bytes.byteLength > MAX_READ_BYTES;
    const text = new TextDecoder().decode(truncated ? bytes.slice(0, MAX_READ_BYTES) : bytes);
    return JSON.stringify({ path: p, truncated, content: text });
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
    return JSON.stringify({ files, matches: perFile.slice(0, MAX_SEARCH_RESULTS) });
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

  private async writeFile(p: string, content: string, ctx?: RunContext): Promise<string> {
    const r = await this.editGate.write(this.resolve(p), content, ctx);
    return JSON.stringify(r.applied ? { ok: true, path: p } : { error: r.error ?? 'not applied' });
  }
  private async createFile(p: string, content: string, ctx?: RunContext): Promise<string> {
    const r = await this.editGate.create(this.resolve(p), content, ctx);
    return JSON.stringify(r.applied ? { ok: true, path: p } : { error: r.error ?? 'not applied' });
  }
  private async editFile(p: string, search: string, replace: string, ctx?: RunContext): Promise<string> {
    const r = await this.editGate.edit(this.resolve(p), search, replace, ctx);
    return JSON.stringify(r.applied ? { ok: true, path: p } : { error: r.error ?? 'not applied' });
  }
  private async deleteFile(p: string, ctx?: RunContext): Promise<string> {
    const r = await this.editGate.remove(this.resolve(p), ctx);
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
    let re: RegExp;
    try {
      re = regex ? new RegExp(p, 'i') : new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    } catch (e) {
      return JSON.stringify({ error: `Invalid pattern: ${e instanceof Error ? e.message : e}` });
    }
    const include = path ? `${path.replace(/\/+$/, '')}/**/*` : '**/*';
    const candidates = await vscode.workspace.findFiles(include, EXCLUDE, 500);
    const matches: Array<{ path: string; hits: Array<{ line: number; text: string }> }> = [];
    for (const f of candidates) {
      try {
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(f));
        const lines = text.split('\n');
        const hits: Array<{ line: number; text: string }> = [];
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]) && hits.length < 5) hits.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
        if (hits.length) matches.push({ path: vscode.workspace.asRelativePath(f), hits });
        if (matches.length >= 40) break;
      } catch { /* skip unreadable */ }
    }
    return JSON.stringify({ pattern: p, path: path ?? null, matches });
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

  /** Web search → {title, url, snippet}[]. Uses the configured endpoint, else best-effort free DDG. */
  private async webSearch(query: string): Promise<string> {
    const q = (query || '').trim();
    if (!q) return JSON.stringify({ error: 'Empty query.' });
    const endpoint = vscode.workspace.getConfiguration('tiermux.tools').get<string>('searchEndpoint', '').trim();
    try {
      const results = endpoint ? await searchViaEndpoint(endpoint, q) : await searchDuckDuckGo(q);
      return JSON.stringify({ query: q, results: results.slice(0, 5) });
    } catch (e) {
      return JSON.stringify({ error: `Search failed: ${e instanceof Error ? e.message : e}` });
    }
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
}

// ---- web helpers (best-effort; web tools are opt-in via `tiermux.tools.web`) ----

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

/** Best-effort free search via DuckDuckGo's HTML endpoint (fragile — set searchEndpoint for reliability). */
async function searchDuckDuckGo(query: string): Promise<WebResult[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) tiermux' },
      redirect: 'follow',
    });
    if (!res.ok) return [];
    const html = await res.text();
    const out: WebResult[] = [];
    const blocks = html.split(/class="result[^"]*"/).slice(1);
    for (const b of blocks) {
      if (out.length >= 8) break;
      const titleM = b.match(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
      const hrefM = b.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"/i);
      const snipM = b.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
      const title = titleM ? htmlToText(titleM[1]) : '';
      let url = '';
      if (hrefM) {
        const uddg = hrefM[1].match(/uddg=([^&]+)/i);
        try { url = uddg ? decodeURIComponent(uddg[1]) : hrefM[1]; } catch { url = hrefM[1]; }
      }
      const snippet = snipM ? htmlToText(snipM[1]) : '';
      if (title) out.push({ title, url, snippet });
    }
    return out;
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
