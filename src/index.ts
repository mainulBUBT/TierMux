// TierMux public library entry point — a pure re-export barrel over the same contract the
// extension's chatViewProvider consumes. Headless consumers need a `vscode` shim (see
// scripts/vscodeMock.cjs for the shape the engine reads: config + fs + workspace root).

// ── Agent runners (the only public entry into the engine) ──────────────────────
export {
  runAgentStream,
  runPlanStream,
  runAskStream,
} from './agent/agent';
export type {
  AgentOpts,
  AgentResult,
  ToolEvent,
  AgentMode,
  SelectionRationaleInfo,
} from './agent/agent';

// ── AI SDK adapter — turn the v3 picker into a model the AI SDK can stream ──────
export { createRouterProvider } from './agent/core/routerProvider';
export type { RouterProviderOptions } from './agent/core/routerProvider';

// ── Task classification (router input) ────────────────────────────────────────
export {
  classifyTask,
  classifyTaskCore,
  isPureVisualDescribe,
  attachmentKindsFromContent,
} from './agent/routing';
export type { TaskKind, ClassifySignals } from './agent/routing';

// ── Model selection (picker) ──────────────────────────────────────────────────
export {
  selectModel,
  setModelSources,
  peekTopModel,
  findCatalogModel,
  recordOutcome,
  recordRequest,
  isInCooldown,
  setQuotaStore,
  TASK_ROUTING,
} from './router/picker';
export type { ModelSelection, ModelSources, SelectionRationale } from './router/picker';
export { AllModelsFailedError, NoVisionModelError } from './router/errors';
export { ThinkStripper, stripThinkTags, clampOutputToContext } from './util/thinkTags';
export type { FallbackEntry } from './shared/types';
export type { CompletionOptions } from './providers/options';

// ── Provider registry (lookup by platform id, custom endpoint upsert) ─────────
export {
  resolveProvider,
  invalidateCustomProvider,
  getPlatformInfo,
  allPlatformInfo,
  upsertCompatFromCatalog,
} from './providers';
export type { RemoteProviderDef } from './providers';

// ── Execution profile (per-model context window + prune threshold) ───────────
export { resolveExecutionProfile } from './agent/executionProfile';
export type { ExecutionProfile } from './agent/executionProfile';

// ── Context-budget helpers (used by callers writing their own agents) ────────
export {
  estimateTokens,
  estimateMessagesTokens,
  fitMessages,
  inputBudget,
} from './agent/budget';

// ── Shared types — the wire format the engine already speaks ──────────────────
export type {
  ChatMessage,
  ChatContent,
  ChatContentBlock,
  ChatToolCall,
  ChatToolDefinition,
  ChatToolChoice,
  ChatCompletionResponse,
  TokenUsage,
  Platform,
  PlatformInfo,
  CustomEndpoint,
  CatalogModel,
  ReasoningEffort,
  Mode,
  TodoItem,
  PlanRunState,
} from './shared/types';

// ── Work report — the durable end-of-turn representation ─────────────────────
export type {
  WorkReportData,
  WorkReportChangedFile,
  WorkReportToolCount,
  TurnTelemetry,
  ContextTelemetry,
} from './shared/workReport';
export { renderLegacyMarkdown, stripLegacyMarkdown } from './shared/workReport';
