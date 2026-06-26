// Flat O(1) symbol lookup built from the structural graph.
// The structural graph stores per-file exports (name, kind, line) but requires
// a full graph scan to answer "where is calculatePrice?". This module flattens
// that into a Map for instant lookups — the difference between O(n) grep and O(1) hash.
//
// Two parallel indexes:
//   1) SymbolIndex  — symbolName → exports (exact + substring match on name)
//   2) PathIndex    — path-token  → { file, line, kind } (synthetic anchor at the
//                                    file's first export). Filled in for natural-
//                                    language terms that don't appear in any export
//                                    name (e.g. "market" → MarketComparisonService.php).
import type { StructuralGraph, ExportInfo } from './structuralGraph';
import { tokenizePathSegments } from './pathTokens';

export interface SymbolEntry {
  file: string;
  line: number;
  kind: ExportInfo['kind'];
  /** Last line of the symbol body, if known — drives `:startLine-endLine` rendering. */
  endLine?: number;
  /** 'export' = real symbol declaration; 'path' = synthetic hit via file path token. */
  source?: 'export' | 'path';
}

/** symbolName → all places it is exported from. Usually one entry; multiple on re-exports. */
export type SymbolIndex = Map<string, SymbolEntry[]>;

/** pathToken (lowercased) → synthetic file anchors. Built from each file's path segments. */
export type PathIndex = Map<string, SymbolEntry[]>;

/** Both indexes built from a single pass over the graph. */
export interface SymbolIndexes {
  symbolIndex: SymbolIndex;
  pathIndex: PathIndex;
}

// Module-level cache: avoid rebuilding on every pre-research call.
// Keyed by graph.version (incremented on every updateFileInGraph save).
let _cache: { version: number; indexes: SymbolIndexes } | undefined;

// Conservative end-line window for files with a single export (or no exports
// at all). Used as a fallback when there's no next export to delimit against.
// Most exported functions/classes fit in 60 lines; anything larger is a code
// smell we don't want to over-broadcast in pre-research.
const FALLBACK_END_LINE = 60;

/** Return a cached index if the graph version hasn't changed, else rebuild. */
export function getOrBuildSymbolIndex(graph: StructuralGraph): SymbolIndex {
  if (_cache && _cache.version === graph.version) return _cache.indexes.symbolIndex;
  const indexes = buildSymbolIndexes(graph);
  _cache = { version: graph.version, indexes };
  return indexes.symbolIndex;
}

/** Return a cached path index. Companion to the symbol index — searches run
 *  against both and merge results. The path index is what catches natural-language
 *  terms like "market" or "comparison" that don't appear in any export name. */
export function getOrBuildPathIndex(graph: StructuralGraph): PathIndex {
  if (_cache && _cache.version === graph.version) return _cache.indexes.pathIndex;
  const indexes = buildSymbolIndexes(graph);
  _cache = { version: graph.version, indexes };
  return indexes.pathIndex;
}

/** Build the flat indexes from a loaded graph. Fast — single pass over graph.files. */
export function buildSymbolIndexes(graph: StructuralGraph): SymbolIndexes {
  const symbolIndex: SymbolIndex = new Map();
  const pathIndex: PathIndex = new Map();
  for (const file of graph.files) {
    // Anchor: the first export of the file is the line we point path-token hits at.
    // endLine = next export's line - 1 (or FALLBACK_END_LINE past the last export).
    const exports = file.exports.filter((e) => e.name !== 'default' && e.name !== '*');
    exports.sort((a, b) => a.line - b.line);
    for (let i = 0; i < exports.length; i++) {
      const exp = exports[i];
      const nextLine = exports[i + 1]?.line;
      const endLine = nextLine !== undefined ? nextLine - 1 : exp.line + FALLBACK_END_LINE;
      const entry: SymbolEntry = { file: file.path, line: exp.line, kind: exp.kind, endLine, source: 'export' };
      const list = symbolIndex.get(exp.name) ?? [];
      list.push(entry);
      symbolIndex.set(exp.name, list);
    }
    // Path tokens point at the first export (or line 1) as a synthetic anchor.
    const anchor = exports[0];
    const anchorLine = anchor?.line ?? 1;
    const anchorEnd = exports[1]?.line !== undefined
      ? exports[1].line - 1
      : anchorLine + FALLBACK_END_LINE;
    const synthetic: SymbolEntry = {
      file: file.path,
      line: anchorLine,
      endLine: anchorEnd,
      kind: anchor?.kind === 'function' ? 'function' : 'class',
      source: 'path',
    };
    for (const tok of tokenizePathSegments(file.path)) {
      const list = pathIndex.get(tok) ?? [];
      list.push(synthetic);
      pathIndex.set(tok, list);
    }
  }
  return { symbolIndex, pathIndex };
}

