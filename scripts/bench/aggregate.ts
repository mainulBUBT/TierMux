/* Compute summary stats from QueryResult[].
 *
 * Percentiles use the nearest-rank method. p95/p99 are marked with -1 when
 * there are fewer than MIN_PERCENTILE_SAMPLE samples (mirrors the profiler's
 * convention — small samples give misleading tails).
 */
import type { BenchSummary, PerModelStat, Percentiles, QueryResult } from './types';

const MIN_PERCENTILE_SAMPLE = 20;

function sortedNumbers(xs: number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

/** Nearest-rank percentile. Returns -1 if too few samples for p>50. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (p > 50 && sorted.length < MIN_PERCENTILE_SAMPLE) return -1;
  if (sorted.length === 1) return sorted[0];
  // Nearest-rank: ceil(p/100 * N)-th element (1-indexed).
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)];
}

function summarize(nums: number[]): Percentiles {
  const sorted = sortedNumbers(nums);
  const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    avg,
  };
}

export function summarizeResults(results: QueryResult[]): BenchSummary {
  const total = results.length;
  const succeededResults = results.filter((r) => r.ok);
  const succeeded = succeededResults.length;
  const failed = total - succeeded;

  const latencies = succeededResults.map((r) => r.latencyMs);
  const ttfts = succeededResults.map((r) => r.ttftMs).filter((v): v is number => v != null);

  const totalPrompt = succeededResults.reduce((s, r) => s + (r.tokens?.prompt ?? 0), 0);
  const totalCompletion = succeededResults.reduce((s, r) => s + (r.tokens?.completion ?? 0), 0);

  const failoverTurns = results.filter((r) => r.failovers.length > 0).length;

  // Per-model breakdown across successful turns only (failures have no selectedModel).
  const byModel = new Map<string, { count: number; latencySum: number }>();
  for (const r of succeededResults) {
    if (!r.selectedModel) continue;
    const cur = byModel.get(r.selectedModel) ?? { count: 0, latencySum: 0 };
    cur.count += 1;
    cur.latencySum += r.latencyMs;
    byModel.set(r.selectedModel, cur);
  }
  const perModel: PerModelStat[] = [...byModel.entries()]
    .map(([model, v]) => ({
      model,
      count: v.count,
      avgLatencyMs: v.count ? Math.round(v.latencySum / v.count) : 0,
      successRate: 0, // filled below: successes / total turns routed to this model
    }))
    .sort((a, b) => b.count - a.count);

  // successRate per model: successes / (successes + failed attempts targeting it).
  // Use attempts[] across ALL results (ok and fail) to get the real denominator.
  const attemptsByModel = new Map<string, { ok: number; total: number }>();
  for (const r of results) {
    for (const a of r.attempts) {
      const key = `${a.platform}::${a.model}`;
      const cur = attemptsByModel.get(key) ?? { ok: 0, total: 0 };
      cur.total += 1;
      if (a.status === 'ok') cur.ok += 1;
      attemptsByModel.set(key, cur);
    }
  }
  for (const m of perModel) {
    const a = attemptsByModel.get(m.model);
    m.successRate = a && a.total ? a.ok / a.total : 1;
  }

  return {
    total,
    succeeded,
    failed,
    successRate: total ? succeeded / total : 0,
    latency: summarize(latencies),
    ttft: summarize(ttfts),
    tokens: { totalPrompt, totalCompletion },
    failoverRate: total ? failoverTurns / total : 0,
    perModel,
  };
}

/* ---------- helpers used by compare.ts ---------- */

export { percentile, summarize };

/** Pretty-print a number of ms, blank for -1 (too-few-samples sentinel). */
export function fmtMs(ms: number): string {
  return ms < 0 ? '   —   ' : `${Math.round(ms).toString().padStart(6)} ms`;
}
