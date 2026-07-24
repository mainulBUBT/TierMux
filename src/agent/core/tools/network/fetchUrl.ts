import { tool } from 'ai';
import { z } from 'zod';
import { capToolOutput } from '../capOutput';

const MAX_CHARS = 15_000;

export function createFetchUrlTool() {
  return tool({
    description: 'Fetch the text/markdown content of a public URL (documentation, API spec, web page).',
    inputSchema: z.object({
      url: z.string().url().describe('The full HTTP/HTTPS URL to fetch.'),
    }),
    execute: async ({ url }: { url: string }) => {
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'TierMux-Agent/1.0',
            'Accept': 'text/html,application/xhtml+xml,text/plain,*/*',
          },
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') || '';
        const bodyText = await response.text();

        // Simple HTML-to-text strip for web pages
        let cleanText = bodyText;
        if (contentType.includes('text/html')) {
          cleanText = bodyText
            .replace(/<script\b[^<]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style\b[^<]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        }

        return capToolOutput(cleanText, MAX_CHARS, 'Fetched content truncated.');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to fetch URL ${url}: ${msg}`);
      }
    },
  });
}
