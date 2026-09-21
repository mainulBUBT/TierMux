// The user's answers during plan mode, kept so the plan card, the saved plan file and the
// execution prompt can all say what was settled. Pure: the host owns the session state.

import type { AskQuestion, AskResult, PlanDecision } from '../shared/types';

const MAX_DECISIONS = 12;
const NO_ANSWER = '(no answer)';

/** Fold one answered askUser call into the running list. A skipped/cancelled call adds nothing;
 *  re-answering the same question replaces the earlier answer; the newest MAX_DECISIONS stay. */
export function addDecisions(existing: PlanDecision[], questions: AskQuestion[], result: AskResult): PlanDecision[] {
  if (result.status !== 'answered') return existing;
  const next = existing.slice();
  questions.forEach((q, i) => {
    const answer = result.answers[i]?.trim();
    if (!answer || answer === NO_ANSWER) return;
    const at = next.findIndex((d) => d.question === q.question);
    if (at >= 0) next.splice(at, 1);
    next.push({ question: q.question, answer });
  });
  return next.slice(-MAX_DECISIONS);
}

/** Prompt block for the execution turn — undefined when nothing was decided. */
export function formatDecisionsForPrompt(decisions: PlanDecision[]): string | undefined {
  if (!decisions.length) return undefined;
  return `Settled with the user while planning — do not re-ask or override these:\n${decisions.map((d) => `- ${d.question} → ${d.answer}`).join('\n')}`;
}
