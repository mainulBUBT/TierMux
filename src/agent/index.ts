// Public agent surface — the Cline runtime engine: TierMux policy/orchestration over the
// AgentRuntime loop (see src/agent/core/cline/clineEngine.ts). Two entry points, one per mode,
// plus task classification and the model selection boundary.

export {
  runAgentStream,
  runPlanStream,
} from './agent';
export type {
  AgentOpts,
  AgentResult,
  ToolEvent,
  AgentMode,
  SelectionRationaleInfo,
} from './agent';

export { createRouterProvider, setModelSources } from './core/routerProvider';
export type { RouterProviderOptions, ModelSources } from './core/routerProvider';

export {
  classifyTask,
  classifyTaskCore,
  attachmentKindsFromContent,
} from './routing';
export type { TaskKind, ClassifySignals } from './routing';

export { buildV3ToolSet, READ_ONLY_TOOLS } from './core/tools/v3';
