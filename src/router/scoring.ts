/**
 * Smart Auto scoring engine.
 *
 *   final_score = CapabilityScore × RuntimeMultiplier × UserPreference
 *
 * Capability and runtime are deliberately independent: a temporarily overloaded
 * frontier model keeps a high CapabilityScore and just gets a low RuntimeMultiplier,
 * so it snaps back to the top the moment it recovers — we never "learn" that a
 * good model is bad, only that it is unhealthy *right now*.
 *
 * All tunables live in {@link SCORING_CONFIG} / {@link TASK_WEIGHTS}. No
 * hardcoded provider names or ms values anywhere.
 */

import type { FallbackEntry } from '../shared/types';
import type { Catalog } from '../catalog/catalog';
import { type TaskKind } from '../agent/routing';
import type { ModelStatsStore } from '../config/modelStats';
import type { MetricsStore } from './metricsStore';
import { SCORING_CONFIG, TASK_WEIGHTS, type FailureType } from './scoringConfig';
import { shrinkageFactor, lerp } from './wilson';

// TODO: CapabilityScore currently derives from orderForTask(), which is a routing
// heuristic, not a model-quality measure. In the future, extract a dedicated
// CapabilityProfile module so routing heuristics and model capability evolve
// independently (offline benchmarks / community rankings / manual overrides).

export type HealthState = 'ok' | 'half-open' | 'bad';

/** Runtime facts the Router already computes per candidate (availability gates). */
export interface CandidateRuntime {
  health: HealthState;
  canSend: boolean; // not rate-cooled
  hasKey: boolean;
  /** True if the model supports capabilities required for this turn (tools/vision). */
  capable: boolean;
  /** Remaining quota against the tightest declared limit [0..1]; 1 when none declared. */
  headroom: number;
  /** Requests this model's provider served in the last minute — normalized in rank(). */
  providerLoad: number;
}

export interface SelectionContext {
  taskKind: TaskKind;
  entries: FallbackEntry[];
  runtime: Map<string, CandidateRuntime>; // key `${platform}::${modelId}`
  requireTools: boolean;
  isVision: boolean;
}

export type SkipReason =
  | 'low-score'
  | 'unhealthy'
  | 'rate-limited'
  | 'no-key'
  | 'missing-tools'
  | 'missing-vision'
  | 'context-too-large';

export interface SignalBreakdown {
  reliability: number;
  health: number;
  availability: number;
  speed: number;
  providerHealth: number;
  headroom: number;
  density: number;
}

export interface RationaleEntry {
  platform: string;
  modelId: string;
  selected: boolean;
  score: number;
  capability: number;
  runtimeMultiplier: number;
  userPreference: number;
  signals: SignalBreakdown;
  confidence: number;
  /** Human-readable "why selected" (winner) or "why not selected" (others). */
  reason: string;
  skip?: SkipReason;
}

export interface RankResult {
  ordered: FallbackEntry[];
  rationale: RationaleEntry[];
}

const rtKey = (platform: string, modelId: string): string => `${platform}::${modelId}`;

export class ScoringEngine {
  constructor(
    private readonly catalog: Catalog,
    private readonly metrics: MetricsStore,
    private readonly stats?: ModelStatsStore,
  ) {}

