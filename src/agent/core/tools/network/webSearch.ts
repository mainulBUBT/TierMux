import { tool } from 'ai';
import { z } from 'zod';
import { capToolOutput } from '../capOutput';
import { collectWebSearchResults, formatWebSearchResults } from './freeweb/search';

const MAX_CHARS = 8_000;
const MAX_RESULTS = 8;

/**
 * webSearch — searches the public web without API keys.
 *
 * Backed by the freeweb engine: tries Yahoo / DuckDuckGo / Marginalia / Ask in
 * order via native fetch() and stops once enough results are found. Returns
 * deduplicated, ranked results with clean URLs. The added optional args
 * (`engine`, `maxResults`, `domain`) all default; a bare `webSearch({ query })`
 * call behaves as before — only the result quality improves over the old
 * single-engine DDG scrape.
 */
export function createWebSearchTool() {
  return tool({
    description:
      'Search the web for up-to-date information (news, docs, general knowledge). Returns a list of result titles, URLs, and snippets. Use fetchUrl to read the full content of a promising result. '
      + "CAUTION: many indexed pages are SEO preview/evergreen articles written BEFORE an event, phrased in present/future tense (\"kicks off today\", \"is scheduled for\") even though that date has since passed relative to today. Before answering, compare each result's date against today's actual date (given in your system prompt) and state events as past/completed when they are — do not repeat a snippet's tense verbatim without checking it first.",
    inputSchema: z.object({
      query: z.string().min(1).describe('The search query.'),
      engine: z
        .enum(['auto', 'yahoo', 'duckduckgo', 'marginalia', 'ask'])
        .optional()
        .describe('Pin a specific engine. Defaults to auto (tries them in order).'),
      maxResults: z.number().int().min(1).max(MAX_RESULTS).optional().describe('Max results to return (default 5).'),
      domain: z
        .string()
        .optional()
        .describe('Optional domain filter, e.g. react.dev or github.com (adds a site: clause).'),
    }),
    execute: async ({
      query,
      engine,
      maxResults,
      domain,
    }: {
      query: string;
      engine?: 'auto' | 'yahoo' | 'duckduckgo' | 'marginalia' | 'ask';
      maxResults?: number;
      domain?: string;
    }) => {
      try {
        const limit = maxResults ?? 5;
        const { results, attempts } = await collectWebSearchResults(
          query,
          engine ?? 'auto',
          domain && domain.trim() ? domain : undefined,
          limit,
        );

        if (results.length === 0) {
          const tried = attempts.map((a) => a.engine).join(', ') || 'none';
          return `No web results found for "${query}". Engines tried: ${tried}.`;
        }

        const formatted = formatWebSearchResults(query, results, attempts, limit, domain);
        return capToolOutput(formatted, MAX_CHARS, 'Search results truncated.');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Web search failed for "${query}": ${msg}`);
      }
    },
  });
}
