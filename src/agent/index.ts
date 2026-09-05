// Public agent surface — the v3 engine: TierMux policy/orchestration over the AI SDK
// execution engine (see src/agent/core/engine.ts). Three entry points, one per mode,
// plus task classification and the AI SDK adapter.

export {
  runAgentStream,
  runPlanStream,
  runAskStream,
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
  isPureVisualDescribe,
  attachmentKindsFromContent,
} from './routing';
export type { TaskKind, ClassifySignals } from './routing';

export { buildV3ToolSet, READ_ONLY_TOOLS } from './core/tools/v3';
