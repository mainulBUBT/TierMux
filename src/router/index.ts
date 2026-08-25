// Public router surface — the heart of TierMux.
//
// Re-exports the multi-provider failover engine plus Smart Auto scoring and the
// canonical task-kind → tag-preference capability matrix. The VS Code extension
// uses this through chatViewProvider.ts; library consumers reach it as
// `import { Router, ScoringEngine, profileForTask } from 'tiermux/router'`.

export {
  Router,
  AllModelsFailedError,
  NoVisionModelError,
  setSmartScoring,
  ThinkStripper,
  stripThinkTags,
  clampOutputToContext,
} from './router';
export type { RouteOptions } from './router';
export type { FallbackEntry } from '../shared/types';
export type { CompletionOptions } from '../providers/options';

export { ScoringEngine } from './scoring';
export type {
  SelectionContext,
  CandidateRuntime,
  RationaleEntry,
  RankResult,
  SignalBreakdown,
  SkipReason,
  HealthState,
} from './scoring';
export type { FailureType } from './scoringConfig';

export {
  profileForTask,
  tagComparator,
  tagMagnitude,
  TAG_BOOST_PER_MATCH,
  GENERAL_MILD,
  REASONER_EFFORT_BOOST,
} from './capabilityProfile';
export type { CapabilityProfile, ProfileModel } from './capabilityProfile';
