// TierMux public library entry point.
//
// Two consumers, one surface:
//   1. The VS Code extension (bundled into dist/extension.js by esbuild).
//   2. Any Node.js application: `import { Router, runAgentStream, classifyTask } from 'tiermux'`.
//
// This file is a pure re-export barrel — it does not add new logic. The contract
// it exposes is the same one the extension's chatViewProvider.ts consumes. The
// engine under src/agent/core/ stays the only place AI SDK types appear (see
// docs/ARCHITECTURE.md, "Layering boundary"); everything re-exported here is
// TierMux's own types.
//
// Library consumers headlessly need a `vscode` shim. The repo ships one at
// scripts/vscodeMock.cjs for the e2e suite; library consumers can do the same
// pattern (`node -r ./shim-vscode.cjs ...`) or write a minimal stub for the
// handful of vscode symbols the engine reads (config + fs + workspace root).
// A full host-boundary refactor is scoped for a follow-up; see plan.
//
// Engine contract reminder: the agent loop is mechanical execution only
// (docs/SIMPLE_CORE_RESET_2026-08-24.md). The library surface is intentionally
// minimal — there is no public "judge answer" or "retry ladder" entry point,
// because those don't exist in the engine either.

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
  WatchdogActivity,
} from './agent/agent';

// ── AI SDK adapter — turn TierMux's Router into a model the AI SDK can stream ──
export { createRouterProvider } from './agent/core/routerProvider';
export type { RouterProviderOptions, RationaleEntryInfo } from './agent/core/routerProvider';

// ── Task classification (router input) ────────────────────────────────────────
export {
  classifyTask,
  classifyTaskCore,
  isPureVisualDescribe,
  attachmentKindsFromContent,
} from './agent/routing';
export type { TaskKind, ClassifySignals } from './agent/routing';

// ── Router (the heart of TierMux) ─────────────────────────────────────────────
export {
  Router,
  AllModelsFailedError,
  NoVisionModelError,
  setSmartScoring,
  ThinkStripper,
  stripThinkTags,
  clampOutputToContext,
} from './router/router';
export type { RouteOptions } from './router/router';
export type { FallbackEntry } from './shared/types';
export type { CompletionOptions } from './providers/options';

// ── Smart Auto scoring + capability classification ────────────────────────────
export { ScoringEngine } from './router/scoring';
export type {
  SelectionContext,
  CandidateRuntime,
  RationaleEntry,
  RankResult,
  SignalBreakdown,
  SkipReason,
  HealthState,
} from './router/scoring';
export {
  profileForTask,
  tagComparator,
  tagMagnitude,
  TAG_BOOST_PER_MATCH,
  GENERAL_MILD,
  REASONER_EFFORT_BOOST,
} from './router/capabilityProfile';
export type { CapabilityProfile, ProfileModel } from './router/capabilityProfile';

// ── Provider registry (lookup by platform id, custom endpoint upsert) ─────────
export {
  resolveProvider,
  invalidateCustomProvider,
  getPlatformInfo,
  allPlatformInfo,
  upsertCompatFromCatalog,
} from './providers';
export type { RemoteProviderDef } from './providers';

// ── Execution profile (per-model budgets, prune thresholds) ───────────────────
export {
  resolveExecutionProfile,
  defaultMaxOutputTokens,
  WEAK_RANK_MIN,
  STRONG_RANK_MAX,
  UNKNOWN_RANK,
  FALLBACK_CONTEXT_WINDOW,
  PRUNE_TARGET_FRACTION,
} from './agent/executionProfile';
export type { ExecutionProfile } from './agent/executionProfile';

// ── Context-budget helpers (used by callers writing their own agents) ────────
export {
  estimateTokens,
  estimateMessagesTokens,
  fitMessages,
  inputBudget,
} from './agent/budget';

// ── Clarifying-question shape (plan/agent pre-flight) ─────────────────────────
export type { ClarifyingQuestion } from './agent/clarify';

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
