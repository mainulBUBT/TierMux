// Precomputed inverted index — zero grep at request time.
//
// At BUILD time (file watcher / explicit trigger):
//   scan workspace → tokenize every line → build term→[{file,line,text}] map → save to disk
//
// At REQUEST time:
//   invertedLookup(terms) → O(1) Map get → hits → no child_process, no file scan
//
// This replaces runtime grep for all known-term lookups.
// grep remains available as a tool for REGEX patterns and user-initiated searches.
//
// Storage: .tiermux/inverted-index.json
// Incremental: only re-indexes files whose mtime changed since last build.
// Max hits per term: 8 (prevents common words from bloating context)
// Max index size: 3000 terms (prune least-frequent on overflow)

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const INDEX_REL = '.tiermux/inverted-index.json';
const SUPPORTED_EXTS = /\.(ts|tsx|js|jsx|mjs|cjs|php|py|go|rb|java|cs|cpp|c|rs|swift|kt)$/;

// Hard ignore — vendor code, generated output, logs, test coverage.
// These produce false hits that pollute context with irrelevant library code.
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.next', '.venv', 'vendor',
  '__pycache__', '.cache', 'coverage', '.nyc_output', 'storage',
  'public', 'static', '.turbo', '.parcel-cache', 'stubs', 'fixtures',
]);
// Also exclude path segments that look like vendor sub-paths
const EXCLUDE_PATH_RE = /\/(vendor|node_modules|dist|build|coverage|storage\/logs)\//;

import { tokenizePathSegments } from './pathTokens';

const MAX_HITS_PER_TERM = 8;
const MAX_TERMS = 8000;
const MAX_FILES = 600;


const STOP = new Set([
  'about','after','also','back','been','both','call','code','come','does','done','down',
  'each','even','file','files','find','from','give','goes','good','have','help','here',
  'into','just','keep','know','last','like','list','look','made','make','many','more',
  'most','move','much','must','name','need','next','only','open','over','page','part',
  'read','repo','rest','same','send','show','side','some','sure','take','tell','than',
  'that','them','then','they','this','time','true','used','uses','very','want','well',
  'went','were','what','when','will','with','word','work','your','gets','where','which',
  'there','these','those','their','codebase','project','function','user','users','data',
  'info','item','items','list','result','results','value','values','type','types',
  'const','class','return','export','import','default','interface','async','await',
  'void','null','true','false','undefined','string','number','boolean','object','array',
  'public','private','protected','static','readonly','abstract','override',
]);

export interface IndexHit {
  file: string;
  line: number;
  text: string;
  /** True when this line is a function/class/method definition — ranked above usage hits. */
  isDef?: boolean;
}

interface StoredIndex {
  version: number;
  /** term → hits (sorted by file path for determinism) */
  entries: Record<string, IndexHit[]>;
  /** workspace-relative file path → mtime ms (for incremental rebuild) */
  fileMtimes: Record<string, number>;
  builtAt: number;
}

// In-memory cache — survives across requests in the same extension session
let _memCache: StoredIndex | undefined;

function indexUri(): vscode.Uri | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  return root ? vscode.Uri.joinPath(root, INDEX_REL) : undefined;
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Load from memory cache first, then disk. */
async function loadIndex(): Promise<StoredIndex> {
  if (_memCache) return _memCache;
  const uri = indexUri();
  if (!uri) return emptyIndex();
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as StoredIndex;
    if (parsed?.entries) { _memCache = parsed; return parsed; }
  } catch { /* not built yet */ }
  return emptyIndex();
}

function emptyIndex(): StoredIndex {
  return { version: 1, entries: {}, fileMtimes: {}, builtAt: 0 };
}

