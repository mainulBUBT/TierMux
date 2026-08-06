/* LLM judge for the Reasoning and Answer scores.
 *
 * Retrieval is NOT judged — it is computed from the tool trace against dataset ground truth
 * (see qualityScore.ts), because "did it open the right file" is a fact, and a model grading it
 * would just add noise. Reasoning and Answer are genuinely subjective ("would a developer
 * accept this?"), which is what docs/BENCHMARK.md asks a human to score; the judge automates
 * that pass so a 50-query run is repeatable, with --no-judge leaving it to a human instead.
 *
 * The judge must be a STRONG model and must be pinned: grading with whatever Auto picks would
 * make two runs incomparable, and grading with the same weak free model that produced the
 * answer measures nothing.
 */
import type { Router } from '../../src/router/router';
import type { QualityQuery, QualityScores } from './qualityTypes';

const SYSTEM = `You grade a coding assistant's answer about a real codebase. You are strict and terse.

Score two axes:

reasoning (0, 0.5, or 1)
  1   = complete, correct chain: it identifies the right mechanism and explains how the pieces connect.
  0.5 = right direction but incomplete: correct entry point, missing a key link or half the mechanism.
  0   = wrong, hand-wavy, or generic boilerplate that would fit any codebase.

answer (0 or 1)
  1 = a developer working in this codebase would accept this and act on it.
  0 = they would not: wrong, too vague to act on, or it answers a different question.

Rules:
- Judge SUBSTANCE, not length, tone, or formatting. A short correct answer scores 1.
- Confident, plausible-sounding text with no specific files/symbols is reasoning 0, not 0.5.
- If a rubric is given, it defines what a complete chain means. Missing a rubric point caps reasoning at 0.5.
- For a proposal (feature/refactor query), "correct" means it names the actual files and the real
  integration points in THIS codebase, not a generic recipe.

Reply with ONLY a JSON object, no prose, no code fence:
{"reasoning": 0|0.5|1, "answer": 0|1, "rationale": "<one sentence, max 25 words>"}`;

function buildPrompt(q: QualityQuery, answer: string, touchedFiles: string[]): string {
  const parts = [
    `QUESTION (category: ${q.category}):\n${q.query}`,
    q.rubric ? `\nRUBRIC — what a complete answer must contain:\n${q.rubric}` : '',
    `\nFILES THE EXPECTED ANSWER LIVES IN (ground truth, for your reference only — do not reward merely naming them):\n${[...q.expectFiles, ...(q.expectAnyOf ?? [])].join(', ')}`,
    touchedFiles.length ? `\nFILES THE ASSISTANT ACTUALLY OPENED:\n${touchedFiles.slice(0, 30).join(', ')}` : '',
    // Long answers get truncated rather than dropped: the judge only needs enough to decide,
    // and an oversized prompt is the fastest way to make the judge itself fail.
    `\nASSISTANT'S ANSWER:\n${answer.length > 12000 ? `${answer.slice(0, 12000)}\n…[truncated]` : answer}`,
  ];
  return parts.filter(Boolean).join('\n');
}

/** Pull the JSON object out of a judge reply that may be fenced or padded with prose. */
function parseVerdict(text: string): { reasoning: number; answer: number; rationale: string } | null {
  const cleaned = text.replace(/^```(?:json)?/gm, '').replace(/```$/gm, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  const v = raw as { reasoning?: unknown; answer?: unknown; rationale?: unknown };
  const reasoning = Number(v.reasoning);
  const answer = Number(v.answer);
  // Snap to the allowed scale rather than trusting the model to stay on it.
  if (![0, 0.5, 1].includes(reasoning)) return null;
  if (![0, 1].includes(answer)) return null;
  return {
    reasoning,
    answer,
    rationale: typeof v.rationale === 'string' ? v.rationale.slice(0, 200) : '',
  };
}

export interface JudgeOpts {
  /** Pinned 'platform::modelId'. */
  model: string;
  /** Re-ask on an unparseable verdict or a failed call — a weak-ish judge often gets the format
   *  right on the second try, and dropping the query entirely would bias the run. */
  retries?: number;
}

/** Judge one answer. Returns unscored (0/0, judged:false) with a rationale explaining why when
 *  the judge itself fails — never silently a zero that looks like a real verdict. */
export async function judgeAnswer(
  router: Router,
  q: QualityQuery,
  answer: string,
  touchedFiles: string[],
  opts: JudgeOpts,
): Promise<Omit<QualityScores, 'retrieval'>> {
  const attempts = 1 + (opts.retries ?? 1);
  let lastProblem = 'judge produced no parseable verdict';
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await router.route(
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: buildPrompt(q, answer, touchedFiles) },
        ],
        { model: opts.model, temperature: 0, max_tokens: 300 },
      );
      const text = result.response.choices?.[0]?.message?.content;
      const verdict = parseVerdict(typeof text === 'string' ? text : '');
      if (verdict) return { ...verdict, judged: true };
    } catch (e) {
      lastProblem = `judge call failed: ${(e as Error).message}`;
      // The judge runs on the same free tiers the agent does, so its failures are usually a
      // rate-limit cooldown. Retrying immediately just burns the attempt.
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 8_000));
    }
  }
  return { reasoning: 0, answer: 0, rationale: `UNSCORED — ${lastProblem}`, judged: false };
}
