

import type { TaskKind } from './routing';
import { estimateTokens } from './budget';

/** Known refusal / preamble prefixes that are never a valid answer lead-in. */
export const REFUSAL_PREFIXES = /^(i cannot|i'm sorry|im sorry|as an ai|sure[!,.]?\s*|okay[!,.]?\s*|certainly[!,.]?\s*|of course[!,.]?\s*)/i;

/** Detect `count` or more identical consecutive lines (e.g. a stuck model loop). */
export function hasRepeatedLineRun(text: string, count: number): boolean {
  const lines = text.split('\n');
  let runStart = 0;
  while (runStart < lines.length) {
    let runEnd = runStart + 1;
    while (runEnd < lines.length && lines[runEnd] === lines[runStart]) runEnd++;
    if (runEnd - runStart >= count) return true;
    runStart = runEnd;
  }
  return false;
}

export type QualitySignal = 'refusal' | 'repetition' | 'truncation' | 'too_short' | 'vision_blind';

/** Contribution of each matched signal to the weakness score (higher = weaker). */
export const QUALITY_WEIGHTS: Record<QualitySignal, number> = {
  refusal: 100,      // near-certain: escalate alone
  vision_blind: 100, // vision turn answered "I can't see images" — the image never reached the model; escalate alone
  repetition: 60,    // strong: escalate alone
  truncation: 50,    // strong: escalate alone
  too_short: 15,     // weak: never escalates alone, only pushes past threshold with another signal
};

/**
 * On a vision turn, an answer claiming the model cannot see/process images means the
 * image was dropped somewhere upstream (aggregator delegated to a text-only model,
 * provider flattened the content, …) — the answer is useless no matter how fluent.
 * Matched only when taskKind === 'vision', so text turns can freely discuss image
 * processing without tripping it.
 */
export const VISION_BLIND = /\b(?:can(?:no|')?t|cannot|unable to|not able to)\s+(?:actually\s+)?(?:"?see"?|view|interpret|process|analyz\w*|read)\b[^.\n]{0,60}\b(?:image|picture|screenshot|photo|visual)s?\b|\b(?:capabilit(?:y|ies)|i)\s+(?:am|are|is)?\s*limited to (?:processing |interpreting )?text\b|\bas a text-(?:only|based) (?:ai|model|assistant)\b/i;

/** A run scores at or above this is considered weak and escalated. */
export const WEAK_THRESHOLD = 40;

/**
 * Minimum word count expected for a substantive answer per task kind. Only
 * feeds the `too_short` signal (weight 15) — never a standalone trigger, so a
 * short-but-correct answer (one-line patch, terse rename) is never escalated on
 * length alone. `trivial` is handled by an early short-circuit and has no floor.
 *
 * Note: `plan`'s floor is currently dormant — plan mode is a length-1 chain
 * (isFinalHop from hop 0), so the gate never fires there. Defined for
 * completeness; revisit if plan-mode escalation is enabled later.
 */
export const TASK_WORD_FLOOR: Record<Exclude<TaskKind, 'trivial'>, number> = {
  chat: 2,
  vision: 4,
  agent: 12,
  coding: 12,
  debug: 12,
  longContext: 12,
  plan: 20,
};

export interface AnswerQuality {
  /** Decision: should the caller escalate to the next chain hop? */
  weak: boolean;
  /** Heuristic weakness score (sum of matched signal weights). Room for an LLM
   *  judge to add to this later without changing the API. */
  score: number;
  /** Every signal that matched (debugging/tuning). Not first-hit-wins. */
  signals: QualitySignal[];
  /** Highest-weight matched signal (stable reason token for logging/UI). */
  primary?: QualitySignal;
}

const TRAILING_FRAGMENT = /[\s,:;&-]$|\b(and|or|but|because|while|when|if|then)\s*$/i;

const TERMINAL_CHAR = /[.!?:)"'\]”’]$/;

/**
 * Score an answer's quality from cheap text heuristics. Returns all matched
 * signals plus an aggregate `weak` decision.
 *
 * Empty `out` returns `{weak:false}` — emptiness is the caller's existing
 * `no_answer` path, not a quality signal. `trivial` tasks short-circuit to
 * `{weak:false}` because a short answer is correct and there's nowhere useful
 * to escalate.
 */
export function assessAnswerQuality(out: string, taskKind: TaskKind): AnswerQuality {
  const empty: AnswerQuality = { weak: false, score: 0, signals: [] };
  const t = (out ?? '').trim();
  if (!t) return empty;
  if (taskKind === 'trivial') return empty;

  const words = t.split(/\s+/).filter(Boolean).length;
  const signals: QualitySignal[] = [];

  const dominantRefusal = t.length < 120 && /i can(?:no|')?t|i'm sorry|as an ai/i.test(t);
  if ((REFUSAL_PREFIXES.test(t) && words < 40) || dominantRefusal) {
    signals.push('refusal');
  }

  if (taskKind === 'vision' && VISION_BLIND.test(t)) {
    signals.push('vision_blind');
  }

  if (hasRepeatedLineRun(t, 3) || (words < 60 && hasRepeatedNgram(t, 8, 3))) {
    signals.push('repetition');
  }

  if (looksTruncated(t)) {
    signals.push('truncation');
  }

  const floor = TASK_WORD_FLOOR[taskKind as Exclude<TaskKind, 'trivial'>] ?? 12;
  const hasFence = t.includes('```');
  if ((words < floor && !hasFence) || estimateTokens(t) < 8) {
    signals.push('too_short');
  }

  const uniq = Array.from(new Set(signals));
  const score = uniq.reduce((sum, s) => sum + (QUALITY_WEIGHTS[s] ?? 0), 0);

  const primary = uniq.length
    ? uniq.slice().sort((a, b) => (QUALITY_WEIGHTS[b] ?? 0) - (QUALITY_WEIGHTS[a] ?? 0))[0]
    : undefined;

  return { weak: score >= WEAK_THRESHOLD, score, signals: uniq, primary };
}

/** True if `n` or more consecutive `size`-token windows repeat (loop signal). */
function hasRepeatedNgram(text: string, size: number, n: number): boolean {
  const toks = text.split(/\s+/).filter(Boolean);
  if (toks.length < size * n) return false;
  const counts = new Map<string, number>();
  for (let i = 0; i + size <= toks.length; i++) {
    const gram = toks.slice(i, i + size).join(' ');
    const c = (counts.get(gram) ?? 0) + 1;
    if (c >= n) return true;
    counts.set(gram, c);
  }
  return false;
}

/**
 * Truncation proxies — the SDK layer sees no finish_reason, so infer a cut-off
 * from the text shape. Any one of these is enough.
 *  - ends mid-sentence (no terminal punctuation AND a trailing fragment marker),
 *  - an odd number of ``` fences (unclosed code block),
 *  - unbalanced inline backticks,
 *  - a dangling open bracket `(`, `{`, or `[` on the last line.
 */
function looksTruncated(t: string): boolean {
  if (!TERMINAL_CHAR.test(t) && TRAILING_FRAGMENT.test(t)) return true;

  const fences = (t.match(/```/g) ?? []).length;
  if (fences % 2 === 1) return true;

  const ticks = (t.match(/`/g) ?? []).length;
  if (ticks % 2 === 1) return true;

  const lastLine = t.split('\n').pop() ?? '';
  if (/[({[]\s*$/.test(lastLine)) return true;
  return false;
}
