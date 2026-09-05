/**
 * Cap a tool result's size before it enters the agent's message history.
 *
 * Why this matters more than it looks: a tool result is not paid for once. It joins the turn's
 * transcript (engine.ts) and is re-sent on every following step until compact.ts's
 * `ageToolOutputs` stubs it — which happens only once it has left the last THREE tool messages,
 * so a fat result is re-billed at least three times, and on a small-window model it can evict
 * the actual task before aging ever reaches it. This cap is the FIRST-ARRIVAL bound (how big a
 * single result may be); aging is the re-send bound. Together they keep the working context
 * small, which is both cheaper AND keeps weak models coherent for more steps.
 *
 * The truncation marker is deliberately instructive: it tells the model the output was cut and
 * how to get the rest (narrow the query / read a specific range), so a cap never becomes a dead
 * end where the model just gives up on a half-seen result.
 */
export function capToolOutput(text: string, maxChars: number, hint = ''): string {
  if (text.length <= maxChars) return text;
  const shown = text.slice(0, maxChars);
  const omitted = text.length - maxChars;
  const suffix = hint ? ` ${hint}` : '';
  return `${shown}\n…[truncated — ${omitted.toLocaleString()} of ${text.length.toLocaleString()} chars omitted.${suffix}]`;
}
