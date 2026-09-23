// Public agent surface. The agent is Cline (src/agent/core/cline/clineEngine.ts); TierMux adds
// the model selection boundary and task classification for routing.

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
