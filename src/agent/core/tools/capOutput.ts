/**
 * Cap a tool result's size before it enters the agent's message history.
 *
 * Why this matters more than it looks: a tool result is not paid for once. It is appended to
 * `workMessages` (loop.ts) and re-sent to the model on EVERY subsequent iteration of the turn,
 * and again on each of the up-to-3 auto-continues (chatViewProvider). One uncapped 100KB `read`
 * or `runCommand` dump early in a task is therefore re-billed a dozen times over — on free-tier
 * models whose whole context window is often only 8–32K tokens, that single result can evict the
 * actual task. Capping keeps the working context small, which is both cheaper AND keeps weak
 * models coherent for more steps.
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
