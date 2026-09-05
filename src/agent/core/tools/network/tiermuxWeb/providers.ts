/** Pluggable web-search providers. Adding an engine is one file: implement SearchProvider, parse
 *  its HTML in search-html.ts, append to `searchProviders`. */
import type { WebSearchEngine } from './types';
import { buildWebSearchUrl } from './url';
import { TIERMUXWEB_CONFIG } from './config';
import { parseYahooHtml, parseMarginaliaHtml, parseAskHtml, parseDdgHtml } from './search-html';
import type { RawSearchResult } from './search-html';

async function fetchHtml(url: string, timeoutMs = TIERMUXWEB_CONFIG.searchTimeout): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': TIERMUXWEB_CONFIG.userAgent },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface SearchProvider {
  name: WebSearchEngine;
  fetch(query: string): Promise<RawSearchResult[]>;
}

const yahoo: SearchProvider = {
  name: 'yahoo',
  async fetch(query) {
    const html = await fetchHtml(buildWebSearchUrl(query, 'yahoo'));
    return html ? parseYahooHtml(html) : [];
  },
};

const marginalia: SearchProvider = {
  name: 'marginalia',
  async fetch(query) {
    const html = await fetchHtml(buildWebSearchUrl(query, 'marginalia'), 10000);
    return html ? parseMarginaliaHtml(html) : [];
  },
};

const ask: SearchProvider = {
  name: 'ask',
  async fetch(query) {
    const html = await fetchHtml(buildWebSearchUrl(query, 'ask'));
    return html ? parseAskHtml(html) : [];
  },
};

const duckduckgo: SearchProvider = {
  name: 'duckduckgo',
  async fetch(query) {
    const html = await fetchHtml(buildWebSearchUrl(query, 'duckduckgo'));
    return html ? parseDdgHtml(html) : [];
  },
};

/** Provider lookup by engine name. */
export const searchProviders: Record<WebSearchEngine, SearchProvider> = {
  yahoo,
  marginalia,
  ask,
  duckduckgo,
};

export function getProvider(engine: WebSearchEngine): SearchProvider | undefined {
  return searchProviders[engine];
}
