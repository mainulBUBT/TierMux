// Public shared types — the wire format the engine already speaks.
//
// The webview bundle also imports from src/shared/** (type-only), and the host
// also re-uses these. The library surface exposes the same shapes so consumers
// can construct ChatMessage[] / parse WorkReportData without an internal
// import path.

export type {
  ChatMessage,
  ChatContent,
  ChatContentBlock,
  ChatToolCall,
  ChatToolDefinition,
  ChatToolChoice,
  ChatCompletionResponse,
  ChatCompletionChunk,
  TokenUsage,
  Platform,
  PlatformInfo,
  CustomEndpoint,
  CustomModel,
  CatalogModel,
  FallbackEntry,
  ReasoningEffort,
  Mode,
  KeyStatus,
} from './types';

export type {
  WorkReportData,
  WorkReportChangedFile,
  WorkReportToolCount,
  TurnTelemetry,
  ContextTelemetry,
} from './workReport';
export { stripLegacyMarkdown } from './workReport';
