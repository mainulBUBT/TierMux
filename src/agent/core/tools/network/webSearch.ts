import { tool } from 'ai';
import { z } from 'zod';
import { capToolOutput } from '../capOutput';
import { collectWebSearchResults, formatWebSearchResults } from './tiermuxWeb/search';
import { tagExternalContent } from './tiermuxWeb/security';

const MAX_CHARS = 8_000;
const MAX_RESULTS = 8;

/** webSearch — keyless public web search via the web engine: Yahoo / DuckDuckGo / Marginalia /
 *  Ask in order, stopping once enough results are found; deduplicated, ranked, clean URLs. */
export function createWebSearchTool() {
  return tool({
    description:
      'Search the web for up-to-date information; returns titles, URLs and snippets — use fetchUrl to read a promising result. '
      + 'Call this instead of answering from memory whenever the answer depends on current facts (news, weather, prices, releases, who holds an office): your training data is out of date. '
      + 'Snippets are often written BEFORE an event in present/future tense — compare each result\'s date with today\'s date (in your system prompt) and state past events as past.',
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
        // See fetchUrl.ts: tag after capping so the safety notice survives truncation.
        return tagExternalContent(capToolOutput(formatted, MAX_CHARS, 'Search results truncated.'));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Web search failed for "${query}": ${msg}`);
      }
    },
  });
}
