import type { ChatToolChoice, ChatToolDefinition, ReasoningEffort } from '../shared/types';

/** Per-request options passed to a provider adapter. */
export interface CompletionOptions {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
  /** Neutral reasoning effort; each adapter maps it to its provider's param. */
  reasoningEffort?: ReasoningEffort;
  /** Per-call HTTP timeout override (ms). */
  timeoutMs?: number;
  /** Base URL override (from the settings store); falls back to the default. */
  baseUrlOverride?: string;
}
