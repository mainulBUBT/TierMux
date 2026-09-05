import type { LlmsDocument } from "./llms";
import { WEB_SEARCH_ENGINES } from "./constants";

export type WebSearchEngine = typeof WEB_SEARCH_ENGINES[number];
export type WebSearchMode = "auto" | WebSearchEngine;
export type SearchAttemptStatus = "ok" | "blocked" | "empty";

export interface SearchAttempt {
  engine: WebSearchEngine;
  status: SearchAttemptStatus;
  reason?: string;
  count?: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: WebSearchEngine;
  host: string;
  score: number;
  publishedDate?: string;
  freshnessWarning?: string;
  llms?: LlmsDocument | null;
}

export interface SearchCollection {
  results: WebSearchResult[];
  attempts: SearchAttempt[];
}

export interface LlmsRouteDecision {
  requestUrl: string;
  targetUrl: string;
  routed: boolean;
  reason?: string;
}

