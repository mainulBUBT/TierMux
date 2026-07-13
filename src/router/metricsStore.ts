/**
 * Persisted rolling runtime metrics for the Smart Auto scoring engine.
 *
 * Two levels:
 *   - model+task  `${platform}::${modelId}::${taskKind}`
 *   - provider    `${platform}`            (aggregate across all its models/tasks)
 *
 * Storage is **bounded aggregates**, not raw per-request records — compact
 * EWMAs + counters, time-decayed via a half-life, pruned when stale. This
 * keeps globalState growth flat as the catalog scales to hundreds of models.
 *
 * Counts (n, successes, failureCounts, rateLimitedCount) decay exponentially
 * toward zero with {@link ScoringConfig.halfLifeMs}, so old behavior fades.
 * Latency is tracked as two EWMAs (long = baseline, fast = drift detection).
 */

import type * as vscode from 'vscode';
import { FAILURE_TYPES, SCORING_CONFIG, type FailureType } from './scoringConfig';
import { wilsonLowerBound } from './wilson';

const STORE_KEY = 'tiermux.metrics';

export interface MetricSample {
  ok: boolean;
  failureType?: FailureType;
  ttftMs?: number;
  totalMs: number;
  rateLimited: boolean;
}

interface Agg {
  n: number;
  successes: number;
  failureCounts: Record<string, number>;
  rateLimitedCount: number;
  ttftEwma: number;
  totalEwma: number;
  ttftEwmaFast: number;
  totalEwmaFast: number;
  lastTs: number;
}

function emptyAgg(): Agg {
  return {
    n: 0,
    successes: 0,
    failureCounts: {},
    rateLimitedCount: 0,
    ttftEwma: 0,
    totalEwma: 0,
    ttftEwmaFast: 0,
    totalEwmaFast: 0,
    lastTs: 0,
  };
}

export class MetricsStore {
  private map: Record<string, Agg>;

  constructor(private readonly mem: vscode.Memento) {
    this.map = mem.get<Record<string, Agg>>(STORE_KEY, {});
    this.prune();
  }

  private modelKey(platform: string, modelId: string, taskKind: string): string {
    return `${platform}::${modelId}::${taskKind}`;
  }
  private providerKey(platform: string): string {
    return `${platform}`;
  }

  /** Record a request outcome to BOTH the model+task and provider aggregates. */
  record(platform: string, modelId: string, taskKind: string, sample: MetricSample, now = Date.now()): void {
    this.recordKey(this.modelKey(platform, modelId, taskKind), sample, now);
    this.recordKey(this.providerKey(platform), sample, now);
    void this.mem.update(STORE_KEY, this.map);
  }

  private recordKey(key: string, sample: MetricSample, now: number): void {
    const a = this.map[key] ?? emptyAgg();

    // 1. Wall-clock decay of counts toward zero (half-life).
    if (a.lastTs > 0) {
      const decay = Math.exp(-(now - a.lastTs) / SCORING_CONFIG.halfLifeMs);
      a.n *= decay;
      a.successes *= decay;
      a.rateLimitedCount *= decay;
      for (const ft of Object.keys(a.failureCounts)) a.failureCounts[ft] *= decay;
    }

    // 2. Fold in the new observation.
    a.n += 1;
    if (sample.ok) a.successes += 1;
    else if (sample.failureType) a.failureCounts[sample.failureType] = (a.failureCounts[sample.failureType] ?? 0) + 1;
    if (sample.rateLimited) a.rateLimitedCount += 1;

    // 3. EWMA updates (long = baseline, fast = drift).
    const ttft = sample.ttftMs ?? sample.totalMs;
    if (a.lastTs === 0) {
      a.ttftEwma = ttft;
      a.totalEwma = sample.totalMs;
      a.ttftEwmaFast = ttft;
      a.totalEwmaFast = sample.totalMs;
    } else {
      const { ewmaAlphaLong: al, ewmaAlphaFast: af } = SCORING_CONFIG;
      a.ttftEwma = al * ttft + (1 - al) * a.ttftEwma;
      a.totalEwma = al * sample.totalMs + (1 - al) * a.totalEwma;
      a.ttftEwmaFast = af * ttft + (1 - af) * a.ttftEwmaFast;
      a.totalEwmaFast = af * sample.totalMs + (1 - af) * a.totalEwmaFast;
    }
    a.lastTs = now;
    this.map[key] = a;
  }

  /** Drop stale / near-empty keys so dead models don't accumulate. */
  prune(now = Date.now()): void {
    let changed = false;
    for (const k of Object.keys(this.map)) {
      const a = this.map[k];
      if (!a) continue;
      const stale = a.lastTs > 0 && now - a.lastTs > SCORING_CONFIG.pruneTtlMs;
      const thin = a.n < SCORING_CONFIG.pruneFloorN && a.lastTs > 0;
      if (stale || thin) {
        delete this.map[k];
        changed = true;
      }
    }
    if (changed) void this.mem.update(STORE_KEY, this.map);
  }

  // ---- model+task accessors ----

  modelAgg(platform: string, modelId: string, taskKind: string): Agg | undefined {
    return this.map[this.modelKey(platform, modelId, taskKind)];
  }
  providerAgg(platform: string): Agg | undefined {
    return this.map[this.providerKey(platform)];
  }

  /** Wilson lower bound of the success rate (confidence-aware). 0 with no data. */
  successRate(a: Agg | undefined): number {
    if (!a || a.n < 1) return 0;
    return wilsonLowerBound(a.successes, a.n, SCORING_CONFIG.wilsonZ);
  }

  rateLimitFrequency(a: Agg | undefined): number {
    if (!a || a.n < 1) return 0;
    return a.rateLimitedCount / a.n;
  }

  failureRate(a: Agg | undefined, type: FailureType): number {
    if (!a || a.n < 1) return 0;
    return (a.failureCounts[type] ?? 0) / a.n;
  }

  failureBreakdown(a: Agg | undefined): Record<FailureType, number> {
    const out = {} as Record<FailureType, number>;
    for (const ft of FAILURE_TYPES) out[ft] = this.failureRate(a, ft);
    return out;
  }

  sampleCount(a: Agg | undefined): number {
    return a ? a.n : 0;
  }

  /** Is the fast window running materially above the baseline (time-of-day drift)? */
  drifting(a: Agg | undefined): boolean {
    if (!a || a.totalEwma <= 0) return false;
    return a.totalEwmaFast > a.totalEwma * SCORING_CONFIG.driftMultiplier
      || a.ttftEwmaFast > a.ttftEwma * SCORING_CONFIG.driftMultiplier;
  }

  /** Most-recent (fast-window) TTFT estimate; falls back to baseline then 0. */
  ttftRecent(a: Agg | undefined): number {
    if (!a) return 0;
    return a.ttftEwmaFast || a.ttftEwma || 0;
  }
  ttftBaseline(a: Agg | undefined): number {
    return a ? a.ttftEwma || 0 : 0;
  }
  totalRecent(a: Agg | undefined): number {
    if (!a) return 0;
    return a.totalEwmaFast || a.totalEwma || 0;
  }
  totalBaseline(a: Agg | undefined): number {
    return a ? a.totalEwma || 0 : 0;
  }
}