/** Tokenize a single source line into indexable terms. */
function tokenizeLine(line: string): string[] {
  const terms = new Set<string>();
  const add = (t: string): void => {
    const k = t.toLowerCase();
    if (k.length >= 3 && k.length <= 40 && !STOP.has(k) && /^[a-z]/.test(k)) terms.add(k);
  };

  // PascalCase → split into parts: CheckoutService → checkout, service
  for (const m of line.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)) {
    add(m[1]); // full name
    for (const part of m[1].split(/(?=[A-Z])/)) add(part); // each part
  }
  // camelCase: getUserById → get, user, by, id
  for (const m of line.matchAll(/\b([a-z][a-z]+[A-Z][a-zA-Z]+)\b/g)) {
    add(m[1]);
    for (const part of m[1].split(/(?=[A-Z])/)) add(part);
  }
  // snake_case identifiers
  for (const m of line.matchAll(/\b([a-z][a-z0-9_]{3,})\b/g)) {
    if (m[1].includes('_')) { add(m[1]); for (const part of m[1].split('_')) add(part); }
    else add(m[1]);
  }

  return [...terms];
}

// Detect definition lines: function/method/class declarations.
// These are inserted at the FRONT of the hit list (isDef=true) so they rank above usages.
const DEF_RE = /^\s*(?:(?:public|private|protected|static|async|export|abstract|override)\s+)*(?:function\s+(\w+)|(?:class|interface|enum|trait|abstract\s+class)\s+(\w+)|(?:def|func|fn)\s+(\w+)|(\w+)\s*[=:]\s*(?:async\s+)?(?:function|\(.*\)\s*=>)|\bpublic\s+function\s+(\w+)|\bprivate\s+function\s+(\w+)|\bprotected\s+function\s+(\w+))/;

/** Scan a single file and return its index contributions. */
function indexFile(relPath: string, content: string): Record<string, IndexHit[]> {
  const result: Record<string, IndexHit[]> = {};
  const lines = content.split('\n');

  const addHit = (term: string, hit: IndexHit): void => {
    if (!result[term]) result[term] = [];
    // Definitions go to front of list; usages appended up to MAX_HITS_PER_TERM.
    if (hit.isDef) {
      result[term].unshift(hit);
      if (result[term].length > MAX_HITS_PER_TERM) result[term].pop();
    } else if (result[term].length < MAX_HITS_PER_TERM) {
      result[term].push(hit);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const text = raw.trim().slice(0, 120);
    if (!text || text.startsWith('//') || text.startsWith('*') || text.startsWith('#')) continue;

    // Check for definition — extract the defined name and index it with isDef=true.
    const defMatch = raw.match(DEF_RE);
    const defName = defMatch?.slice(1).find(Boolean);
    if (defName) {
      const k = defName.toLowerCase();
      if (k.length >= 3 && !STOP.has(k)) {
        addHit(k, { file: relPath, line: i + 1, text, isDef: true });
        addHit(defName, { file: relPath, line: i + 1, text, isDef: true }); // preserve case
      }
    }

    for (const term of tokenizeLine(raw)) {
      addHit(term, { file: relPath, line: i + 1, text });
    }
  }

  // Path tokens: the file's own location is the highest-signal search index.
  // Indexing the path means a query for "comparison" or "market" resolves to
  // MarketComparisonService.php in O(1) without any runtime grep. Path-derived
  // hits carry isDef=true so they outrank body-text usage hits.
  for (const term of tokenizePathSegments(relPath)) {
    addHit(term, { file: relPath, line: 1, text: relPath, isDef: true });
  }

  return result;
}

/** Walk workspace files, collect those matching supported extensions. */
function collectFiles(root: string): Array<{ rel: string; abs: string }> {
  const results: Array<{ rel: string; abs: string }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || results.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (EXCLUDE_PATH_RE.test('/' + rel + '/')) continue;
      if (e.isDirectory()) { walk(abs, depth + 1); }
      else if (e.isFile() && SUPPORTED_EXTS.test(e.name)) {
        results.push({ rel, abs });
      }
    }
  };
  walk(root, 0);
  return results;
}

/**
 * Build or incrementally update the inverted index.
 * Only re-indexes files whose mtime changed since last build.
 * Saves to disk and updates the in-memory cache.
 */
