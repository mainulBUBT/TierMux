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
      'Run an isolated research sub-agent and get back a short report instead of the files. '
      + 'Use when the answer needs reading more than a few files, a broad search, or a comparison across the codebase — '
      + 'it keeps that exploration out of this context. Not for one or two lookups you can do directly. '
      + 'The sub-agent starts with NO context: write the task as if to a colleague who has never seen this conversation — '
      + 'what to find, where to start, what to return.',
    inputExamples: [
      { input: { task: 'Find every place the session timeout is applied. Start from src/auth/session.ts. Return each path:line, which branch resets it, and under what condition.' } },
    ],
    inputSchema: z.object({
      task: z.string().describe('Self-contained research question: what to find, where to start, what to return.'),
    }),
    execute: async ({ task }): Promise<string | { error: string }> => {
      try {
        if (!task || !task.trim()) {
          return { error: 'A non-empty task description is required for the sub-agent.' };
        }
        const result = await runSubagent({
          task: task.trim(),
          sessionId: bindings.sessionId,
          requestId: bindings.requestId,
          abortSignal: bindings.abortSignal,
        });

        return `### Sub-Agent Investigation Report (${result.stepsCount} steps):\n\n${result.summary}`;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
