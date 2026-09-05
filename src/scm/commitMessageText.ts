// Two text checks for the commit-message cleaner: a literal refusal prefix, and a run of
// identical consecutive lines. Used only to reject a junk COMMIT MESSAGE — never to grade an
// agent turn (docs/SIMPLE_CORE_RESET_2026-08-24.md).

export const REFUSAL_PREFIXES = /^(i cannot|i'm sorry|im sorry|as an ai|sure[!,.]?\s*|okay[!,.]?\s*|certainly[!,.]?\s*|of course[!,.]?\s*)/i;

/** Detect `count` or more identical consecutive lines (e.g. a stuck model loop). Blank lines
 *  are dropped before comparing: a stuck model re-emitting the same PARAGRAPH separated by
 *  blank lines (the common markdown shape) would otherwise never register as "consecutive" —
 *  each real line sees an empty-string line between it and its identical predecessor, so the
 *  run resets every time and the whole thing sails through as "no repetition" no matter how
 *  many times it repeats (observed 2026-08-23: 20+ repeats of one paragraph, undetected). */
export function hasRepeatedLineRun(text: string, count: number): boolean {
  const lines = text.split('\n').filter(l => l.trim() !== '');
  let runStart = 0;
  while (runStart < lines.length) {
    let runEnd = runStart + 1;
    while (runEnd < lines.length && lines[runEnd] === lines[runStart]) runEnd++;
    if (runEnd - runStart >= count) return true;
    runStart = runEnd;
  }
  return false;
}