export async function buildInvertedIndex(full = false): Promise<StoredIndex> {
  const root = workspaceRoot();
  if (!root) return emptyIndex();

  const prev = full ? emptyIndex() : await loadIndex();
  const files = collectFiles(root);

  // Find changed files (new or mtime different)
  const changed: Array<{ rel: string; abs: string }> = [];
  const newMtimes: Record<string, number> = { ...prev.fileMtimes };
  for (const f of files) {
    try {
      const mtime = fs.statSync(f.abs).mtimeMs;
      if (full || (prev.fileMtimes[f.rel] ?? -1) !== mtime) {
        changed.push(f);
        newMtimes[f.rel] = mtime;
      }
    } catch { /* skip */ }
  }

  if (changed.length === 0 && !full) {
    return prev; // nothing changed, return cached
  }

  // Remove stale entries for changed files
  const merged: Record<string, IndexHit[]> = {};
  if (!full) {
    const changedSet = new Set(changed.map((f) => f.rel));
    for (const [term, hits] of Object.entries(prev.entries)) {
      const filtered = hits.filter((h) => !changedSet.has(h.file));
      if (filtered.length) merged[term] = filtered;
    }
  }

  // Index changed files
  for (const f of changed) {
    try {
      const content = fs.readFileSync(f.abs, 'utf8');
      const fileEntries = indexFile(f.rel, content);
      for (const [term, hits] of Object.entries(fileEntries)) {
        if (!merged[term]) merged[term] = [];
        merged[term].push(...hits);
        // Cap per-term hits across all files
        if (merged[term].length > MAX_HITS_PER_TERM) {
          merged[term] = merged[term].slice(0, MAX_HITS_PER_TERM);
        }
      }
    } catch { /* skip unreadable files */ }
  }

  // Prune least-frequent terms on overflow (keep highest-hit-count terms)
  const terms = Object.keys(merged);
  if (terms.length > MAX_TERMS) {
    const sorted = terms.sort((a, b) => (merged[b]?.length ?? 0) - (merged[a]?.length ?? 0));
    for (const t of sorted.slice(MAX_TERMS)) delete merged[t];
  }

  const index: StoredIndex = {
    version: (prev.version ?? 0) + 1,
    entries: merged,
    fileMtimes: newMtimes,
    builtAt: Date.now(),
  };

  _memCache = index;

  // Persist to disk (fire-and-forget)
  const uri = indexUri();
  if (uri) {
    void (async () => {
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(index)));
      } catch { /* best-effort */ }
    })();
  }

  return index;
}

// ---- Git-aware file ranking ----

/** Get set of files changed in recent git commits (last 10). Cached 60s. */
let _gitChangedCache: { files: Set<string>; at: number } | undefined;

async function getRecentlyGitChangedFiles(root: string): Promise<Set<string>> {
  const now = Date.now();
  if (_gitChangedCache && now - _gitChangedCache.at < 60_000) return _gitChangedCache.files;
  return new Promise((resolve) => {
    const cp = require('child_process') as typeof import('child_process');
    cp.exec('git log --name-only --pretty=format: -10', { cwd: root, timeout: 2000, maxBuffer: 32 * 1024 }, (err, stdout) => {
      const files = new Set<string>(
        (err ? '' : stdout).split('\n').map((l) => l.trim()).filter(Boolean),
      );
      _gitChangedCache = { files, at: now };
      resolve(files);
    });
  });
}

/** Get set of currently open file paths (workspace-relative). */
function getOpenFilePaths(): Set<string> {
  const open = new Set<string>();
  for (const g of vscode.window.tabGroups.all) {
    for (const t of g.tabs) {
      if (t.input instanceof vscode.TabInputText) {
        open.add(vscode.workspace.asRelativePath(t.input.uri));
      }
    }
  }
  return open;
}

/**
 * Score a hit for ranking:
 *   isDef    +40  (definition beats usage)
 *   gitChange+30  (recently changed in git)
 *   openFile +20  (currently open in editor)
 *   mtime    0–10 (relative recency from index.fileMtimes)
 */
