// Public router surface.
//
// The Router class and the whole scoring stack (scoring, scoringConfig, wilson, metricsStore,
// latencyTracker, mockFixture) were retired on 2026-09-05 — see
// docs/AGENT_RELIABILITY_PLAN_2026-09-05.md §4.2. Selection is `picker.ts`: a task table plus a
// per-model cooldown and the declared rpm/rpd windows, ~500 LOC where the Router was ~4,300.
// Library consumers reach it as `import { selectModel } from 'tiermux/router'`.

export { selectModel, setModelSources, peekTopModel, findCatalogModel, recordOutcome, recordRequest, isInCooldown, setQuotaStore, TASK_ROUTING } from './picker';
export type { ModelSelection, ModelSources, SelectionRationale } from './picker';
export { AllModelsFailedError, NoVisionModelError } from './errors';
export { RateTracker } from './rateTracker';
export { ThinkStripper, stripThinkTags, clampOutputToContext } from '../util/thinkTags';
export type { FallbackEntry } from '../shared/types';
export type { CompletionOptions } from '../providers/options';

export {
  profileForTask,
  tagComparator,
  tagMagnitude,
  TAG_BOOST_PER_MATCH,
  GENERAL_MILD,
  REASONER_EFFORT_BOOST,
} from './capabilityProfile';
export type { CapabilityProfile, ProfileModel } from './capabilityProfile';
