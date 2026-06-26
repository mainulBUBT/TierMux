// Context Bundle Cache — disk-persistent, task-keyed context bundles.
//
// Lookup order: symbolGraph (O(1)) → bundleCache (Jaccard hit) → grep (fallback)
//
// Bundle format: compressed intent memory (summary + file anchors + symbols).
// No rawBundle — saves 300–1500 tokens per request and forces semantic compression.
//
// Confidence gating:
//   < 0.5  → skip injection (too uncertain)
//   0.5–0.75 → inject summary + symbols only
//   > 0.75 → full injection including files
//
// Storage: .tiermux/bundle-cache.json (workspace-local)
// TTL: 24 hours by default (per-bundle configurable)
// Max: 50 bundles per workspace (evict oldest)
import * as vscode from 'vscode';

const CACHE_REL = '.tiermux/bundle-cache.json';
const SYNONYMS_REL = '.tiermux/synonyms.json';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 50;

// Domain synonym map — per-workspace, NOT hardcoded.
//
// The previous version shipped a Laravel/bazardor-flavoured list baked into the
// source. That actively hurt any other project: "user"→"customer" or
// "product"→"item" would silently match unrelated bundles in a Rust CLI, a
// Python ML repo, a SaaS Next.js app, etc. Synonyms are inherently project-
// specific vocabulary, so they live in the workspace, not the binary.
//
// To enable synonym expansion for a workspace, create `.tiermux/synonyms.json`:
//   {
//     "cheapest": ["lowest", "minimum"],
//     "market":   ["shop", "store", "vendor"]
//   }
// `lookupBundle({ expandSynonyms: true })` will then grow the search-term set
// with whatever is defined here. File is loaded fresh per lookup (small JSON,
// typical size <2KB) and cached in memory per process.

let _synonymsCache: { at: number; map: Record<string, string[]> } | undefined;
const SYNONYMS_TTL_MS = 30_000;

async function loadSynonyms(): Promise<Record<string, string[]>> {
  if (_synonymsCache && Date.now() - _synonymsCache.at < SYNONYMS_TTL_MS) {
    return _synonymsCache.map;
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return {};
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, SYNONYMS_REL));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Validate shape: every value must be string[].
      const map: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
          map[k.toLowerCase()] = (v as string[]).map((s) => s.toLowerCase());
        }
      }
      _synonymsCache = { at: Date.now(), map };
      return map;
    }
  } catch { /* file missing or malformed — fall through to empty map */ }
  _synonymsCache = { at: Date.now(), map: {} };
  return {};
}

/** Apply a pre-loaded synonyms map to a term list. Lowercased, deduplicated,
 *  original-preserving. Used by `lookupBundle` to expand both sides of a
 *  Jaccard comparison against the same map. */
function applySynonyms(terms: string[], map: Record<string, string[]>): string[] {
  const out = new Set<string>(terms.map((t) => t.toLowerCase()));
  for (const t of terms) {
    const k = t.toLowerCase();
    for (const syn of map[k] ?? []) out.add(syn);
  }
  return [...out];
}

export interface TaskBundle {
  /** Normalised, sorted search terms — the cache key. */
  terms: string[];
  /** Relevant file paths discovered during research. */
  files: string[];
  /** Symbol names discovered (name → file:line). */
  symbols: Array<{ name: string; file: string; line: number; kind: string }>;
  /** Grep patterns that returned hits. */
  patterns: string[];
  /**
   * Compressed semantic summary (~100-300 chars).
   * Replaces rawBundle — model never re-parses raw grep output.
   * Format: "Found: {symbol} in {file}:{line}. Context: {one-line summary}"
   */
  summary: string;
  /**
   * Quality of term matches (0–1).
   * 1.0 = all terms found as exact symbol/file names.
   * 0.5 = partial matches via grep.
   * 0.0 = nothing found.
   */
  hitScore: number;
  /**
   * Overall injection confidence (0–1).
   * < 0.5  → skip (too uncertain)
   * 0.5–0.75 → partial inject (summary + symbols)
   * > 0.75 → full inject (summary + symbols + files)
   */
  confidence: number;
  /** Unix ms timestamp of creation. */
  ts: number;
  /** TTL in ms. Default 24h. Short-lived for frequently changing code. */
  ttl: number;
  /** How many times this bundle has been reused. */
  useCount: number;
}

function cacheUri(): vscode.Uri | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  return root ? vscode.Uri.joinPath(root, CACHE_REL) : undefined;
}

async function loadAll(): Promise<TaskBundle[]> {
  const uri = cacheUri();
  if (!uri) return [];
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as TaskBundle[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveAll(bundles: TaskBundle[]): Promise<void> {
  const uri = cacheUri();
  if (!uri) return;
  try {
    const dir = vscode.Uri.joinPath(uri, '..');
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(bundles, null, 2)));
  } catch { /* best-effort */ }
}

function norm(t: string): string { return t.toLowerCase().trim(); }

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a.map(norm));
  const sb = new Set(b.map(norm));
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Look up a cached bundle for the given search terms.
 * Returns bundle only if Jaccard ≥ minJaccard AND within TTL AND confidence ≥ 0.5.
 *
 * Options:
 *   expandSynonyms  Grow the search-term set with workspace-local synonyms from
 *                   `.tiermux/synonyms.json` before matching. No-op if the file
 *                   doesn't exist. Synonyms are project-specific by design — the
 *                   user (or a project maintainer) decides what counts as a
 *                   synonym for their domain.
 *   minJaccard      Override the 0.5 default. Pass 0.4 for chain follow-ups where
 *                   the user has shifted intent slightly (add, fix, etc.).
 */
