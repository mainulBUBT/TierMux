// v3 delegateTask — delegate heavy/multi-file research to an isolated sub-agent.
// Keeps the main conversation context clean and saves ~85-95% token usage on research passes.

import { tool } from 'ai';
import { z } from 'zod';
import { runSubagent } from '../../subagent';

export interface DelegateBindings {
  sessionId?: string;
  requestId?: string;
  abortSignal?: AbortSignal;
}

export function createDelegateTaskTool(bindings: DelegateBindings = {}) {
  return tool({
    description:
      'Spawn an isolated research sub-agent to investigate a specific codebase question, audit multiple files, '
      + 'or perform deep research without polluting the main conversation history. '
      + 'The sub-agent explores files and returns a synthesized summary with relevant file paths and code lines.',
    inputSchema: z.object({
      task: z.string().describe('The specific research or investigation question to answer.'),
      context: z.string().optional().describe('Optional focal file paths, symbols, or background hints to guide the sub-agent.'),
      maxSteps: z.number().int().min(1).max(15).optional().describe('Optional step cap for the sub-agent (default 8).'),
    }),
    execute: async ({ task, context, maxSteps }): Promise<string | { error: string }> => {
      try {
        if (!task || !task.trim()) {
          return { error: 'A non-empty task description is required for the sub-agent.' };
        }
        const result = await runSubagent({
          task: task.trim(),
          context: context?.trim(),
          sessionId: bindings.sessionId,
          requestId: bindings.requestId,
          abortSignal: bindings.abortSignal,
          maxSteps,
        });

        return `### Sub-Agent Investigation Report (${result.stepsCount} steps):\n\n${result.summary}`;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
