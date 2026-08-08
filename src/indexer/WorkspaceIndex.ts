

// In-memory workspace symbol + dependency index. Zero dependencies: symbol lookup leans on
// VS Code's own language servers (executeWorkspaceSymbolProvider) and falls back to a bounded
// scan of the in-memory per-file symbol lists (regex-extracted by importResolvers) when no LS
// is active; the dependency graph is built from those same regex-extracted imports, resolved
// against graph keys (not disk stats) so it stays cheap.
//
// Lifecycle: lazy. Nothing is scanned at activation — files are indexed on first query and
// incrementally thereafter via a FileSystemWatcher. A `maxFiles` ceiling bounds memory.
//
// This completes retrieval-quality infrastructure TierMux already shipped but never backed:
// the status-bar gauge + telemetry counters in src/context/telemetry.ts, and the getSymbolGraph
// tool-card label in media/src/ui/tool/ToolCard.ts. The tools (see tools/workspace/) call
// findSymbol/dependenciesOf/dependentsOf here and increment those counters on hits.

import * as vscode from 'vscode';
import { extract, languageForPath, type Language, type SymbolExtract } from './importResolvers';

export interface SymbolRef {
  name: string;
  kind: string;
  container?: string;
  filePath: string;
  line: number;
  /** 'lsp' (from a running language server) or 'index' (regex fallback) — the fallback answer
   *  is less precise (no containerName, regex-defined line), so callers can prefer LSP hits. */
  source: 'lsp' | 'index';
}

export interface FileNode {
  path: string;
  language: Language;
  imports: string[];          // raw specifiers as written in the file
  resolvedImports: string[];  // specifiers resolved to graph keys (only successful ones)
  exports: string[];
  symbols: SymbolExtract[];
}

export interface DepEdge { path: string; via?: string; resolved: boolean; external?: boolean }

export interface IndexConfig {
  enabled: boolean;
  maxFiles: number;
  /** Path segments/globs never indexed (e.g. node_modules, vendor). Matched against the
   *  workspace-relative path's segments and suffix. */
  excludes: string[];
}

const DEFAULT_EXCLUDES = ['node_modules', '.git', 'dist', 'build', 'vendor', '.next', 'out', 'coverage', '.cache'];

export class WorkspaceIndex implements vscode.Disposable {
  private readonly graph = new Map<string, FileNode>();
  /** Reverse adjacency: key → files whose resolvedImports include key. Keeps dependentsOf O(1). */
  private readonly reverse = new Map<string, Set<string>>();
  /** Per-URI debounce timers so a batch change (git checkout) re-indexes every file, not just the last. */
  private readonly debounce = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly symbolCache = new Map<string, SymbolRef[]>();
  private watcher: vscode.FileSystemWatcher | undefined;
  private disposed = false;

  constructor(private readonly config: () => IndexConfig) {}

  // ── Lifecycle ────────────────────────────────────────────────────────────────────
  /** Create the FileSystemWatcher. Does NOT scan — indexing stays lazy (first query or a
   *  create/change event). Safe to call once at activation; pushed onto context.subscriptions. */
  register(): vscode.Disposable {
    // '**/*' catches every workspace file; excluded paths are filtered in the handler (a single
    // watcher glob can't express "everything except a list" without minimatch, which we don't ship).
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.watcher.onDidCreate((uri) => this.scheduleIndex(uri));
    this.watcher.onDidChange((uri) => this.scheduleIndex(uri));
    this.watcher.onDidDelete((uri) => this.remove(this.relPath(uri)));
    return this;
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.dispose();
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
  }

  /** Clear all in-memory index caches. Graph rebuilds lazily on next tool access / file event. */
  rebuild(): void {
    this.graph.clear();
    this.reverse.clear();
    this.symbolCache.clear();
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
  }

  private relPath(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  }

