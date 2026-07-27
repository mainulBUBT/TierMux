import { tool } from 'ai';
import { z } from 'zod';
import { capToolOutput } from '../capOutput';
import { browseUrl } from './tiermuxWeb/browse';

const MAX_CHARS = 15_000;

/**
 * fetchUrl — reads a public URL and returns its readable text content.
 *
 * Backed by TierMux's web engine's static-fetch chain: markdown / GitHub-raw /
 * RSS / HTTP+jsdom main-content extraction / archive.org fallback, with
 * llms.txt-aware routing when the site exposes guidance. The `query` arg is
 * strictly optional and only influences llms.txt routing; a bare
 * `fetchUrl({ url })` call behaves exactly as before — only the extraction
 * quality improves over the old regex strip.
 */
export function createFetchUrlTool() {
  return tool({
    description:
      'Fetch the text/markdown content of a public URL (documentation, API spec, web page). Extracts the main readable content rather than raw HTML.',
    inputSchema: z.object({
      url: z.string().url().describe('The full HTTP/HTTPS URL to fetch.'),
      query: z
        .string()
        .optional()
        .describe(
          'Optional intent. If the site exposes an llms.txt, this routes to the most relevant same-site page. Ignored when absent.',
        ),
    }),
    execute: async ({ url, query }: { url: string; query?: string }) => {
      try {
        const result = await browseUrl({
          url,
          query: query && query.trim() ? query : undefined,
          followLlmsLinks: true,
          maxContentLength: MAX_CHARS,
        });

        const parts: string[] = [];
        if (result.title) parts.push(result.title);
        if (result.finalUrl && result.finalUrl !== url) parts.push(`Final URL: ${result.finalUrl}`);
        if (result.dateWarning) parts.push(result.dateWarning);
        parts.push(result.content || '[No readable content extracted — the page may be JavaScript-rendered.]');

        return capToolOutput(parts.join('\n\n'), MAX_CHARS, 'Fetched content truncated.');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to fetch URL ${url}: ${msg}`);
      }
    },
  });
}
