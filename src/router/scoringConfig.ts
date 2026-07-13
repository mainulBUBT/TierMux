/**
 * Central configuration for the Smart Auto scoring engine.
 *
 * Every tunable constant lives here — window sizes, EWMA alphas, Wilson z,
 * exploration margin, drift multiplier, speed-floor ratio, confidence curve,
 * provider-multiplier curve, half-life, per-failure-type severities, and
 * per-task signal weights. Routing logic in {@link ScoringEngine} /
 * {@link MetricsStore} reads these names; tuning never requires editing logic.
 *
 * (Future: surface a subset of these as `tiermux.scoring.*` settings.)
 */

import type { TaskKind } from '../agent/routing';

/** How a request failed. Drives reliability/availability/capability weighting differently. */
export type FailureType =
  | 'timeout'
  | 'connection_refused'
  | 'http_429'
  | 'http_5xx'
  | 'tool_unsupported'
  | 'context_too_large'
  | 'bad_request'
  | 'other';

export const FAILURE_TYPES: FailureType[] = [
  'timeout',
  'connection_refused',
  'http_429',
  'http_5xx',
  'tool_unsupported',
  'context_too_large',
  'bad_request',
  'other',
];

export interface ScoringConfig {
  /** Wilson z-score (1.96 ≈ 95% confidence). */
  wilsonZ: number;
  /** Minimum samples before a runtime signal is trusted at all (below → prior). */
  minSamples: number;
  /** Shrinkage curve param k — confidence = n/(n+k). Higher → slower to trust. */
  shrinkageK: number;

  /** Long-window EWMA alpha (baseline). Smaller → more stable. */
  ewmaAlphaLong: number;
  /** Fast-window EWMA alpha (drift detection). Larger → reacts faster. */
  ewmaAlphaFast: number;
  /** Wall-clock half-life for decaying counts (ms). Older samples lose influence. */
  halfLifeMs: number;
  /** Drop a key entirely when its decayed n falls below this. */
  pruneFloorN: number;
  /** Drop a key whose last sample is older than this (ms). */
  pruneTtlMs: number;

  /** Multiplier flagging time-of-day drift: fast > slow × drift → penalty. */
  driftMultiplier: number;
  /** A model whose TTFT exceeds best-available TTFT × this cannot beat a fast-enough model. */
  speedFloorRatio: number;
  /** Cap on how much the reliability signal can lift a model (balance rule). */
  reliabilityCap: number;
  /** Exploration fires only when top-2 scores are within this fraction. */
  explorationMargin: number;
  /** Exponent on the reliability multiplier — how hard low success rate bites. */
  reliabilityPow: number;
  /** Exponent on the provider-health multiplier — how hard a sick gateway bites all its models. */
  providerHealthPow: number;

  /** Per-{@link FailureType} reliability severity in [0,1] (1 = worst). */
  failureSeverity: Record<FailureType, number>;
  /** Which failure types are capability exclusions (not general unreliability). */
  capabilityExclusions: FailureType[];
}

export const SCORING_CONFIG: ScoringConfig = {
  wilsonZ: 1.96,
  minSamples: 3,
  shrinkageK: 8,

  ewmaAlphaLong: 0.15,
  ewmaAlphaFast: 0.45,
  halfLifeMs: 10 * 60_000,
  pruneFloorN: 0.5,
  pruneTtlMs: 24 * 60 * 60_000,

  driftMultiplier: 1.75,
  speedFloorRatio: 3.0,
  reliabilityCap: 0.92,
  explorationMargin: 0.05,
  reliabilityPow: 1.5,
  providerHealthPow: 1.5,

  failureSeverity: {
    timeout: 1.0,
    connection_refused: 1.0,
    http_5xx: 0.9,
    http_429: 0.1, // throttling, not breakage → feeds availability, barely dents reliability
    tool_unsupported: 0.0, // capability exclusion, handled separately
    context_too_large: 0.0, // capability exclusion for big-context turns
    bad_request: 0.25,
    other: 0.5,
  },
  capabilityExclusions: ['tool_unsupported', 'context_too_large'],
};

/**
 * Per-task weights for the runtime multiplier signals. Each profile is
 * normalized internally; only the relative shape matters.
 *
 * No provider names, no hardcoded ms — only signal emphasis per task kind.
 */
export interface TaskWeights {
  reliability: number;
  health: number;
  availability: number;
  speed: number;
  providerHealth: number;
  /** TTFT share within the speed signal (rest is total latency). */
  ttftShare: number;
}

const BASE_WEIGHTS: TaskWeights = {
  reliability: 1,
  health: 1,
  availability: 1,
  speed: 1,
  providerHealth: 1,
  ttftShare: 0.7,
};

export const TASK_WEIGHTS: Record<TaskKind, TaskWeights> = {
  // Interactive, low-stakes → feel fast above all.
  trivial: { ...BASE_WEIGHTS, speed: 2.2, reliability: 0.8, providerHealth: 1.2, ttftShare: 0.85 },
  chat: { ...BASE_WEIGHTS, speed: 1.8, reliability: 1.1, providerHealth: 1.1, ttftShare: 0.8 },
  agent: { ...BASE_WEIGHTS, speed: 1.2, reliability: 1.4, providerHealth: 1.1, ttftShare: 0.7 },
  // Quality-first, but still penalize slowness.
  coding: { ...BASE_WEIGHTS, speed: 0.8, reliability: 1.8, providerHealth: 1.0, ttftShare: 0.6 },
  debug: { ...BASE_WEIGHTS, speed: 0.8, reliability: 1.8, providerHealth: 1.0, ttftShare: 0.6 },
  plan: { ...BASE_WEIGHTS, speed: 0.7, reliability: 1.6, providerHealth: 1.0, ttftShare: 0.55 },
  // Big context → total latency matters more than TTFT.
  longContext: { ...BASE_WEIGHTS, speed: 0.9, reliability: 1.5, providerHealth: 1.0, ttftShare: 0.4 },
  // Vision → capability-gated; among capable models, prefer healthy+fast.
  vision: { ...BASE_WEIGHTS, speed: 1.0, reliability: 1.3, providerHealth: 1.1, ttftShare: 0.65 },
};
