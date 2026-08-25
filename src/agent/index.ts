// Public agent surface — the simple-core execution engine.
//
// Three entry points (one per mode), plus task classification that drives Auto
// routing and the AI SDK adapter that turns the Router into a model the SDK
// can stream. The engine is mechanical execution only — see
// docs/SIMPLE_CORE_RESET_2026-08-24.md for the invariants.

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
  WatchdogActivity,
} from './agent';

export { createRouterProvider } from './core/routerProvider';
export type { RouterProviderOptions, RationaleEntryInfo } from './core/routerProvider';

export {
  classifyTask,
  classifyTaskCore,
  isPureVisualDescribe,
  attachmentKindsFromContent,
} from './routing';
export type { TaskKind, ClassifySignals } from './routing';

export { resolveExecutionProfile, defaultMaxOutputTokens } from './executionProfile';
export type { ExecutionProfile } from './executionProfile';

export type { ClarifyingQuestion } from './clarify';
