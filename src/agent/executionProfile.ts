import type { CatalogModel } from '../shared/types';

/** Fallback context window when the catalog doesn't declare one. */
const FALLBACK_CONTEXT_WINDOW = 32_768;
/** Prune target = this fraction of the context window (OpenCode compacts at ~0.90). */
const PRUNE_TARGET_FRACTION = 0.85;
/** Floor/ceiling for the fraction-based target on large windows. On SMALL windows the floor
 *  must NOT apply: max(fraction, 12k) on an 8k-window model yielded a target 1.5× the window,
 *  so pruning could never fire before the provider call overflowed (2026-08-25 live repro). */
const PRUNE_TARGET_MIN = 12_000;
const PRUNE_TARGET_MAX = 120_000;

/** Per-model execution budget, resolved once per step from the model that will serve it. */
export interface ExecutionProfile {
  /** Resolved context window (never null — fallback applies). */
  contextWindow: number;
  /** Token level at which prepareStep compaction starts firing (compact.ts). */
  pruneTarget: number;
}

export function resolveExecutionProfile(model: CatalogModel | undefined): ExecutionProfile {
  const contextWindow = model?.contextWindow && model.contextWindow > 0 ? model.contextWindow : FALLBACK_CONTEXT_WINDOW;
  const fraction = Math.floor(contextWindow * PRUNE_TARGET_FRACTION);
  const floored = fraction < PRUNE_TARGET_MIN ? fraction : Math.max(fraction, PRUNE_TARGET_MIN);
  return { contextWindow, pruneTarget: Math.min(floored, PRUNE_TARGET_MAX) };
}
