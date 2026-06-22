// Flat O(1) symbol lookup built from the structural graph.
// The structural graph stores per-file exports (name, kind, line) but requires
// a full graph scan to answer "where is calculatePrice?". This module flattens
// that into a Map for instant lookups — the difference between O(n) grep and O(1) hash.
import type { StructuralGraph, ExportInfo } from './structuralGraph';

export interface SymbolEntry {
  file: string;
  line: number;
  kind: ExportInfo['kind'];
}

/** symbolName → all places it is exported from. Usually one entry; multiple on re-exports. */
export type SymbolIndex = Map<string, SymbolEntry[]>;

// Module-level cache: avoid rebuilding on every pre-research call.
// Keyed by graph.version (incremented on every updateFileInGraph save).
let _cache: { version: number; index: SymbolIndex } | undefined;

/** Return a cached index if the graph version hasn't changed, else rebuild. */
export function getOrBuildSymbolIndex(graph: StructuralGraph): SymbolIndex {
  if (_cache && _cache.version === graph.version) return _cache.index;
  const index = buildSymbolIndex(graph);
  _cache = { version: graph.version, index };
  return index;
}

/** Build the flat index from a loaded graph. Fast — single pass over graph.files. */
export function buildSymbolIndex(graph: StructuralGraph): SymbolIndex {
  const index: SymbolIndex = new Map();
  for (const file of graph.files) {
    for (const exp of file.exports) {
      if (exp.name === 'default' || exp.name === '*') continue;
      const entries = index.get(exp.name) ?? [];
      entries.push({ file: file.path, line: exp.line, kind: exp.kind });
      index.set(exp.name, entries);
    }
  }
  return index;
}

/** Exact lookup. Returns [] when not found. */
export function lookupSymbol(index: SymbolIndex, name: string): SymbolEntry[] {
  return index.get(name) ?? [];
}

/**
 * Fuzzy search: symbols whose name contains `query` (case-insensitive).
 * Used in pre-research when the user writes a partial name or mixed case.
 */
export function searchSymbols(
  index: SymbolIndex,
  query: string,
  max = 8,
): Array<{ name: string } & SymbolEntry> {
  const q = query.toLowerCase();
  const results: Array<{ name: string } & SymbolEntry> = [];
  for (const [name, entries] of index) {
    if (name.toLowerCase().includes(q)) {
      for (const e of entries) {
        results.push({ name, ...e });
        if (results.length >= max) return results;
      }
    }
  }
  return results;
}

/**
 * Format symbol hits as a compact markdown section for the system prompt.
 * Example:
 *   ### Symbol index hits
 *   - `calculatePrice` function → app/Services/PricingService.php:42
 *   - `PriceContribution` class → app/Models/PriceContribution.php:8
 */
export function formatSymbolHits(hits: Array<{ name: string } & SymbolEntry>): string {
  const lines = hits.map((h) => `- \`${h.name}\` ${h.kind} → ${h.file}:${h.line}`);
  return `### Symbol index hits\n\n${lines.join('\n')}`;
}