function scoreHit(h: IndexHit, gitChanged: Set<string>, openFiles: Set<string>, mtimes: Record<string, number>): number {
  let score = 0;
  if (h.isDef) score += 40;
  if (gitChanged.has(h.file)) score += 30;
  if (openFiles.has(h.file)) score += 20;
  const mtime = mtimes[h.file] ?? 0;
  if (mtime > 0) {
    const ageHours = (Date.now() - mtime) / 3_600_000;
    score += Math.max(0, 10 - Math.floor(ageHours / 24)); // 10 pts today, -1 per day
  }
  return score;
}

/**
 * Look up terms in the precomputed index. O(1) per term.
 * Hits are ranked: definitions > git-changed > open files > mtime recency > usages.
 * Falls back misses list for terms the index doesn't know (caller should use grep).
 */
export async function lookupInvertedIndex(
  terms: string[],
): Promise<{ hits: IndexHit[]; misses: string[] }> {
  const index = await loadIndex();
  const root = workspaceRoot();
  const [gitChanged, openFiles] = await Promise.all([
    root ? getRecentlyGitChangedFiles(root) : Promise.resolve(new Set<string>()),
    Promise.resolve(getOpenFilePaths()),
  ]);

  const seen = new Set<string>();
  const hits: IndexHit[] = [];
  const misses: string[] = [];

  for (const term of terms) {
    const k = term.toLowerCase();
    const termHits = index.entries[k] ?? index.entries[term]; // try original case too
    if (!termHits || termHits.length === 0) { misses.push(term); continue; }
    for (const h of termHits) {
      const key = `${h.file}:${h.line}`;
      if (!seen.has(key)) { seen.add(key); hits.push(h); }
    }
  }

  // Sort: highest score first
  hits.sort((a, b) => scoreHit(b, gitChanged, openFiles, index.fileMtimes) - scoreHit(a, gitChanged, openFiles, index.fileMtimes));

  return { hits, misses };
}

/** Format index hits as a compact context string for the system prompt. */
export function formatIndexHits(hits: IndexHit[]): string {
  if (!hits.length) return '';
  const lines = hits.slice(0, 8).map((h) => `${h.file}:${h.line}: ${h.text}`);
  return `### Index hits\n\n${lines.join('\n')}`;
}

/** Check if an index exists and is fresh enough (< 24h). */
export async function indexIsFresh(): Promise<boolean> {
  const index = await loadIndex();
  return index.builtAt > 0 && Date.now() - index.builtAt < 24 * 60 * 60 * 1000;
}

/** Invalidate in-memory cache (e.g., after a file save — triggers incremental rebuild on next lookup). */
export function invalidateIndexCache(): void {
  _memCache = undefined;
}

/**
 * Remove all index entries for a deleted file.
 * Called from onDidDeleteFiles watcher — O(terms) scan, not O(files).
 */
export async function removeFileFromIndex(relPath: string): Promise<void> {
  const index = await loadIndex();
  let changed = false;
  for (const [term, hits] of Object.entries(index.entries)) {
    const filtered = hits.filter((h) => h.file !== relPath);
    if (filtered.length !== hits.length) {
      if (filtered.length === 0) delete index.entries[term];
      else index.entries[term] = filtered;
      changed = true;
    }
  }
  if (changed) {
    delete index.fileMtimes[relPath];
    _memCache = index;
    const uri = indexUri();
    if (uri) void vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(index))).then(() => undefined, () => undefined);
  }
}

/**
 * Remap all index entries from oldRel to newRel (file rename/move).
 * Called from onDidRenameFiles watcher.
 */
export async function renameFileInIndex(oldRel: string, newRel: string): Promise<void> {
  const index = await loadIndex();
  let changed = false;
  for (const hits of Object.values(index.entries)) {
    for (const h of hits) {
      if (h.file === oldRel) { h.file = newRel; changed = true; }
    }
  }
  if (changed) {
    const mtime = index.fileMtimes[oldRel];
    if (mtime !== undefined) {
      delete index.fileMtimes[oldRel];
      index.fileMtimes[newRel] = mtime;
    }
    _memCache = index;
    const uri = indexUri();
    if (uri) void vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(index))).then(() => undefined, () => undefined);
  }
}
