/**
 * Canonical classification policy: which models suit which task.
 *
 * Single source of truth consumed by BOTH the Smart Auto scorer (`capabilityRaw`
 * in scoring.ts — magnitude view) and the legacy orderer (`orderForTask` in
 * routing.ts — ordinal view). Extracting it here kills the drift the old code's
 * own TODOs flagged, where the two paths each re-encoded the per-kind tag policy
 * and could disagree.
 *
 * Two locked design rules shape this module:
 *
 *  1. **Tags = "best at it", booleans = "can do it".** A capability boolean
 *     (`supportsTools`/`supportsVision`/`supportsReasoning`) is a HARD gate — can
 *     the model do this at all. A tag (`general`/`coding`/`planner`/`reasoner`/
 *     `vision`) is a STRONG quality signal — among capable models, is it
 *     especially good at this. Both are first-class; they are not redundant.
 *
 *  2. **Strong preference + widen.** Tags ONLY adjust score magnitude; they NEVER
 *     filter the candidate set. So a correctly-tagged model floats to the top, but
 *     when no tagged model is enabled/healthy/keyed the existing widen + failover
 *     machinery falls back to untagged capable models — the candidate set is never
 *     emptied by a tag.
 */
import type { TaskKind } from '../agent/routing';
import type { ReasoningEffort } from '../shared/types';

/** Minimal model shape the profile reads — structurally compatible with CatalogModel. */
export interface ProfileModel {
  tags?: string[];
  supportsReasoning?: boolean;
}

export interface CapabilityProfile {
  /** Capability booleans that MUST be true (else hard-exclude / worst-rank). */
  readonly requires: { tools?: boolean; vision?: boolean };
  /** Tags whose presence yields a strong boost. Each match stacks one boost unit. */
  readonly preferredTags: readonly string[];
  /** When true (effort==='high'), a `reasoner` tag is layered into the boost on top of preferredTags. */
  readonly prefersReasoner: boolean;
}

/**
 * Raw-magnitude discount applied per matching preferred tag (lower raw = better).
 * With `intelligenceRank` ∈ [1..5], one match (~3 raw units) is enough to make a
 * tagged rank-5 model beat an untagged rank-1 model — strong, but not so large that
 * runtime/availability can't override it. Policy constant, not a tunable.
 */
export const TAG_BOOST_PER_MATCH = 3.0;
/** Preserved verbatim from the old trivial/chat path so chit-chat routing doesn't regress. */
export const GENERAL_MILD = 0.5;
/** Extra discount when reasoningEffort==='high' AND the model can actually reason. */
export const REASONER_EFFORT_BOOST = 2.0;

const CODING = ['coding'] as const;
const PLAN_TAGS = ['planner', 'reasoner'] as const;
const DEBUG_TAGS = ['coding', 'reasoner'] as const;
const VISION_TAGS = ['vision'] as const;
const GENERAL_TAGS = ['general'] as const;

/**
 * The classification matrix. `reasoningEffort==='high'` layers `reasoner` onto the
 * kind's own preferred set (the seam is here; scoring.ts doesn't thread effort yet —
 * see the plan's scoped follow-up).
 */
export function profileForTask(
  kind: TaskKind,
  opts?: { reasoningEffort?: ReasoningEffort },
): CapabilityProfile {
  const high = opts?.reasoningEffort === 'high' || opts?.reasoningEffort === 'xhigh';
  switch (kind) {
    case 'agent':     return { requires: { tools: true }, preferredTags: CODING, prefersReasoner: high };
    case 'coding':    return { requires: { tools: true }, preferredTags: CODING, prefersReasoner: high };
    case 'debug':     return { requires: { tools: true }, preferredTags: DEBUG_TAGS, prefersReasoner: high };
    case 'plan':      return { requires: {}, preferredTags: PLAN_TAGS, prefersReasoner: high };
    case 'vision':    return { requires: { vision: true }, preferredTags: VISION_TAGS, prefersReasoner: high };
    case 'trivial':   return { requires: {}, preferredTags: GENERAL_TAGS, prefersReasoner: false };
    case 'chat':      return { requires: {}, preferredTags: GENERAL_TAGS, prefersReasoner: false };
    case 'longContext': return { requires: {}, preferredTags: [], prefersReasoner: false };
    default:          return { requires: {}, preferredTags: [], prefersReasoner: false };
  }
}

/**
 * Raw-magnitude contribution of a model's tags vs the profile (lower = better).
 * Returns a NON-POSITIVE number (a discount). `general` is deliberately mild
 * (GENERAL_MILD) so it never overrides intelligence/speed on low-stakes turns.
 */
export function tagMagnitude(profile: CapabilityProfile, m: ProfileModel): number {
  const tags = m.tags ?? [];
  let discount = 0;
  let matched = false;
  for (const t of profile.preferredTags) {
    if (tags.includes(t)) { discount += (t === 'general' ? GENERAL_MILD : TAG_BOOST_PER_MATCH); matched = true; }
  }
  // Effort-layered reasoner: boost only if the model can actually reason (boolean gate).
  if (profile.prefersReasoner && tags.includes('reasoner') && m.supportsReasoning) {
    discount += TAG_BOOST_PER_MATCH;
    matched = true;
  }
  void matched;
  return -discount;
}

/**
 * Ordinal view of the same policy for the legacy comparator: returns negative when
 * `a` is a better tag match than `b`. Magnitude mirrors `tagMagnitude` so the
 * ordinal and numeric paths always agree (no drift).
 */
export function tagComparator(profile: CapabilityProfile, a: ProfileModel, b: ProfileModel): number {
  // tagMagnitude is ≤ 0 (lower = better), so a smaller magnitude is better → a first.
  return tagMagnitude(profile, a) - tagMagnitude(profile, b);
}