  rank(ctx: SelectionContext, rng: () => number = Math.random): RankResult {
    const { taskKind, entries } = ctx;

    // ---- CapabilityScore: magnitude-derived, min-max normalized across candidates ----
    // (Ordinal rank-position was too dominant: two models with identical catalog fitness
    //  got 1.0 vs 0.3 from arbitrary input order, swamping runtime/confidence. Magnitude
    //  normalization gives tied models equal capability so runtime decides between them.)
    // TODO: extract a dedicated CapabilityProfile so this stops duplicating orderForTask's
    // per-kind emphasis (see plan Future section).
    const capRaw = new Map<string, number>();
    let capMin = Infinity;
    let capMax = -Infinity;
    for (const e of entries) {
      const m = this.catalog.find(e.platform, e.modelId);
      const raw = m ? capabilityRaw(taskKind, m) : 1e9; // unknown → worst
      capRaw.set(rtKey(e.platform, e.modelId), raw);
      if (raw < capMin) capMin = raw;
      if (raw > capMax) capMax = raw;
    }

    // ---- Precompute the busiest provider in this pool (for the density signal) ----
    // Relative, not absolute: penalizing "more than N requests/min" would need a hardcoded
    // rate that's wrong for every provider. Normalizing against the busiest peer means the
    // signal is neutral when load is even and only bites when one provider is carrying the pool.
    let maxLoad = 0;
    for (const e of entries) {
      maxLoad = Math.max(maxLoad, ctx.runtime.get(rtKey(e.platform, e.modelId))?.providerLoad ?? 0);
    }

    // ---- Precompute the fastest peer TTFT (for the balance rule) ----
    let minPeerTtft = Infinity;
    const ttfts = new Map<string, number>();
    for (const e of entries) {
      const k = rtKey(e.platform, e.modelId);
      const agg = this.metrics.modelAgg(e.platform, e.modelId, taskKind);
      const ttft = this.metrics.ttftRecent(agg) || Infinity;
      ttfts.set(k, ttft);
      if (this.metrics.sampleCount(agg) >= SCORING_CONFIG.minSamples && ttft < minPeerTtft) {
        minPeerTtft = ttft;
      }
    }

    // ---- Score every candidate ----
    const scored = entries.map((e) => {
      const k = rtKey(e.platform, e.modelId);
      const m = this.catalog.find(e.platform, e.modelId);
      const rt = ctx.runtime.get(k);
      const agg = this.metrics.modelAgg(e.platform, e.modelId, taskKind);
      const provAgg = this.metrics.providerAgg(e.platform);
      const n = this.metrics.sampleCount(agg);
      const conf = shrinkageFactor(n, SCORING_CONFIG.shrinkageK); // 0 cold → 1 mature
      const w = TASK_WEIGHTS[taskKind];

      // Capability: min-max normalized magnitude (lower raw = better) → [0.5, 1.0].
      const raw = capRaw.get(k) ?? capMax;
      const norm = capMax > capMin ? (capMax - raw) / (capMax - capMin) : 1;
      const capability = m ? 0.5 + 0.5 * norm : 0.4;

      // ---- Runtime signals, each shrunk toward neutral (1.0) by confidence ----
      const reliabilityRaw = Math.min(SCORING_CONFIG.reliabilityCap, this.metrics.successRate(agg));
      const reliability = lerp(1, reliabilityRaw, conf);

      const healthRaw = rt ? (rt.health === 'ok' ? 1 : rt.health === 'half-open' ? 0.3 : 0.02) : 1;
      const health = lerp(1, healthRaw, Math.max(conf, rt ? 0.5 : 0)); // health is fairly trustworthy

      const availRaw = rt ? (rt.canSend && rt.hasKey ? 1 : 0.05) : 1;
      const availability = lerp(1, availRaw, rt ? 0.9 : 0);

      // Speed: TTFT-dominant, vs own baseline AND fastest peer; drift-aware.
      const speed = this.speedSignal(k, agg, ttfts.get(k) ?? Infinity, minPeerTtft, w.ttftShare, conf);

      const provSuccess = this.metrics.successRate(provAgg);
      const provConf = shrinkageFactor(this.metrics.sampleCount(provAgg), SCORING_CONFIG.shrinkageK);
      const providerHealth = lerp(1, provSuccess, provConf);

      // Quota headroom → bounded multiplier. Floored (not zeroed) on purpose: exhaustion is
      // `canSend`'s job via availability, and double-punishing it here would drop a merely
      // busy model below models that are outright broken.
      const headroomRaw = rt?.headroom ?? 1;
      const headroom = SCORING_CONFIG.headroomFloor + (1 - SCORING_CONFIG.headroomFloor) * headroomRaw;

      // Load spreading, relative to the busiest provider in this pool.
      const loadShare = maxLoad > 0 ? (rt?.providerLoad ?? 0) / maxLoad : 0;
      const density = 1 - SCORING_CONFIG.densityPenalty * loadShare;

      const signals: SignalBreakdown = { reliability, health, availability, speed, providerHealth, headroom, density };

      // RuntimeMultiplier = structural geo(health, availability, speed) × reliability^pow × providerHealth^pow.
      // Reliability and provider health are direct multipliers (not soft geo members) so a
      // 20%-success gateway collapses decisively — "excellent model, temporarily unhealthy".
      const structWeights = [w.health, w.availability, w.speed, w.headroom, w.density];
      const structVals = [health, availability, speed, headroom, density];
      const structSum = structWeights.reduce((a, b) => a + b, 0) || 1;
      let structLog = 0;
      for (let i = 0; i < structVals.length; i++) structLog += (structWeights[i] / structSum) * Math.log(Math.max(1e-6, structVals[i]));
      const structural = Math.exp(structLog);
      const runtimeMultiplier =
        structural *
        Math.pow(Math.max(1e-6, reliability), SCORING_CONFIG.reliabilityPow) *
        Math.pow(Math.max(1e-6, providerHealth), SCORING_CONFIG.providerHealthPow);

      // UserPreference: net 👍/👎 mapped to a bounded multiplier around 1.0.
      const net = this.stats ? this.stats.score(taskKind, e.platform, e.modelId) : 0;
      const userPreference = clamp(1 + Math.tanh(net / 3) * 0.3, 0.7, 1.3);

      let score = capability * runtimeMultiplier * userPreference;

      // Hard availability/capability gates → these are skip reasons, not just score.
      let skip: SkipReason | undefined;
      let reasonNote = '';
      if (rt) {
        if (rt.health === 'bad') { skip = 'unhealthy'; score = 0; reasonNote = `circuit open (health ${healthRaw})`; }
        else if (!rt.hasKey) { skip = 'no-key'; score = 0; reasonNote = 'no API key'; }
        else if (!rt.canSend) { skip = 'rate-limited'; score *= 0.05; reasonNote = `rate-cooled (${(this.metrics.rateLimitFrequency(agg) * 100).toFixed(0)}% 429)`; }
        else if (!rt.capable) {
          if (ctx.isVision) { skip = 'missing-vision'; score = 0; reasonNote = 'no vision support'; }
          else if (ctx.requireTools) { skip = 'missing-tools'; score = 0; reasonNote = 'no tool support'; }
        }
      }

      // Balance-rule backstop: a model TTFT-floor slower than the fastest peer can't
      // outrank a reliable-enough faster model regardless of its reliability edge.
      const peerTtft = ttfts.get(k) ?? Infinity;
      if (
        !skip &&
        isFinite(minPeerTtft) &&
        peerTtft > minPeerTtft * SCORING_CONFIG.speedFloorRatio &&
        reliabilityRaw >= SCORING_CONFIG.reliabilityCap * 0.9 // only shield a reliable fast peer
      ) {
        score *= 0.5;
        reasonNote = `TTFT ${(peerTtft / minPeerTtft).toFixed(1)}× the fastest peer`;
      }

      // Drift note for the rationale.
      if (this.metrics.drifting(agg) && !reasonNote) {
        reasonNote = `TTFT drifting above baseline`;
      }

      return { e, k, m, score, capability, runtimeMultiplier, userPreference, signals, conf, skip, reasonNote, reliabilityRaw };
    });

    // ---- Order by score desc ----
    const sorted = [...scored].sort((a, b) => b.score - a.score);

    // ---- Margin-gated exploration: promote a random statistically-tied candidate. ----
    // Deliberately spans the whole tied band rather than just index 1. Swapping only the
    // top-2 made every model at rank 3+ unreachable *by construction* — with a 91-model
    // catalog that permanently exercised two entries per task kind while the rest of the
    // free-tier quota sat idle and unmeasured (a model that never runs never earns the
    // samples that would let it rank). Gated candidates can't be explored into: `skip`
    // covers unhealthy/no-key/missing-capability, and the rate-limited 0.05× demotion
    // drops a model far outside any sane margin.
    if (sorted.length >= 2 && rng() < SCORING_CONFIG.explorationRate) {
      const top = sorted[0].score;
      if (top > 0) {
        // Collect eligible indices, stepping *over* gated candidates rather than stopping at
        // them — a single unhealthy model at index 1 must not hide the healthy peers behind it.
        const band: number[] = [];
        for (let i = 1; i < sorted.length; i++) {
          if ((top - sorted[i].score) / top > SCORING_CONFIG.explorationMargin) break;
          if (!sorted[i].skip) band.push(i);
        }
        if (band.length > 0) {
          const [chosen] = sorted.splice(band[Math.floor(rng() * band.length)], 1);
          sorted.unshift(chosen);
        }
      }
    }

    const ordered = sorted.map((s) => s.e);

    // ---- Build rationale for every candidate ----
    const winnerKey = sorted[0]?.k;
    const rationale: RationaleEntry[] = sorted.map((s) => {
      const selected = s.k === winnerKey && !s.skip;
      const dominant = this.dominantFactor(s);
      let reason: string;
      if (selected) {
        reason = `Selected — capability ${s.capability.toFixed(2)} · runtime ×${s.runtimeMultiplier.toFixed(2)} · ${dominant}`;
      } else if (s.reasonNote) {
        reason = `Not selected: ${s.reasonNote}`;
      } else {
        reason = `Not selected: ${dominant}`;
      }
      return {
        platform: s.e.platform,
        modelId: s.e.modelId,
        selected,
        score: s.score,
        capability: s.capability,
        runtimeMultiplier: s.runtimeMultiplier,
        userPreference: s.userPreference,
        signals: s.signals,
        confidence: s.conf,
        reason,
        skip: s.skip,
      };
    });

    return { ordered, rationale };
  }

