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
  /** External cancellation (the Stop button, a sub-agent's deadline). Combined with the
   *  provider's own timeout in BaseProvider.fetchWithTimeout so it aborts the live request. */
  abortSignal?: AbortSignal;
  /** Base URL override (from the settings store); falls back to the default. */
  baseUrlOverride?: string;
  /** Requested structured-output mode. NOT yet consumed by any adapter — routerProvider's
   *  doGenerate relies on a trailing prompt instruction + fence-stripping, since ~18 free
   *  providers' `response_format` support is unverified. Wire an adapter only after confirming. */
  responseFormat?: { type: 'json'; schema?: unknown };
}