  /** True if a workspace-relative path is excluded or belongs to a non-source language we don't index. */
  private isExcluded(rel: string): boolean {
    const cfg = this.config();
    const excludes = cfg.excludes.length ? cfg.excludes : DEFAULT_EXCLUDES;
    const segs = rel.toLowerCase().split('/');
    for (const ex of excludes) {
      const lex = ex.toLowerCase();
      if (segs.includes(lex) || rel.toLowerCase().endsWith(lex) || lex.includes('*') && this.globMatch(lex, rel.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  /** Tiny glob matcher for the '*' excludes case (no minimatch dependency). Only supports a
   *  trailing/leading star or a segment star — enough for `*.min.js`-style excludes. */
  private globMatch(pattern: string, path: string): boolean {
    const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return re.test(path);
  }

  // ── Indexing ─────────────────────────────────────────────────────────────────────
  /** Debounced re-index for a single URI (~300ms per file). The debounce is keyed by path so
   *  rapid successive saves of DIFFERENT files each get their own timer — a global debounce
   *  would coalesce them and drop earlier files during a batch refactor or `git checkout`. */
  private scheduleIndex(uri: vscode.Uri): void {
    if (!this.config().enabled) return;
    const rel = this.relPath(uri);
    if (this.isExcluded(rel) || languageForPath(rel) === 'unknown') return;
    const existing = this.debounce.get(rel);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounce.delete(rel);
      void this.indexFile(uri).catch(() => { /* best-effort; file may have been deleted */ });
    }, 300);
    this.debounce.set(rel, timer);
  }

  /** Read, extract, and store one file's node, keeping the reverse-dependency map in sync.
   *  Public so tools can force-index a path right before walking its dependency tree (the graph
   *  is otherwise populated lazily / by the watcher). No-op for excluded/unknown files. */
  async indexFile(uri: vscode.Uri): Promise<void> {
    if (!this.config().enabled || this.disposed) return;
    const rel = this.relPath(uri);
    if (this.isExcluded(rel)) return;
    const language = languageForPath(rel);
    if (language === 'unknown') return;
    if (!this.graph.has(rel) && this.graph.size >= this.config().maxFiles) return; // memory ceiling

    let text: string;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return; // unreadable (binary, deleted, permission) — leave any stale node in place
    }
    const ex = extract(rel, text);
    const resolved = uniq(ex.imports.map((spec) => this.resolveImport(spec, rel, language)).filter((k): k is string => !!k));

    // Swap the node and patch the reverse map for exactly this file's import delta.
    const old = this.graph.get(rel);
    if (old) this.updateReverse(rel, old.resolvedImports, []);
    this.graph.set(rel, {
      path: rel, language, imports: ex.imports, resolvedImports: resolved, exports: ex.exports, symbols: ex.symbols,
    });
    this.updateReverse(rel, [], resolved);
    this.symbolCache.clear(); // contents changed → cached symbol lookups may be stale
  }

  /** Ensure a path is indexed (read from disk if needed) before walking it. */
  private async ensureIndexed(rel: string): Promise<FileNode | undefined> {
    const existing = this.graph.get(rel);
    if (existing) return existing;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root || this.isExcluded(rel) || languageForPath(rel) === 'unknown') return undefined;
    await this.indexFile(vscode.Uri.joinPath(root, rel));
    return this.graph.get(rel);
  }

  private updateReverse(file: string, removeOld: string[], addNew: string[]): void {
    for (const k of removeOld) this.reverse.get(k)?.delete(file);
    for (const k of addNew) {
      let set = this.reverse.get(k);
      if (!set) { set = new Set(); this.reverse.set(k, set); }
      set.add(file);
    }
  }

  private remove(rel: string): void {
    const node = this.graph.get(rel);
    if (node) {
      this.updateReverse(rel, node.resolvedImports, []);
      this.graph.delete(rel);
      this.symbolCache.clear();
    }
    // Also prune: this file may itself be an import target of others — those edges now dangle,
    // but they resolve to a key that no longer exists, which dependents-of naturally drops.
    this.reverse.delete(rel);
  }

