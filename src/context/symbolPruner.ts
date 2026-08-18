// Shrinks a large @mention'd file down to a symbol skeleton plus the query-relevant symbol
// bodies, instead of dumping the whole file into a weak model's limited context window.
//
// Reuses the same regex symbol extraction the workspace index runs on every file (see
// src/indexer/importResolvers.ts) rather than adding a second parser. Symbol start lines are
// already in source order, so consecutive symbols bound each other's chunk — no per-language
// brace/indent matching needed. SymbolExtract carries only a start line, so the LAST symbol's
// chunk always runs to end-of-file.

import { extract, type SymbolExtract } from '../indexer/importResolvers';
import { estimateTokens } from '../agent/budget';

export const PRUNE_TOKEN_THRESHOLD = 1500;
const DEFAULT_TOKEN_BUDGET = 2000;

export interface PrunedResult {
  text: string;
  truncated: boolean;
  includedSymbols: number;
  totalSymbols: number;
}

interface Chunk {
  name: string;
  kind: string;
  startLine: number; // 1-indexed, inclusive
  endLine: number;   // 1-indexed, inclusive
}

/** Whether a file is large enough that pruning is worth doing at all. */
export function shouldPrune(text: string): boolean {
  return estimateTokens(text) > PRUNE_TOKEN_THRESHOLD;
}

function buildChunks(totalLines: number, symbols: SymbolExtract[]): Chunk[] {
  const sorted = [...symbols].sort((a, b) => a.line - b.line);
  const chunks: Chunk[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i].line;
    const end = i + 1 < sorted.length ? sorted[i + 1].line - 1 : totalLines;
    if (end < start) continue; // two symbols reported on the same line — skip the degenerate slice
    chunks.push({ name: sorted[i].name, kind: sorted[i].kind, startLine: start, endLine: end });
  }
  return chunks;
}

function scoreChunk(name: string, body: string, queryWords: string[]): number {
  const nameLower = name.toLowerCase();
  const bodyLower = body.toLowerCase();
  let score = 0;
  for (const w of queryWords) {
    if (nameLower === w) score += 5;
    else if (nameLower.includes(w)) score += 3;
    if (bodyLower.includes(w)) score += 1;
  }
  return score;
}

/**
 * Prune `fullText` (already known to be `rel`'s content) to a skeleton (every symbol's
 * name/kind/line) plus as many full symbol bodies — ranked by relevance to `queryText` — as fit
 * in `tokenBudget`. Falls back to a head-of-file slice when the language/file has no extractable
 * symbols (extract() returns [] for `unknown` languages).
 */
export function pruneFileForPrompt(
  rel: string,
  fullText: string,
  queryText: string,
  tokenBudget = DEFAULT_TOKEN_BUDGET,
): PrunedResult {
  const { symbols } = extract(rel, fullText);
  const lines = fullText.split('\n');

  if (symbols.length === 0) {
    const charBudget = tokenBudget * 4;
    const truncated = fullText.length > charBudget;
    return {
      text: truncated ? fullText.slice(0, charBudget) : fullText,
      truncated,
      includedSymbols: 0,
      totalSymbols: 0,
    };
  }

  const chunks = buildChunks(lines.length, symbols);
  const queryWords = queryText.toLowerCase().split(/\W+/).filter((w) => w.length > 1);

  const headerEnd = chunks[0].startLine - 1;
  const header = headerEnd > 0 ? lines.slice(0, headerEnd).join('\n') : '';
  const skeleton = chunks.map((c) => `// ${c.name} (${c.kind}) — line ${c.startLine}`).join('\n');

  const scored = chunks
    .map((chunk) => ({ chunk, body: lines.slice(chunk.startLine - 1, chunk.endLine).join('\n') }))
    .map((c) => ({ ...c, score: scoreChunk(c.chunk.name, c.body, queryWords) }))
    .sort((a, b) => b.score - a.score);

  let used = estimateTokens(header) + estimateTokens(skeleton);
  const included: typeof scored = [];
  for (const item of scored) {
    const cost = estimateTokens(item.body);
    if (used + cost > tokenBudget) continue; // doesn't fit — try the next (lower-scored) chunk
    used += cost;
    included.push(item);
  }
  included.sort((a, b) => a.chunk.startLine - b.chunk.startLine);

  const parts = [
    header && `// imports/top-of-file\n${header}`,
    `// symbol skeleton (${chunks.length} symbols; ${included.length} shown in full below)\n${skeleton}`,
    ...included.map((i) => `// ${i.chunk.name} (${i.chunk.kind}) — lines ${i.chunk.startLine}-${i.chunk.endLine}\n${i.body}`),
  ].filter(Boolean) as string[];

  return {
    text: parts.join('\n\n'),
    truncated: included.length < chunks.length,
    includedSymbols: included.length,
    totalSymbols: chunks.length,
  };
}
