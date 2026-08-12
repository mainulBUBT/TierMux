

import { tool } from 'ai';
import { z } from 'zod';
import { appendUserMemory } from '../../../../context/userMemory';

export function createRememberTool() {
  return tool({
    description:
      'Save a short, durable note about the user or project to long-term memory, to persist across future conversations. Use for stable facts/preferences learned mid-conversation (e.g. a correction, a project convention, a recurring instruction) — not for task-scoped or one-off details.',
    inputSchema: z.object({
      note: z
        .string()
        .min(1)
        .max(280)
        .describe("One concise line to remember, written so it stands alone without today's conversation context."),
    }),
    execute: async ({ note }: { note: string }) => {
      const saved = await appendUserMemory(note);
      if (!saved) return 'Did not save — either already remembered, or no workspace folder is open.';
      return `Remembered: ${note}`;
    },
  });
}
