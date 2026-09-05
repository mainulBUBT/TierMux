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
  /** Requested structured-output mode (generateObject/generateText output:'object'|'enum').
   *  Plumbed through for future per-provider native `response_format` support — NOT yet
   *  consumed by any adapter (see routerProvider.ts's doGenerate, which relies on a trailing
   *  prompt instruction + fence-stripping instead, since ~18 heterogeneous free providers'
   *  actual `response_format` support is unverified and a wrong guess would 400 real requests).
   *  Wire a specific adapter to it only after confirming that platform's API actually accepts
   *  the field. */
  responseFormat?: { type: 'json'; schema?: unknown };
}
