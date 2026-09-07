// v3 delegateTask — delegate heavy/multi-file research to an isolated sub-agent.
// Keeps the main conversation context clean and saves ~85-95% token usage on research passes.

import { tool } from 'ai';
import { z } from 'zod';
import { runSubagent } from '../../subagent';
import { loadAgents } from '../../../agents';
import { effectiveRootUri } from '../workspaceRoot';

function workspaceRootOrUndefined(): string | undefined {
  try { return effectiveRootUri().fsPath; } catch { return undefined; }
}

export interface DelegateBindings {
  sessionId?: string;
  requestId?: string;
  abortSignal?: AbortSignal;
}

export function createDelegateTaskTool(bindings: DelegateBindings = {}) {
  const agents = [...loadAgents(workspaceRootOrUndefined()).values()].filter((a) => !a.internal);
  const roster = agents.map((a) => `- \`${a.name}\`: ${a.description}`).join('\n');
  const names = agents.map((a) => a.name);
  return tool({
    description:
      'Run an isolated sub-agent and get back a short report instead of the files. '
      + 'Use when the answer needs reading more than a few files, a broad search, or a comparison across the codebase — '
      + 'it keeps that exploration out of this context. Not for one or two lookups you can do directly. '
      + 'The sub-agent starts with NO context: write the task as if to a colleague who has never seen this conversation — '
      + `what to find, where to start, what to return.\n\nAgents:\n${roster}`,
    inputExamples: [
      { input: { task: 'Find every place the session timeout is applied. Start from src/auth/session.ts. Return each path:line, which branch resets it, and under what condition.' } },
      { input: { agent: 'review', task: 'Review the uncommitted change in src/cache/. Report defects by severity with the input that triggers each.' } },
    ],
    inputSchema: z.object({
      task: z.string().describe('Self-contained instruction: what to find, where to start, what to return.'),
      agent: z.enum(names as [string, ...string[]]).optional().describe('Which agent to run (default: explore).'),
    }),
    execute: async ({ task, agent }): Promise<string | { error: string }> => {
      try {
        if (!task || !task.trim()) {
          return { error: 'A non-empty task description is required for the sub-agent.' };
        }
        const result = await runSubagent({
          task: task.trim(),
          agent,
          sessionId: bindings.sessionId,
          requestId: bindings.requestId,
          abortSignal: bindings.abortSignal,
        });
        return `### Sub-agent report — ${result.agent} (${result.stepsCount} steps):\n\n${result.summary}`;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
