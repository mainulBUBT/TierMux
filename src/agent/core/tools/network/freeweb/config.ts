/**
 * Central tuning knobs for the web engine. Defaults are intentional; change a
 * value here rather than scattering magic numbers across modules.
 *
 * The engine owns its own in-process LRU cache (see cache.ts) — TierMux has no
 * shared cache abstraction, so this stands alone by design, not oversight.
 */
export interface FreeWebConfig {
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

export const FREEWEB_CONFIG: FreeWebConfig = {
  defaultSearchEngines: ['yahoo', 'duckduckgo', 'marginalia', 'ask'],
  fetchTimeout: 8000,
  searchTimeout: 8000,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  cacheMaxEntries: 300,
  cacheTTL: 20 * 60 * 1000,
};