  // ── Import resolution ────────────────────────────────────────────────────────────
  /** Ordered candidate workspace-relative paths for a raw specifier, independent of whether the
   *  target is indexed yet. Shared by the graph-keyed lookup (sync, cheap) and the on-disk
   *  self-seeding lookup (async, used by the dependency walk on a cold cache). Returns [] for
   *  external/unresolvable specifiers (bare packages, PSR-4 FQCNs, Go domains). */
  private candidateKeys(spec: string, sourceRel: string, language: Language): string[] {
    // Python: dotted module → slashed path. Relative dots (`from . import`) resolve against dir.
    if (language === 'python') {
      const isRel = spec.startsWith('.');
      const parts = spec.replace(/^\.+/, '').split('.').filter(Boolean);
      if (!parts.length) return [];
      const base = isRel ? normalizeJoin(dirname(sourceRel), parts.join('/')) : parts.join('/');
      return [`${base}.py`, normalizeJoin(base, '__init__.py')];
    }

    // Go: fully-qualified domain-prefixed paths don't map to single workspace files.
    if (language === 'go') return [];

    // JS/TS and PHP `require`/`include`: only RELATIVE specifiers resolve. Bare names and path
    // aliases are external; PHP `use` FQCNs need an autoloader map we don't have.
    const relative = spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/');
    if (!relative) return [];
    const cleaned = spec.startsWith('/') ? spec.slice(1) : normalizeJoin(dirname(sourceRel), spec);
    const extMap: Partial<Record<Language, string[]>> = {
      php: ['.php'],
      dart: ['.dart'],
      rust: ['.rs'],
      cpp: ['.h', '.hpp', '.c', '.cpp', '.cc', '.cxx'],
      java: ['.java'],
      kotlin: ['.kt'],
      ruby: ['.rb'],
      swift: ['.swift'],
      typescript: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
      javascript: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'],
    };
    const exts = extMap[language] ?? ['.ts', '.tsx', '.js', '.jsx'];
    const candidates = exts.map((ext) => cleaned + ext);
    if (language === 'typescript' || language === 'javascript') {
      for (const ext of ['.ts', '.tsx', '.js', '.jsx']) candidates.push(normalizeJoin(cleaned, `index${ext}`));
    }
    candidates.push(cleaned); // exact (already has an extension, or extensionless on disk)
    return candidates;
  }

  /** Graph-keyed resolution (O(1) Map lookups, never disk stats) — used at index time to build
   *  resolvedImports and the reverse-dependency map. Misses anything not yet indexed; the
   *  dependency walk uses resolveOnDisk for its first level to self-seed a cold cache. */
  private resolveImport(spec: string, sourceRel: string, language: Language): string | null {
    for (const k of this.candidateKeys(spec, sourceRel, language)) if (this.graph.has(k)) return k;
    return null;
  }

