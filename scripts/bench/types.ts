/* Result schema for the benchmark harness.
 *
 * One BenchRun == one full pass over the 50-query dataset (or a filtered slice).
 * Written as JSON to .benchmarks/<runId>.json and consumed by compare.ts.
 */

export type Category = 'explain' | 'bugfix' | 'feature' | 'refactor' | 'followup';

/** A single parsed query from docs/BENCHMARK_QUERIES.md. */
export interface BenchQuery {
  id: string;          // "E1" … "C10"
  category: Category;
  query: string;       // verbatim query text
  /** Free-text "Expected retrieval" column (categories 1–4 only; chains have none). */
  expectedRetrieval?: string;
}

/** Per-provider attempt captured via Router's onProviderAttempt callback. */
export interface Attempt {
  platform: string;
  model: string;
  status: 'ok' | 'fail';
  latencyMs: number;
  errorType?: string;
  reason?: string;
}

/** Outcome of running one query through Router.route(). */
export interface QueryResult {
  queryId: string;
  category: Category;
  query: string;
  ok: boolean;
  selectedModel: string;       // "platform::modelId" of the successful hop, or "" on failure
  latencyMs: number;           // wall-clock around the whole route() call
  ttftMs: number | null;       // time to first streamed chunk; null if no streaming / no chunk
  tokens: { prompt: number; completion: number; total: number } | null;
  attempts: Attempt[];
  failovers: { from: string; reason: string }[];
  errorType: string | null;    // router classification (rate_limited/auth/not_found/…) on failure
  errorMessage: string | null; // human-readable error text on failure
}

export interface Percentiles { p50: number; p95: number; p99: number; avg: number; }

export interface PerModelStat {
  model: string;
  count: number;
  avgLatencyMs: number;
  successRate: number; // 0..1
}

export interface BenchSummary {
  total: number;
  succeeded: number;
  failed: number;
  successRate: number;         // 0..1
  latency: Percentiles;        // over successful turns
  ttft: Percentiles;           // over successful turns with non-null ttft
  tokens: { totalPrompt: number; totalCompletion: number };
  failoverRate: number;        // fraction of turns with ≥1 failover
  perModel: PerModelStat[];
}

export interface BenchConfig {
  taskKind: string;
  model: string;               // 'auto' or 'platform::modelId'
  concurrency: number;
  /** Which query ids to run (default: all). Useful for smoke tests. */
  filter?: string[];
  /** Override candidate providers (keyless smoke). */
  platforms?: string[];
}

export interface BenchRun {
  schemaVersion: 1;
  runId: string;
  variant: string;
  gitSha: string;
  timestamp: string;           // ISO
  config: BenchConfig;
  queries: QueryResult[];
  summary: BenchSummary;
}
