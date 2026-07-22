

import { tool } from 'ai';
import { z } from 'zod';

/** Interactive user Q&A mid-turn — reuses the existing onAskUser callback/UI card as-is.
 *  Excluded from ask mode's tool set entirely (see tools/index.ts — ask mode gets no tools
 *  at all). Still available in plan mode alongside its own ???QUESTIONS??? text-sentinel
 *  pre-flight clarify channel — the two aren't mutually exclusive there. */
export function createQuestionTool(onAskUser: (question: string, options?: string[]) => Promise<string>) {
  return tool({
    description: 'Ask the user a clarifying question before continuing.',
    inputSchema: z.object({
      question: z.string().describe('The question to ask the user.'),
      options: z.array(z.string()).optional().describe('Optional suggested answers.'),
    }),
    execute: async ({ question, options }: { question: string; options?: string[] }) => {
      if (!question) throw new Error('Missing required "question" argument.');
      const answer = await onAskUser(question, options);
      return answer || '(user gave no answer)';
    },
  });
}
