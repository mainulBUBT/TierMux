// Suggest powerful free (keyless) models the user could enable when their configured chain
// can't handle a task — so a "weak model can't cope" failure points at a concrete fix instead
// of a generic error. Reads the catalog + the platform keyless registry (getPlatformInfo).
import type { Catalog } from '../catalog/catalog';
import { getPlatformInfo } from '../providers';

export interface ModelRecommendation {
  /** `platform::modelId` — the key used everywhere to identify a model. */
  key: string;
  /** Human-readable "Name (platform)". */
  display: string;
  /** intelligenceRank (lower = smarter), so the caller can show the strongest first. */
  rank: number;
}

/**
 * Strong free (keyless) models the user hasn't enabled, smartest first. Used when escalation
 * exhausts the configured chain or all models fail, to point the user at a concrete upgrade.
 */
export function recommendFreeStrong(catalog: Catalog, enabledKeys: Set<string>, n = 3): ModelRecommendation[] {
  return catalog
    .all()
    .filter((m) => getPlatformInfo(m.platform)?.keyless)            // needs no API key → free
    .filter((m) => m.supportsTools !== false)                        // usable for agent tasks
    .filter((m) => !enabledKeys.has(`${m.platform}::${m.modelId}`))  // not already enabled
    .sort((a, b) => a.intelligenceRank - b.intelligenceRank || a.speedRank - b.speedRank)
    .slice(0, n)
    .map((m) => ({
      key: `${m.platform}::${m.modelId}`,
      display: `${m.displayName} (${m.platform})`,
      rank: m.intelligenceRank,
    }));
}
