

import { tool } from 'ai';
import { z } from 'zod';
import { getCommandGate } from '../gates';
import { capToolOutput } from '../capOutput';

// Command output is unbounded at the source (a `cat`, `npm test`, or `find` can emit megabytes)
// and is re-sent on every later iteration — cap it so one noisy command can't evict the task.
const MAX_CHARS = 30_000;

export function createShellTool() {
  return tool({
    description: 'Run a shell command in the workspace and return its output.',
    inputSchema: z.object({
      command: z.string().describe('The shell command to run.'),
      cwd: z.string().optional().describe('Workspace-relative working directory (optional).'),
    }),
    execute: async ({ command, cwd }: { command: string; cwd?: string }) => {
      if (!command) throw new Error('Missing required "command" argument.');
      const result = await getCommandGate().runApproved(command, cwd);
      if (result.error) throw new Error(result.error);
      const body = [result.stdout, result.stderr].filter(Boolean).join('\n---stderr---\n') || '(no output)';
      return capToolOutput(body, MAX_CHARS, 'Re-run piping through head/grep/tail to narrow the output.');
    },
  });
}
