// v3 askUser — interactive user questions and option selection.
//
// When requirements are ambiguous, underspecified, or when key design choices
// require user feedback, the model calls askUser with a question and optional choices.
// The host renders an in-chat card and awaits the user's input/selection.

import { tool } from 'ai';
import { z } from 'zod';

export function createAskUserTool(onAskUser?: (question: string, options?: string[]) => Promise<string>) {
  return tool({
    description:
      'Ask the user a clarifying question or present multiple-choice options when requirements are ambiguous, '
      + 'underspecified, or when a key design/implementation decision requires user feedback before proceeding. '
      + 'Do NOT ask trivial questions that can be determined by reading codebase files.',
    inputSchema: z.object({
      question: z.string().describe('The question to ask the user. Be clear, specific, and concise.'),
      options: z.array(z.string()).optional().describe('Optional list of 2-5 distinct selectable choices for the user.'),
    }),
    execute: async ({ question, options }): Promise<string | { error: string }> => {
      try {
        if (!question || !question.trim()) {
          return { error: 'A non-empty question is required.' };
        }
        if (!onAskUser) {
          return { error: 'Interactive user questioning is not available in this environment.' };
        }
        const cleanOptions = options?.map((o) => o.trim()).filter(Boolean);
        const answer = await onAskUser(question.trim(), cleanOptions && cleanOptions.length > 0 ? cleanOptions : undefined);
        if (!answer || !answer.trim()) {
          return 'The user dismissed the prompt or provided no answer. Proceed with the safest and best technical approach based on the available codebase context.';
        }
        return `User response: ${answer.trim()}`;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
