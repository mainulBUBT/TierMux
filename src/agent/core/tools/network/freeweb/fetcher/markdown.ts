import type { Fetcher, FetcherResult, FetcherOptions, FetcherSource } from "./types";
import { DEFAULT_FETCHER_OPTIONS, truncateContent } from "./types";
import { findLlmsTxt } from "../llms";
import { findMarkdownVersion } from "../markdown";

export const markdownFetcher: Fetcher = {
  name: "markdown",
  priority: 5,

  canHandle(_url: string, opts?: FetcherOptions): boolean {
    return opts?.followLlmsLinks !== false;
  },

  async fetch(url: string, opts?: FetcherOptions): Promise<FetcherResult | null> {
    const maxContentLength = opts?.maxContentLength ?? DEFAULT_FETCHER_OPTIONS.maxContentLength;
    const start = Date.now();

    const llms = await findLlmsTxt(url);
    if (!llms) return null;

    const md = await findMarkdownVersion(url);
    if (!md) return null;

    const ms = Date.now() - start;
    if (!md.content || md.content.length < 50) return null;

    return {
      url,
      finalUrl: md.sourceUrl,
      title: md.title || "",
      content: truncateContent(md.content, maxContentLength),
      isSpa: false,
      contentSource: "markdown" as FetcherSource,
      fetcherName: "markdown",
      ms,
    };
  },
};