  /** TTFT-dominant speed signal in [0,1], vs own baseline + fastest peer. */
  private speedSignal(
    _k: string,
    agg: ReturnType<MetricsStore['modelAgg']>,
    peerTtft: number,
    minPeerTtft: number,
    ttftShare: number,
    conf: number,
  ): number {
    if (!agg || this.metrics.sampleCount(agg) < SCORING_CONFIG.minSamples) {
      return lerp(1, 0.8, conf); // unsampled → near-neutral, slight optimism
    }
    const base = this.metrics.ttftBaseline(agg) || this.metrics.totalBaseline(agg) || 1;
    const recentTtft = this.metrics.ttftRecent(agg);
    const recentTotal = this.metrics.totalRecent(agg);

    // Penalty vs own history (1.0 = at baseline). Spikes above driftMultiplier hurt more.
    const ownRatioTtft = recentTtft / Math.max(1, base);
    const ownRatioTotal = recentTotal / Math.max(1, this.metrics.totalBaseline(agg) || base);
    const ownRatio = ttftShare * ownRatioTtft + (1 - ttftShare) * ownRatioTotal;

    // Penalty vs fastest peer.
    const peerRatio = isFinite(minPeerTtft) && minPeerTtft > 0 ? peerTtft / minPeerTtft : 1;

    const penalty = Math.max(ownRatio, peerRatio);
    // Map ratio → [0,1]: ratio 1 → ~0.9, ratio 3 → ~0.3, ratio 8+ → near floor.
    const raw = 1 / (1 + Math.max(0, penalty - 1) * 0.9);
    return lerp(1, clamp(raw, 0.05, 1), conf);
  }

