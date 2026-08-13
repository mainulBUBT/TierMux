import { tool } from 'ai';
import { z } from 'zod';
import { capToolOutput } from '../capOutput';
import { deepSearch } from './tiermuxWeb/deep-search';
import { tagExternalContent } from './tiermuxWeb/security';

const MAX_CHARS = 8_000;

/**
 * deepSearch — searches curated developer sources (GitHub repos, npm packages,
 * MDN docs) via their free JSON APIs. No browser, no keys. Prefer this over
 * webSearch when researching libraries, packages, or APIs.
 */
export function createDeepSearchTool() {
  return tool({
    description:
      'Search curated developer sources directly — GitHub repositories, npm packages, and MDN docs — via their free JSON APIs. Returns ranked results with names, URLs, descriptions, stars/versions, and last-updated dates. Prefer this over webSearch when researching libraries, packages, or APIs.',
    inputSchema: z.object({
      query: z.string().min(1).describe('The search term.'),
      sources: z
        .array(z.enum(['github', 'npm', 'mdn']))
        .optional()
        .describe('Sources to query. Defaults to all three.'),
      maxResultsPerSource: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Max results per source (default 5).'),
    }),
    execute: async ({
      query,
      sources,
      maxResultsPerSource,
    }: {
      query: string;
      sources?: ('github' | 'npm' | 'mdn')[];
      maxResultsPerSource?: number;
    }) => {
      try {
        const items = await deepSearch(
          query,
          sources ?? ['github', 'npm', 'mdn'],
          maxResultsPerSource ?? 5,
        );

        if (items.length === 0) {
          return `No results found for "${query}".`;
        }

        const formatted = items
          .map((r, i) => {
            let line = `${i + 1}. ${r.title} (${r.source})`;
            if (r.meta) line += ` — ${r.meta}`;
            if (r.date) line += `\n   📅 ${new Date(r.date).toLocaleDateString('en-US')}`;
            line += `\n   ${r.url}`;
            if (r.content) line += `\n   ${r.content.slice(0, 220)}`;
            return line;
          })
          .join('\n\n');

        // See fetchUrl.ts: tag after capping so the safety notice survives truncation.
        return tagExternalContent(capToolOutput(`# Deep Search: "${query}"\n${items.length} result(s)\n\n${formatted}`, MAX_CHARS, 'Results truncated.'));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Deep search failed for "${query}": ${msg}`);
      }
    },
  });
}
