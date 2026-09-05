import { tool } from 'ai';
import { z } from 'zod';
import { capToolOutput } from '../capOutput';
import { browseUrl } from './tiermuxWeb/browse';
import { tagExternalContent } from './tiermuxWeb/security';

const MAX_CHARS = 15_000;

/** fetchUrl — a public URL's readable text, via the web engine's static-fetch chain (markdown /
 *  GitHub-raw / RSS / jsdom main-content / archive.org fallback, llms.txt-aware). `query` only
 *  influences llms.txt routing. */
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

        // Tag AFTER capping so the safety notice and closing tag cannot be truncated off. Untagged
        // web text used to sit next to a live runCommand tool with zero framing.
        return tagExternalContent(capToolOutput(parts.join('\n\n'), MAX_CHARS, 'Fetched content truncated.'));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to fetch URL ${url}: ${msg}`);
      }
    },
  });
}
