// Context Bundle Cache — disk-persistent, task-keyed context bundles.
//
// Problem: pre-research (grep + semantic + symbol lookup) is re-run on every turn.
// For "add delivery slots" the agent finds StoreController, StoreSchedule, StoreResource.
// Five minutes later "now add the API endpoint" — same task, same files, but full research
// runs again. This wastes rate-limit quota and 300–800ms of latency.
//
// Solution: after pre-research completes, store a structured bundle keyed by a
// Jaccard hash of the search terms. Subsequent queries with ≥50% term overlap get
// the bundle instantly from disk — zero grep, zero semantic search.
//
// Storage: .tiermux/bundle-cache.json  (workspace-local, gitignored-friendly)
// TTL:     24 hours  (fresh enough; stale after a significant codebase change)
// Max:     50 bundles per workspace  (evict oldest on overflow)
import * as vscode from 'vscode';

const CACHE_REL = '.tiermux/bundle-cache.json';
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 50;

export interface TaskBundle {
  /** Normalised, sorted search terms — the cache key. */
  terms: string[];
  /** Relevant file paths discovered during research. */
  files: string[];
  /** Symbol names discovered (name → file:line). */
  symbols: Array<{ name: string; file: string; line: number; kind: string }>;
  /** Grep patterns that returned hits. */
  patterns: string[];
  /** The full formatted pre-research string to inject into the system prompt. */
  rawBundle: string;
  /** Unix ms timestamp of creation. */
  ts: number;
  /** How many times this bundle has been reused — useful for debugging. */
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
    // Ensure .tiermux/ dir exists.
    const dir = vscode.Uri.joinPath(uri, '..');
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(bundles, null, 2)));
  } catch { /* best-effort */ }
}

/** Normalise a term: lowercase, trim. */
function norm(t: string): string { return t.toLowerCase().trim(); }

/**
 * Jaccard similarity between two term sets: |A ∩ B| / |A ∪ B|.
 * 1.0 = identical sets. 0.0 = no overlap.
 */
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
 * Returns the best match if Jaccard similarity ≥ 0.5 and bundle is within TTL.
 * Also bumps `useCount` and re-saves on a hit.
 */
export async function lookupBundle(terms: string[]): Promise<TaskBundle | undefined> {
  if (terms.length === 0) return undefined;
  const all = await loadAll();
  const now = Date.now();
  const fresh = all.filter((b) => now - b.ts < TTL_MS);

  let best: TaskBundle | undefined;
  let bestScore = 0;
  for (const b of fresh) {
    const score = jaccard(terms, b.terms);
    if (score >= 0.5 && score > bestScore) {
      best = b;
      bestScore = score;
    }
  }

  if (best) {
    best.useCount++;
    // Fire-and-forget save — don't block the request on a disk write.
    void saveAll(fresh.map((b) => (b === best ? best : b)));
  }
  return best;
}

/**
 * Store a new bundle (or update an existing one with the same terms).
 * Evicts the oldest entry when MAX_ENTRIES is exceeded.
 */
export async function saveBundle(bundle: Omit<TaskBundle, 'ts' | 'useCount'>): Promise<void> {
  if (!bundle.rawBundle) return; // nothing useful to cache
  const all = await loadAll();
  const now = Date.now();
  const fresh = all.filter((b) => now - b.ts < TTL_MS);

  // Replace existing entry with same terms if present, else append.
  const existing = fresh.findIndex((b) => jaccard(bundle.terms, b.terms) >= 0.9);
  const entry: TaskBundle = { ...bundle, ts: now, useCount: 0 };
  if (existing >= 0) {
    fresh[existing] = entry;
  } else {
    fresh.push(entry);
  }

  // Evict oldest when over capacity.
  while (fresh.length > MAX_ENTRIES) fresh.shift();
  await saveAll(fresh);
}

/**
 * Extract structured data from a pre-research string to populate a bundle.
 * Parses the markdown sections produced by runResearchPipeline.
 */
export function extractBundleData(rawBundle: string, searchTerms: string[]): Omit<TaskBundle, 'ts' | 'useCount'> {
  const files: string[] = [];
  const symbols: TaskBundle['symbols'] = [];
  const patterns: string[] = [...searchTerms];

  // Extract file paths from grep results (lines like "- **path/to/file.php**: L12: `...`")
  const fileRe = /\*\*([\w./\\-]+\.[a-zA-Z]{1,5})\*\*/g;
  for (const m of rawBundle.matchAll(fileRe)) {
    const f = m[1];
    if (!files.includes(f)) files.push(f);
  }

  // Extract symbol entries (lines like "- `symbolName` function → path/to/file.ts:42")
  const symbolRe = /- `(\w+)` (\w+) → ([\w./\\-]+):(\d+)/g;
  for (const m of rawBundle.matchAll(symbolRe)) {
    symbols.push({ name: m[1], kind: m[2], file: m[3], line: parseInt(m[4], 10) });
  }

  return { terms: searchTerms.map(norm), files, symbols, patterns, rawBundle };
}
