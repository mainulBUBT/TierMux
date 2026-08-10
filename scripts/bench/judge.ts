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
import { generateObject } from 'ai';
import { z } from 'zod';
import { createRouterProvider } from '../../src/agent/core/routerProvider';
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

/** Nearest allowed value, instead of discarding the whole verdict over an off-scale number. A
 *  judge that says 0.8 has clearly formed an opinion; throwing that away produced an UNSCORED
 *  query, which is strictly worse data than snapping it to 1. */
function snap(n: number, allowed: number[]): number | null {
  if (!Number.isFinite(n)) return null;
  if (n < Math.min(...allowed) - 0.5 || n > Math.max(...allowed) + 0.5) return null;
  return allowed.reduce((best, a) => (Math.abs(a - n) < Math.abs(best - n) ? a : best), allowed[0]);
}

/** Every balanced {...} span in the text. A single indexOf('{')…lastIndexOf('}') slice breaks the
 *  moment a reasoning model emits a `<think>` block containing a brace — measured as 5 of 24
 *  UNSCORED queries in the 2026-08-09 run. */
function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') {
        depth--;
        if (depth === 0) { out.push(text.slice(i, j + 1)); break; }
      }
    }
  }
  return out;
}

/** Pull the JSON object out of a judge reply that may be fenced, padded with prose, or preceded
 *  by a reasoning block. */
function parseVerdict(text: string): { reasoning: number; answer: number; rationale: string } | null {
  const cleaned = text
    // Reasoning models put their scratchpad first; it routinely contains braces and stray
    // "reasoning: 0.5" chatter that must not be mistaken for the verdict.
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|channel\|>[\s\S]*?<\|message\|>/gi, '')
    .replace(/^```(?:json)?/gm, '')
    .replace(/```$/gm, '');
  // Later candidates first: when a model reasons in prose and THEN emits the verdict, the verdict
  // is the last object, not the first.
  for (const candidate of jsonCandidates(cleaned).reverse()) {
    let raw: unknown;
    try { raw = JSON.parse(candidate); } catch { continue; }
    const v = raw as { reasoning?: unknown; answer?: unknown; rationale?: unknown };
    if (v.reasoning === undefined || v.answer === undefined) continue;
    const reasoning = snap(Number(v.reasoning), [0, 0.5, 1]);
    const answer = snap(Number(v.answer), [0, 1]);
    if (reasoning === null || answer === null) continue;
    return {
      reasoning,
      answer,
      rationale: typeof v.rationale === 'string' ? v.rationale.slice(0, 200) : '',
    };
  }
  return null;
}

/** Schema-forced verdict. Free-text JSON was the judge's dominant failure mode: after the
 *  timeout/empty/network fixes, ALL 15 remaining unscored queries were "no parseable verdict" —
 *  the model answered, just not as JSON. generateObject makes the SDK enforce the shape. Literal
 *  unions (not a bare number) so the model is told the exact allowed values. */
const VERDICT_SCHEMA = z.object({
  reasoning: z.union([z.literal(0), z.literal(0.5), z.literal(1)]),
  answer: z.union([z.literal(0), z.literal(1)]),
  rationale: z.string().max(200).describe('One sentence, max 25 words.'),
});

/** Structured-output attempt. Returns null on any failure so the caller falls back to the
 *  free-text path — some free providers reject response_format outright. */
async function judgeStructured(
  router: Router,
  prompt: string,
  model: string | undefined,
): Promise<{ reasoning: number; answer: number; rationale: string } | null> {
  try {
    const provider = createRouterProvider(router, { taskKind: 'chat', ...(model ? { pinnedModel: model } : {}) });
    const { object } = await generateObject({
      model: provider,
      schema: VERDICT_SCHEMA,
      system: SYSTEM,
      prompt,
      abortSignal: AbortSignal.timeout(90_000),
    });
    return { reasoning: object.reasoning, answer: object.answer, rationale: object.rationale ?? '' };
  } catch {
    return null;
  }
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
  const attempts = 1 + (opts.retries ?? 3);
  let lastProblem = 'judge produced no parseable verdict';
  for (let i = 0; i < attempts; i++) {
    // Last attempt drops the pin and lets the router pick any capable model. An UNSCORED query is
    // worse data than one graded by a sibling model: it silently becomes a 0 in every percentage.
    const lastChance = i === attempts - 1;
    // Structured output first — the same call, with the shape enforced.
    const structured = await judgeStructured(router, buildPrompt(q, answer, touchedFiles), lastChance ? undefined : opts.model);
    if (structured) return { ...structured, judged: true };
    try {
      const result = await router.route(
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: buildPrompt(q, answer, touchedFiles) },
        ],
        lastChance
          ? { temperature: 0, max_tokens: 300, taskKind: 'chat' as const, exclude: [opts.model] }
          : { model: opts.model, temperature: 0, max_tokens: 300 },
      );
      const text = result.response.choices?.[0]?.message?.content;
      const verdict = parseVerdict(typeof text === 'string' ? text : '');
      if (verdict) return { ...verdict, judged: true };
      lastProblem = 'judge produced no parseable verdict';
    } catch (e) {
      lastProblem = `judge call failed: ${(e as Error).message}`;
    }
    // Back off on EVERY failed attempt, not just thrown ones — an unparseable verdict used to
    // retry instantly against the same model with the same prompt, which mostly failed again.
    if (!lastChance) await new Promise((r) => setTimeout(r, 8_000));
  }
  return { reasoning: 0, answer: 0, rationale: `UNSCORED — ${lastProblem}`, judged: false };
}
