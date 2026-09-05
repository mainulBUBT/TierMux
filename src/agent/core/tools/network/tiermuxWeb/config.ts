/** Central tuning knobs for the web engine — change values here, not as scattered magic numbers.
 *  The engine owns its own LRU cache (cache.ts) by design; TierMux has no shared one. */
export interface TierMuxWebConfig {
  /** Engines tried, in order, when the caller doesn't pin one. */
  defaultSearchEngines: string[];
  /** Per-fetch timeout (ms) for the content fetcher chain. */
  fetchTimeout: number;
  /** Per-fetch timeout (ms) for search-engine result pages. */
  searchTimeout: number;
  /** User-Agent sent on outbound HTTP requests. */
  userAgent: string;
  /** Max entries retained in the fetch-result LRU cache. */
  cacheMaxEntries: number;
  /** LRU cache entry TTL (ms). */
  cacheTTL: number;
}

export const TIERMUXWEB_CONFIG: TierMuxWebConfig = {
  defaultSearchEngines: ['duckduckgo', 'yahoo', 'marginalia', 'ask'],
  fetchTimeout: 8000,
  searchTimeout: 8000,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  cacheMaxEntries: 300,
  cacheTTL: 20 * 60 * 1000,
};