/** Exact lookup. Returns [] when not found. */
export function lookupSymbol(index: SymbolIndex, name: string): SymbolEntry[] {
  return index.get(name) ?? [];
}

/**
 * Tokenise a query the same way paths are tokenised (whitespace + PascalCase
 * + snake_case split) so multi-word queries ("market comparison", "user role")
 * can resolve to per-token path hits instead of missing entirely. */
function tokenizeQuery(query: string): string[] {
  const out = new Set<string>();
  for (const word of query.split(/\s+/).filter(Boolean)) {
    out.add(word.toLowerCase());
    for (const part of word.split(/(?=[A-Z])|[_-]+/)) {
      const p = part.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (p.length >= 3) out.add(p);
    }
  }
  return [...out];
}

/**
 * Fuzzy search: symbols whose name contains `query` (case-insensitive).
 * If a `pathIndex` is supplied, ALSO matches path tokens — e.g. searching for
 * "market" will find MarketComparisonService.php via its path even though no
 * export is literally named "market". Multi-word queries are tokenised the
 * same way paths are. Export hits always rank above path hits.
 */
export function searchSymbols(
  index: SymbolIndex,
  query: string,
  max = 8,
  pathIndex?: PathIndex,
): Array<{ name: string } & SymbolEntry> {
  const q = query.toLowerCase();
  const results: Array<{ name: string } & SymbolEntry> = [];
  // 1) export-name matches (ranked higher — pushed first)
  for (const [name, entries] of index) {
    if (name.toLowerCase().includes(q)) {
      for (const e of entries) {
        results.push({ name, ...e });
        if (results.length >= max) return results;
      }
    }
  }
  // 2) path-token matches (only if we have room and a path index was provided)
  if (pathIndex && results.length < max) {
    const room = max - results.length;
    const queryTokens = tokenizeQuery(query);
    const seenFile = new Set<string>();
    const collected: SymbolEntry[] = [];
    for (const tok of queryTokens) {
      for (const h of pathIndex.get(tok) ?? []) {
        if (seenFile.has(h.file)) continue;
        seenFile.add(h.file);
        collected.push(h);
        if (collected.length >= room) break;
      }
      if (collected.length >= room) break;
    }
    for (const h of collected) {
      const syntheticName = h.file.split('/').pop()?.replace(/\.[^.]+$/, '') ?? h.file;
      results.push({ name: syntheticName, ...h });
    }
  }
  return results;
}

/**
 * Format symbol hits as a compact markdown section for the system prompt.
 * Emits `:startLine-endLine` ranges so the model reads windowed slices instead
 * of full files. Approximate ranges are tagged so the model can widen if needed.
 * Example:
 *   ### Symbol index hits
 *   - `calculatePrice` function → app/Services/PricingService.php:42-78
 *   - `MarketComparisonService` class (path match) → app/Services/MarketComparisonService.php:1-60
 *   …
 *   When reading these files, prefer `readFile(path, startLine, endLine)`.
 */
export function formatSymbolHits(hits: Array<{ name: string } & SymbolEntry>): string {
  const lines = hits.map((h) => {
    const range = h.endLine && h.endLine > h.line ? `:${h.line}-${h.endLine}` : `:${h.line}`;
    const tag = h.source === 'path' ? ' (path match)' : '';
    return `- \`${h.name}\` ${h.kind}${tag} → ${h.file}${range}`;
  });
  return `### Symbol index hits\n\n${lines.join('\n')}\n\nWhen reading these files, prefer \`readFile(path, startLine, endLine)\` using the line range above — full-file reads are tracked and penalised. Ranges without a "path match" tag are exact; path-match ranges are approximate.`;
}
