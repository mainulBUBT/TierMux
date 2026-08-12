

import { tool } from 'ai';
import { z } from 'zod';

const optionSchema = z.object({ title: z.string(), description: z.string().optional() });
const questionSchema = z.object({
  text: z.string(),
  label: z.string().optional(),
  options: z.array(optionSchema).optional(),
  multi: z.boolean().optional(),
});

/**
 * Plan mode's pre-flight clarify tool — replaces the old `???QUESTIONS???` text sentinel
 * (still kept as a fallback in clarify.ts for models that ignore this tool). Deliberately has
 * no `execute`: this is the AI SDK's documented "human-in-the-loop" pattern — the model's call
 * pauses the turn instead of auto-running, and loop.ts intercepts it to populate the same
 * clarifyingQuestions UI card the sentinel used to produce.
 *
 * Fields are lenient (.optional()) on purpose: a weak model's call reconstructed by
 * rescueInlineToolCalls from raw text often omits label/description/options entirely — only
 * `text` (per question) and the outer array are required, matching what the old sentinel parser
 * already tolerated.
 */
export function createAskQuestionsTool() {
  return tool({
    description:
      'Ask the user clarifying question(s) before producing a plan — ONLY when something is '
      + 'ambiguous in a way that changes which files/approach to investigate. Not a default step '
      + 'before every plan.',
    inputSchema: z.object({ questions: z.array(questionSchema).min(1) }),
  });
}
