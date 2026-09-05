import type { LlmsDocument } from "./llms";
import type { LlmsRouteDecision } from "./types";
import { resolveLlmsRoute } from "./routing";
import { checkDateFreshness } from "./dates";
import { findLlmsTxt } from "./llms";
import { findMarkdownVersion } from "./markdown";
import { fetchWithChainSoft } from "./fetcher/chain";

// Browse relies on the static-fetch chain (no headless browser). JavaScript-
// rendered SPAs may return partial content; the chain degrades gracefully to
// markdown / archive fallback when the live HTML is a stub.

export interface BrowseOptions {
  url: string;
  query?: string;
  followLlmsLinks?: boolean;
  waitFor?: "domcontentloaded" | "load" | "networkidle";
  staticTimeout?: number;
  detectSpa?: boolean;
  spaTimeout?: number;
  extractLinks?: boolean;
  maxContentLength?: number;
  maxAgeMonths?: number;
}

export interface BrowseResult {
  url: string;
  finalUrl: string;
  title: string;
  content: string;
  date?: string;
  dateWarning: string;
  isFresh: boolean;
  isSpa: boolean;
  llms: LlmsDocument | null;
  markdownUrl?: string;
  contentSource: "html" | "markdown" | "github-raw" | "http-jsdom" | "rss" | "archive-cache";
  fetcherUsed?: string;
  fetcherMs?: number;
  route: LlmsRouteDecision;
  links?: { text: string; href: string }[];
}

export async function browseUrl(options: BrowseOptions): Promise<BrowseResult> {
  const {
    url,
    query,
    followLlmsLinks = true,
    waitFor = "domcontentloaded",
    extractLinks: shouldExtractLinks = false,
    maxContentLength = 15000,
    maxAgeMonths = 24,
  } = options;

  const llms = await findLlmsTxt(url);
  const route = resolveLlmsRoute(url, llms, query, followLlmsLinks);
  const activeUrl = route.targetUrl;

  const chainResult = await fetchWithChainSoft(activeUrl, {
    query,
    maxContentLength,
    maxAgeMonths,
    extractLinks: shouldExtractLinks,
    followLlmsLinks,
    waitFor,
  });

  // Markdown fallback for llms-aware sites when the chain came up empty.
  const markdown = (!chainResult || chainResult.content.length <= 200) && llms
    ? await findMarkdownVersion(activeUrl)
    : null;

  const title = markdown?.title || chainResult?.title || "";
  const text = markdown?.content || chainResult?.content || "";

  let dateWarning = "";
  let isFresh = true;
  const pageDate = chainResult?.date;
  if (pageDate) {
    const dateCheck = checkDateFreshness(pageDate, maxAgeMonths);
    isFresh = dateCheck.isFresh;
    dateWarning = dateCheck.warning;
  }

  return {
    url,
    finalUrl: chainResult?.finalUrl ?? activeUrl,
    title,
    content: text,
    date: pageDate,
    dateWarning,
    isFresh,
    isSpa: chainResult?.isSpa ?? false,
    llms,
    markdownUrl: markdown?.sourceUrl ?? (chainResult?.contentSource === "markdown" ? chainResult.finalUrl : undefined),
    contentSource: markdown ? "markdown" : (chainResult?.contentSource ?? "html"),
    fetcherUsed: chainResult?.fetcherName,
    fetcherMs: chainResult?.ms,
    route,
    links: chainResult?.links,
  } satisfies BrowseResult;
}
