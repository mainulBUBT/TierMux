/** Cap a tool result before it enters history. A result is re-sent on every following step until
 *  compact.ts's `ageToolOutputs` stubs it (once the transcript passes the aging budget, oldest
 *  first), so a fat result is billed on every step until then and can evict the task on a small
 *  window. This is the first-arrival bound; aging is the re-send bound. The marker tells the model
 *  how to get the rest so a cap is never a dead end. */
export function capToolOutput(text: string, maxChars: number, hint = ''): string {
  if (text.length <= maxChars) return text;
  const shown = text.slice(0, maxChars);
  const omitted = text.length - maxChars;
  const suffix = hint ? ` ${hint}` : '';
  return `${shown}\n…[truncated — ${omitted.toLocaleString()} of ${text.length.toLocaleString()} chars omitted.${suffix}]`;
}

/** Keep the START and the END of `text`, drop the middle with a marker. For command output:
 *  test runners, compilers and package managers print their verdict LAST (jest "Tests: 3 failed",
 *  pytest's FAILED lines, tsc/npm ERR), so a head-only cut handed the model a failing exit code
 *  without the failure. Cuts land on line boundaries when one is near. */
export function capMiddle(text: string, maxChars: number, headShare = 0.25): string {
  if (text.length <= maxChars) return text;
  let head = text.slice(0, Math.floor(maxChars * headShare));
  let tail = text.slice(text.length - (maxChars - head.length));
  const headNl = head.lastIndexOf('\n');
  if (headNl > head.length - 200 && headNl > 0) head = head.slice(0, headNl);
  const tailNl = tail.indexOf('\n');
  if (tailNl !== -1 && tailNl < 200) tail = tail.slice(tailNl + 1);
  const omitted = text.length - head.length - tail.length;
  return `${head}\n…[${omitted.toLocaleString()} chars omitted from the middle]…\n${tail}`;
}
