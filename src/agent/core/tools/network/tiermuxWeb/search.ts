import type { WebSearchResult, SearchCollection, SearchAttempt, WebSearchMode } from "./types";
import { getWebSearchOrder, normalizeDomainFilter } from "./url";
import { normalizeEngineResults, mergeSearchResults, formatAttemptSummary } from "./scoring";
import { formatDateForDisplay } from "./dates";
import { getProvider } from "./providers";

function buildEffectiveQuery(query: string, domain?: string): string {
  const normalizedDomain = normalizeDomainFilter(domain);
  return normalizedDomain && !query.includes("site:") ? `site:${normalizedDomain} ${query}` : query;
}

function mergeAndRank(
  merged: Map<string, WebSearchResult>,
  normalized: WebSearchResult[],
): WebSearchResult[] {
  for (const result of normalized) {
    merged.set(result.url, mergeSearchResults(merged.get(result.url), result));
  }
  return [...merged.values()].sort((a, b) => b.score - a.score);
}

export async function collectWebSearchResults(
  query: string,
  engine: WebSearchMode,
  domain?: string,
  maxResults = 5,
  maxAgeMonths = 18,
): Promise<SearchCollection> {
  const attempts: SearchAttempt[] = [];
  const merged = new Map<string, WebSearchResult>();
  const effectiveQuery = buildEffectiveQuery(query, domain);

  // Native fetch() only. No browser fallback if an engine blocks the request.
  for (const currentEngine of getWebSearchOrder(engine)) {
    const provider = getProvider(currentEngine);
    let rawResults: { title: string; url: string; snippet: string }[] = [];

    if (provider) {
      rawResults = await provider.fetch(effectiveQuery);
    }

    if (rawResults.length === 0) {
      attempts.push({ engine: currentEngine as "yahoo" | "marginalia" | "ask" | "duckduckgo", status: "empty" });
      continue;
    }

    const normalized = normalizeEngineResults(query, rawResults, currentEngine as "yahoo" | "marginalia" | "ask" | "duckduckgo", domain, maxAgeMonths);
    if (normalized.length === 0) {
      attempts.push({ engine: currentEngine as "yahoo" | "marginalia" | "ask" | "duckduckgo", status: "empty" });
      continue;
    }

    attempts.push({ engine: currentEngine as "yahoo" | "marginalia" | "ask" | "duckduckgo", status: "ok", count: normalized.length });
    const ranked = mergeAndRank(merged, normalized);
    if (engine !== "auto") return { results: ranked, attempts };
    if (ranked.length >= maxResults) return { results: ranked, attempts };
  }

  return { results: [...merged.values()].sort((a, b) => b.score - a.score), attempts };
}

export function formatWebSearchResults(query: string, results: WebSearchResult[], attempts: SearchAttempt[], maxResults: number, domain?: string): string {
  const limited = results.slice(0, maxResults);
  const formatted = limited.map((result, index) => {
    let line = `[${index + 1}] ${result.title}`;
    line += `\n    URL: ${result.url}`;
    line += `\n    Source: ${result.engine}${result.llms ? " 🤖 LLMS.txt" : ""}`;
    if (result.publishedDate) {
      line += `\n    📅 ${formatDateForDisplay(result.publishedDate)}`;
      if (result.freshnessWarning) line += ` ${result.freshnessWarning}`;
    }
    if (result.snippet) line += `\n    ${result.snippet.slice(0, 260)}`;
    return line;
  }).join("\n\n");

  let header = `# Web Search: "${query}"`;
  if (domain) header += `\nDomain: ${normalizeDomainFilter(domain)}`;
  header += `\nResults: ${limited.length} of ${results.length}`;
  if (attempts.length > 0) header += `\nEngines: ${formatAttemptSummary(attempts)}`;

  return `${header}\n\n${formatted}`;
}
