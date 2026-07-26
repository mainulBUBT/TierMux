import { tool } from 'ai';
import { z } from 'zod';
import { capToolOutput } from '../capOutput';

const MAX_CHARS = 8_000;
const MAX_RESULTS = 8;

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveResultUrl(rawHref: string): string {
  const href = rawHref.startsWith('//') ? `https:${rawHref}` : rawHref;
  try {
    const parsed = new URL(href, 'https://duckduckgo.com');
    const redirected = parsed.searchParams.get('uddg');
    return redirected ? decodeURIComponent(redirected) : href;
  } catch {
    return href;
  }
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  // DDG's class attribute is multi-valued (e.g. class="links_main links_deep result__body"),
  // so split on the bare class name rather than a literal `class="result__body"` match.
  const blocks = html.split(/class="[^"]*\bresult__body\b[^"]*"/).slice(1);

  for (const block of blocks) {
    if (results.length >= MAX_RESULTS) break;

    const linkMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;

    const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);

    const title = stripTags(linkMatch[2]);
    const url = resolveResultUrl(linkMatch[1]);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : '';

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

export function createWebSearchTool() {
  return tool({
    description: 'Search the web for up-to-date information (news, docs, general knowledge). Returns a list of result titles, URLs, and snippets. Use fetchUrl to read the full content of a promising result. '
      + "CAUTION: many indexed pages are SEO preview/evergreen articles written BEFORE an event, phrased in present/future tense (\"kicks off today\", \"is scheduled for\") even though that date has since passed relative to today. Before answering, compare each result's date against today's actual date (given in your system prompt) and state events as past/completed when they are — do not repeat a snippet's tense verbatim without checking it first.",
    inputSchema: z.object({
      query: z.string().min(1).describe('The search query.'),
    }),
    execute: async ({ query }: { query: string }) => {
      try {
        const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          method: 'POST',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; TierMux-Agent/1.0)',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'text/html,application/xhtml+xml',
          },
          body: `q=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const html = await response.text();
        const results = parseResults(html);

        if (results.length === 0) {
          // DuckDuckGo's genuine zero-result page still says so in plain text. If that phrase
          // is absent, we got a 200 but couldn't parse anything — a blocked/captcha page or a
          // markup change, not an actual empty search. Surface that distinction as an error
          // instead of silently telling the model/user "no results".
          if (/no results/i.test(html)) {
            return 'No results found. Try a different or more specific query.';
          }
          throw new Error('DuckDuckGo returned a page with no recognizable results (likely blocked, rate-limited, or changed markup).');
        }

        const formatted = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
          .join('\n\n');

        return capToolOutput(formatted, MAX_CHARS, 'Search results truncated.');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Web search failed for "${query}": ${msg}`);
      }
    },
  });
}
