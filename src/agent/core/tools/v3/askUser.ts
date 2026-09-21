// askUser — the model asks the user up to four questions on ONE card mid-turn; the host renders
// the card and the turn resumes with the answers.

import { tool } from 'ai';
import { z } from 'zod';
import type { AskQuestion, AskResult, Mode } from '../../../../shared/types';

const MAX_QUESTIONS = 4;

const questionSchema = z.object({
  question: z.string().describe('The question. Clear, specific, concise.'),
  header: z.string().optional().describe('Very short label (about 12 characters) shown as the tab title.'),
  options: z.array(z.string()).max(6).optional().describe('2-4 distinct choices, each written "Label — what it means or costs". Put your recommended choice FIRST. Omit for a free-text answer.'),
  multiSelect: z.boolean().optional().describe('true when several options can apply together.'),
});

/** Single-question and multi-question input both land here. The flat `question`/`options` shape
 *  is the pre-batching contract — models shaped on it keep working. */
function normalize(input: { questions?: AskQuestion[]; question?: string; options?: string[] }): AskQuestion[] {
  const raw = input.questions?.length ? input.questions : input.question ? [{ question: input.question, options: input.options }] : [];
  return raw
    .map((q) => ({
      question: (q.question ?? '').trim(),
      header: q.header?.trim() || undefined,
      options: q.options?.map((o) => o.trim()).filter(Boolean),
      multiSelect: q.multiSelect || undefined,
    }))
    .filter((q) => q.question)
    .slice(0, MAX_QUESTIONS)
    .map((q) => ({ ...q, options: q.options?.length ? q.options : undefined }));
}

const DISMISSED = {
  // Plan mode: a skipped question is an open premise, and a plan carries none — so it is asked
  // again (narrower) or written down as an explicit assumption, never silently guessed.
  plan: 'The user skipped this question. Do not guess: ask ONCE more with narrower options, or state your assumption explicitly in the plan\'s `interpretation`.',
  other: 'The user dismissed the prompt or provided no answer. Proceed with the safest and best technical approach based on the available codebase context.',
} as const;

export function createAskUserTool(onAskUser?: (questions: AskQuestion[]) => Promise<AskResult>, mode?: Mode) {
  return tool({
    description:
      'Ask the user clarifying questions when requirements are ambiguous, underspecified, or a key design '
      + 'decision needs their input before you proceed. Gather EVERY open question first and ask them together '
      + `in ONE call (up to ${MAX_QUESTIONS}); each question may offer 2-4 options with your recommendation first. `
      + 'Do NOT ask what you can determine by reading the codebase.',
    inputSchema: z.object({
      questions: z.array(questionSchema).max(MAX_QUESTIONS).optional().describe(`1-${MAX_QUESTIONS} questions asked together on one card.`),
      question: z.string().optional().describe('Shorthand for a single question (same as questions:[{question, options}]).'),
      options: z.array(z.string()).optional().describe('Options for the shorthand `question`.'),
    }),
    execute: async (input): Promise<string | { error: string }> => {
      try {
        const questions = normalize(input);
        if (!questions.length) return { error: `At least one non-empty question is required — pass \`questions\` (1-${MAX_QUESTIONS}).` };
        if (!onAskUser) return { error: 'Interactive user questioning is not available in this environment.' };
        const result = await onAskUser(questions);
        if (result.status === 'cancelled') return 'The user did not answer — the turn was cancelled.';
        const answered = result.status === 'answered' && result.answers.some((a) => a?.trim());
        if (!answered) return mode === 'plan' ? DISMISSED.plan : DISMISSED.other;
        const answer = (i: number) => result.answers[i]?.trim() || '(no answer)';
        if (questions.length === 1) return `User response: ${answer(0)}`;
        return `User responses:\n${questions.map((q, i) => `${i + 1}. ${q.question} → ${answer(i)}`).join('\n')}`;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
