/** Cap a tool result before it enters history. A result is re-sent on every following step until
 *  compact.ts's `ageToolOutputs` stubs it (after it leaves the last THREE tool messages), so a fat
 *  result is billed at least three times and can evict the task on a small window. This is the
 *  first-arrival bound; aging is the re-send bound. The marker tells the model how to get the
 *  rest so a cap is never a dead end. */
export function capToolOutput(text: string, maxChars: number, hint = ''): string {
  if (text.length <= maxChars) return text;
  const shown = text.slice(0, maxChars);
  const omitted = text.length - maxChars;
  const suffix = hint ? ` ${hint}` : '';
  return `${shown}\n…[truncated — ${omitted.toLocaleString()} of ${text.length.toLocaleString()} chars omitted.${suffix}]`;
}