  /** Resolve a specifier against DISK (stat then index on hit), so a dependency walk into a
   *  never-opened file still finds it. Bounded: one stat per candidate (a handful), only along
   *  the walked frontier — never a workspace sweep. Returns the graph key, or null. */
  private async resolveOnDisk(spec: string, sourceRel: string, language: Language): Promise<string | null> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return null;
    for (const cand of this.candidateKeys(spec, sourceRel, language)) {
      if (this.graph.has(cand)) return cand;
      const uri = vscode.Uri.joinPath(root, cand);
      try { await vscode.workspace.fs.stat(uri); }
      catch { continue; } // not present — try next candidate
      await this.indexFile(uri); // adds it to the graph (and the reverse map) for future queries
      return cand;
    }
    return null;
  }

  // ── Symbol lookup ────────────────────────────────────────────────────────────────
  /** Find a symbol across the workspace. Tries the language server first (accurate: container
   *  names, exact lines, all languages with a running LS), then a bounded scan of in-memory
   *  per-file symbols (the no-LS fallback for PHP/Python/Go). Cached by query. */
  async findSymbol(query: string, limit = 20): Promise<SymbolRef[]> {
    const q = query.trim();
    if (!q) return [];
    const cacheKey = `${q.toLowerCase()}|${limit}`;
    const cached = this.symbolCache.get(cacheKey);
    if (cached) return cached;

    let refs: SymbolRef[] = [];
    try {
      const syms = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider', q,
      )) ?? [];
      refs = syms.slice(0, limit).map((s) => ({
        name: s.name,
        kind: kindLabel(s.kind),
        container: s.containerName || undefined,
        filePath: vscode.workspace.asRelativePath(s.location.uri, false).replace(/\\/g, '/'),
        line: (s.location.range?.start?.line ?? 0) + 1,
        source: 'lsp' as const,
      }));
    } catch {
      refs = []; // no LS / command unavailable — fall through to the index scan
    }

    if (refs.length === 0) {
      refs = await this.fallbackSymbolScan(q, limit);
    }

    this.symbolCache.set(cacheKey, refs);
    return refs;
  }

  /** Bounded regex-fallback: scan already-indexed file nodes' symbol lists (in-memory arrays,
   *  never disk), prioritizing OPEN editors then the rest, early-exiting at `limit`. If the graph
   *  is empty, seed it from the currently open editors so the fallback has something to read. */
  private async fallbackSymbolScan(query: string, limit: number): Promise<SymbolRef[]> {
    if (this.graph.size === 0) {
      const open = vscode.window.visibleTextEditors.map((e) => this.relPath(e.document.uri));
      await Promise.all(open.map((rel) => this.ensureIndexed(rel)));
    }
    const ql = query.toLowerCase();
    const order: string[] = [];
    for (const e of vscode.window.visibleTextEditors) {
      const rel = this.relPath(e.document.uri);
      if (!order.includes(rel)) order.push(rel);
    }
    for (const key of this.graph.keys()) if (!order.includes(key)) order.push(key);

    const out: SymbolRef[] = [];
    for (const path of order) {
      const node = this.graph.get(path);
      if (!node) continue;
      for (const s of node.symbols) {
        if (s.name.toLowerCase().includes(ql)) {
          out.push({ name: s.name, kind: s.kind, filePath: path, line: s.line, source: 'index' });
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  // ── Dependency graph ─────────────────────────────────────────────────────────────
  /** Files this file imports (downstream), with resolution status for display. Lazily indexes
   *  each step so a walk into never-opened files reads them on demand. */
  async dependenciesOf(rel: string, depth = 1): Promise<DepEdge[]> {
    const node = await this.ensureIndexed(rel);
    if (!node) return [];
    for (const spec of node.imports) {
      const resolved = await this.resolveOnDisk(spec, rel, node.language);
      if (resolved && !node.resolvedImports.includes(resolved)) {
        node.resolvedImports.push(resolved);
        this.updateReverse(rel, [], [resolved]);
      }
    }
    const out: DepEdge[] = [];
    const seen = new Set<string>([rel]);
    let frontier: { path: string; d: number; parent: string }[] =
      node.resolvedImports.filter((p) => !seen.has(p)).map((p) => ({ path: p, d: 1, parent: rel }));
    // Carry raw-import status for display on the first level (which imports resolved vs not).
    while (frontier.length) {
      const next: { path: string; d: number; parent: string }[] = [];
      for (const { path, d, parent } of frontier) {
        if (seen.has(path)) continue;
        seen.add(path);
        const child = await this.ensureIndexed(path);
        if (!child) {
          // Target no longer exists on disk (deleted/renamed since `parent` was last indexed) —
          // prune the stale edge so it stops resurfacing on future walks, and report it as
          // unresolved instead of a live dependency.
          const parentNode = this.graph.get(parent);
          if (parentNode) {
            const idx = parentNode.resolvedImports.indexOf(path);
            if (idx !== -1) parentNode.resolvedImports.splice(idx, 1);
          }
          this.updateReverse(parent, [path], []);
          out.push({ path, resolved: false });
          continue;
        }
        out.push({ path, resolved: true });
        if (d < depth) {
          for (const c of child.resolvedImports ?? []) if (!seen.has(c)) next.push({ path: c, d: d + 1, parent: path });
        }
      }
      frontier = next;
    }
    return out;
  }

  /** Files that import this one (upstream — "what breaks if I change this?"). Sourced from the
   *  reverse index, so it covers all currently-indexed importers. */
  async dependentsOf(rel: string, _depth = 1): Promise<DepEdge[]> {
    // Ensure the file is known so its own node exists (the reverse map is populated by importers).
    await this.ensureIndexed(rel);
    const set = this.reverse.get(rel);
    if (!set || set.size === 0) return [];
    return [...set].map((path) => ({ path, resolved: true }));
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────────
function uniq(arr: string[]): string[] { return [...new Set(arr)]; }
function dirname(p: string): string { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
function normalizeJoin(base: string, rel: string): string {
  const parts = (base ? base.split('/') : []).concat(rel.split('/'));
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

/** Map VS Code's numeric SymbolKind to a short readable label for the tool output. */
function kindLabel(kind: number): string {
  // Subset of vscode.SymbolKind — enough to tell a function from a class from a variable.
  const labels: Record<number, string> = {
    1: 'File', 2: 'Module', 3: 'Package', 4: 'Namespace', 5: 'Class', 6: 'Method', 7: 'Property',
    8: 'Field', 9: 'Constructor', 10: 'Enum', 11: 'Interface', 12: 'Function', 13: 'Variable',
    14: 'Constant', 15: 'String', 16: 'Number', 17: 'Boolean', 18: 'Array', 19: 'Object',
    20: 'Key', 21: 'Null', 22: 'EnumMember', 23: 'Struct', 24: 'Event', 25: 'Operator', 26: 'TypeParameter',
  };
  return labels[kind] ?? 'symbol';
}
