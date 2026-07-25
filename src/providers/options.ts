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
  /** External cancellation (e.g. the user's Stop button, or a sub-agent's own wall-clock
   *  ceiling like explore.ts's 45s). Combined with the provider's own timeout-based
   *  AbortController in BaseProvider.fetchWithTimeout — without this, an external abort never
   *  reached the actual in-flight HTTP request, so "cancel" only stopped FUTURE work, not the
   *  live one, and a sub-agent's declared timeout was purely decorative. */
  abortSignal?: AbortSignal;
  /** Base URL override (from the settings store); falls back to the default. */
  baseUrlOverride?: string;
}