export interface LookupOpts {
  expandSynonyms?: boolean;
  minJaccard?: number;
}

export async function lookupBundle(terms: string[], opts: LookupOpts = {}): Promise<TaskBundle | undefined> {
  if (terms.length === 0) return undefined;
  const minJ = opts.minJaccard ?? 0.5;
  // Load the synonyms file ONCE per call (30s in-memory cache after that).
  // When no file is present, `expandTerms` is a no-op and we score on the
  // original terms — same behaviour as before, just with one extra map lookup.
  const synonyms = opts.expandSynonyms ? await loadSynonyms() : undefined;
  const hasSynonyms = !!synonyms && Object.keys(synonyms).length > 0;
  const searchTerms = hasSynonyms ? applySynonyms(terms, synonyms!) : terms;
  const all = await loadAll();
  const now = Date.now();
  const fresh = all.filter((b) => now - b.ts < (b.ttl ?? DEFAULT_TTL_MS));

  let best: TaskBundle | undefined;
  let bestScore = 0;
  for (const b of fresh) {
    // Expand BOTH sides when synonyms are configured — otherwise query "X" vs
    // bundle "synonym-of-X" scores ≈ 1/6 (the union grows but the intersection
    // doesn't), which is the OPPOSITE of what synonym expansion should do.
    // With both sides expanded, the shared synonym roots lift the intersection.
    const bundleTerms = hasSynonyms ? applySynonyms(b.terms, synonyms!) : b.terms;
    const score = jaccard(searchTerms, bundleTerms);
    if (score >= minJ && score > bestScore && b.confidence >= 0.5) {
      best = b;
      bestScore = score;
    }
  }

  if (best) {
    best.useCount++;
    void saveAll(fresh.map((b) => (b === best ? best : b)));
  }
  return best;
}

/** Format a bundle for injection into the system prompt, gated by confidence. */
export function formatBundle(bundle: TaskBundle): string {
  const parts: string[] = [];
  if (bundle.summary) parts.push(bundle.summary);
  if (bundle.symbols.length) {
    parts.push(bundle.symbols.map((s) => `- \`${s.name}\` ${s.kind} → ${s.file}:${s.line}`).join('\n'));
  }
  // Full injection only above 0.75 confidence
  if (bundle.confidence > 0.75 && bundle.files.length) {
    parts.push(`Files: ${bundle.files.slice(0, 5).join(', ')}`);
  }
  return parts.join('\n\n');
}

/**
 * Save a bundle. The summary + hitScore + confidence are computed from grep results here
 * so callers don't need to know the compression format.
 */
export async function saveBundle(bundle: Omit<TaskBundle, 'ts' | 'useCount'>): Promise<void> {
  if (!bundle.summary && !bundle.symbols.length) return;
  const all = await loadAll();
  const now = Date.now();
  const fresh = all.filter((b) => now - b.ts < (b.ttl ?? DEFAULT_TTL_MS));

  const existing = fresh.findIndex((b) => jaccard(bundle.terms, b.terms) >= 0.9);
  const entry: TaskBundle = { ...bundle, ts: now, useCount: 0 };
  if (existing >= 0) {
    fresh[existing] = entry;
  } else {
    fresh.push(entry);
  }

  while (fresh.length > MAX_ENTRIES) fresh.shift();
  await saveAll(fresh);
}

/**
 * Compress grep results into a structured bundle (no LLM).
 * Extracts file paths, symbol names, and one-line context from raw grep text.
 */
export function compressGrepResults(
  grepText: string,
  searchTerms: string[],
): Pick<TaskBundle, 'summary' | 'files' | 'symbols' | 'patterns' | 'hitScore' | 'confidence'> {
  const files: string[] = [];
  const symbols: TaskBundle['symbols'] = [];
  const patterns = [...searchTerms];

  // Extract file:line:content triples from grep output
  // Format: "path/to/file.ts:42: content"
  const lineRe = /^([\w./\\-]+\.[a-zA-Z]{1,5}):(\d+):\s*(.{0,120})/gm;
  const summaryLines: string[] = [];
  for (const m of grepText.matchAll(lineRe)) {
    const [, file, line, content] = m;
    if (!files.includes(file)) files.push(file);
    // Extract PascalCase/camelCase identifiers as symbols
    for (const sym of (content ?? '').matchAll(/\b([A-Z][a-zA-Z0-9]{2,}|[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]+)\b/g)) {
      const name = sym[1];
      if (!symbols.find((s) => s.name === name)) {
        symbols.push({ name, file, line: parseInt(line, 10), kind: 'const' });
      }
    }
    summaryLines.push(`${file}:${line}: ${(content ?? '').trim().slice(0, 80)}`);
    if (summaryLines.length >= 5) break;
  }

  // Also extract bold-formatted file paths from markdown grep output
  for (const m of grepText.matchAll(/\*\*([\w./\\-]+\.[a-zA-Z]{1,5})\*\*/g)) {
    if (!files.includes(m[1])) files.push(m[1]);
  }
  // Extract symbol entries in markdown format
  for (const m of grepText.matchAll(/- `(\w+)` (\w+) → ([\w./\\-]+):(\d+)/g)) {
    if (!symbols.find((s) => s.name === m[1])) {
      symbols.push({ name: m[1], kind: m[2], file: m[3], line: parseInt(m[4], 10) });
    }
  }

  const hitScore = files.length === 0 ? 0 : Math.min(1, (files.length * 0.2) + (symbols.length * 0.1));
  const confidence = hitScore;
  const summary = summaryLines.length
    ? `Found in ${files.slice(0, 3).join(', ')}:\n${summaryLines.join('\n')}`
    : '';

  return { summary, files, symbols, patterns, hitScore, confidence };
}