  /** One-line dominant-factor summary for the rationale. */
  private dominantFactor(s: {
    signals: SignalBreakdown;
    reliabilityRaw: number;
    capability: number;
    runtimeMultiplier: number;
    conf: number;
  }): string {
    const sig = s.signals;
    const entries: Array<[string, number]> = [
      ['reliability', sig.reliability],
      ['health', sig.health],
      ['availability', sig.availability],
      ['speed', sig.speed],
      ['providerHealth', sig.providerHealth],
    ];
    entries.sort((a, b) => a[1] - b[1]); // weakest signal first = the thing dragging it down
    const [name, val] = entries[0];
    const confTag = s.conf < 0.3 ? ' (low confidence, cold)' : '';
    return `${name} ${val.toFixed(2)}${confTag}`;
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Per-task catalog-fitness raw score (lower = better). Mirrors orderForTask's per-kind
 * emphasis using catalog MAGNITUDES (ranks, tags, context) — not ordinal position — so
 * tied models get equal capability and runtime can decide between them.
 */
function capabilityRaw(kind: TaskKind, m: CatalogModelLike): number {
  const intel = m.intelligenceRank;
  const speed = m.speedRank;
  const tools = m.supportsTools ? 0 : 2; // tool-less penalty
  const coding = (m.tags ?? []).includes('coding') ? 0 : 1;
  const reason = m.supportsReasoning ? 0 : 1;
  const ctx = m.contextWindow ?? 32768;
  switch (kind) {
    case 'trivial': return speed;
    case 'chat': return speed + intel * 0.5 + tools;
    case 'coding': return intel + coding + tools + speed * 0.3;
    case 'debug': return intel + coding + tools + reason + speed * 0.3;
    case 'agent': return intel + tools + coding * 0.5 + speed * 0.3;
    case 'plan': return intel + reason + speed * 0.4;
    case 'longContext': return -ctx; // bigger window = lower(raw better)
    case 'vision': {
      if (!m.supportsVision) return 1e6; // hard-exclude text-only models from vision turns
      // Curated "Frontier" preference (cf. Kilo Code's Auto Frontier): among vision-capable
      // models, comprehension tracks raw INTELLIGENCE — weight it heavily so a merely-fast,
      // weak model (e.g. a small VLM) can't monopolize vision on speed. Aggregator 'router'
      // endpoints claim vision but delegate to arbitrary, often text-only models that drop
      // the image — demote them below any direct vision model.
      const aggregator = (m.tags ?? []).includes('router') ? 4 : 0;
      return aggregator + intel * 1.5 + speed * 0.1;
    }
    default: return intel + speed;
  }
}

type CatalogModelLike = {
  intelligenceRank: number;
  speedRank: number;
  contextWindow: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  tags?: string[];
};

/** Re-export for callers that classify errors into FailureType. */
export type { FailureType };
