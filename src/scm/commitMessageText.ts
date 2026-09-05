// The two text checks the commit-message cleaner needs. They are all that survived
// src/agent/answerQuality.ts, deleted 2026-09-05: the rest of that file was an answer-QUALITY
// judge (assessAnswerQuality + weights + thresholds) that scored a model's reply and escalated
// on a low score. docs/SIMPLE_CORE_RESET_2026-08-24.md forbids exactly that, and nothing had
// called it since the v3 reset — leaving it on disk was an invitation to wire it back up.
//
// These two are not judgement: one matches a literal refusal prefix, the other counts identical
// consecutive lines. Both are used only to decide whether a generated COMMIT MESSAGE is junk,
// never to grade an agent turn.

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
