// Public router surface — `import { selectModel } from 'tiermux/router'`.

export { selectModel, setModelSources, peekTopModel, findCatalogModel, recordOutcome, recordRequest, isInCooldown, setQuotaStore, TASK_ROUTING } from './picker';
export type { ModelSelection, ModelSources, SelectionRationale } from './picker';
export { AllModelsFailedError, NoVisionModelError } from './errors';
export { RateTracker } from './rateTracker';
export { ThinkStripper, stripThinkTags, clampOutputToContext } from '../util/thinkTags';
export type { FallbackEntry } from '../shared/types';
export type { CompletionOptions } from '../providers/options';
