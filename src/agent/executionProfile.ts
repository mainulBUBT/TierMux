import type { CatalogModel } from '../shared/types';

/**
 * The single resolved decision about HOW this turn should be executed, derived from the
 * model that will actually serve it. Every model-strength-dependent behavior consumes this
 * profile instead of running its own rank check — previously `WEAK_EXECUTOR_RANK`,
 * `isWeakExecutor`, `isStrongExecutor`, the prune-at formula, the max_tokens floor, and the
 * judge cascade each peeked the catalog independently and could drift apart mid-refactor.
 *
 * Resolved once per turn in runTurn (right after taskKind classification) from
 * `router.peekTopSelection(taskKind)?.model`; Router.route() uses the same helpers for its
 * output-limit decision so the loop and the wire never disagree.
 */

/** Rank at/above which an executor counts as "weak" (needs ReAct-style scaffolding). */
export const WEAK_RANK_MIN = 3;
/** Rank at/below which an executor counts as "strong" (parallel tools, no judge, lean prompt). */
export const STRONG_RANK_MAX = 2;
/** Unknown-model rank (custom endpoints not in the catalog) — treated as mid-tier. */
export const UNKNOWN_RANK = 5;
/** Fallback context window when the catalog doesn't declare one. */
export const FALLBACK_CONTEXT_WINDOW = 32_768;

/** Prune target = this fraction of the context window (OpenCode compacts at ~0.90; TierMux
 *  keeps the blank→prune→evict cascade, just triggered far later than the old 0.40 — early
 *  blanking was destroying tool evidence the model still needed). */
export const PRUNE_TARGET_FRACTION = 0.85;
const PRUNE_TARGET_MIN = 12_000;
const PRUNE_TARGET_MAX = 120_000;

export interface ExecutionProfile {
  /** Catalog intelligenceRank (lower = smarter); UNKNOWN_RANK for custom/unknown models. */
  modelRank: number;
  /** rank <= STRONG_RANK_MAX — top-tier executor. */
  strong: boolean;
  /** rank >= WEAK_RANK_MIN — needs weak-model scaffolding (ReAct, weak-prompt sections). */
  weak: boolean;
  /** Declared max output tokens (models.dev-style); null = unknown. */
  outputTokenLimit: number | null;
  /** Resolved context window (never null — fallback applies). */
  contextWindow: number;
  /** Weak-model scaffolding: one-thought-one-action + weak-prompt sections. */
  useWeakModelScaffolding: boolean;
  /** Answer-quality judging (judgeFulfillment/compareAnswers/escalation) — off for strong models. */
  useAnswerJudge: boolean;
  /** Token level at which the per-step prune cascade starts firing. */
  pruneTarget: number;
}

export function resolveExecutionProfile(model: CatalogModel | undefined): ExecutionProfile {
  const modelRank = model?.intelligenceRank ?? UNKNOWN_RANK;
  const contextWindow = model?.contextWindow && model.contextWindow > 0 ? model.contextWindow : FALLBACK_CONTEXT_WINDOW;
  return {
    modelRank,
    strong: modelRank <= STRONG_RANK_MAX,
    weak: modelRank >= WEAK_RANK_MIN,
    outputTokenLimit: model?.outputTokenLimit ?? null,
    contextWindow,
    useWeakModelScaffolding: modelRank >= WEAK_RANK_MIN,
    useAnswerJudge: modelRank > STRONG_RANK_MAX,
    pruneTarget: Math.min(Math.max(Math.floor(contextWindow * PRUNE_TARGET_FRACTION), PRUNE_TARGET_MIN), PRUNE_TARGET_MAX),
  };
}

/**
 * Default output budget for a model (used by Router.route when the caller set none).
 * Floors were raised from the old flat 4096/8192: mid-answer truncation on free tiers was
 * common and the continuation stitcher (up to 4 extra calls) is a quality band-aid. The
 * model's declared cap always wins when lower.
 */
export function defaultMaxOutputTokens(model: CatalogModel | undefined): number {
  const floor = model?.supportsReasoning ? 16_384 : 8_192;
  const cap = model?.outputTokenLimit;
  return cap && cap > 0 ? Math.min(cap, floor) : floor;
}
