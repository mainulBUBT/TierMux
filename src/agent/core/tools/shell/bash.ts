

import { tool } from 'ai';
import { z } from 'zod';
import { getCommandGate } from '../gates';
import { capToolOutput } from '../capOutput';

// Command output is unbounded at the source (a `cat`, `npm test`, or `find` can emit megabytes)
// and is re-sent on every later iteration — cap it so one noisy command can't evict the task.
const MAX_CHARS = 30_000;

export function createShellTool() {
  return tool({
    description: 'Run a shell command in the workspace and return its output. Commands are killed '
      + 'and reported back after the default timeout (commonly ~2 minutes) — for a command known to '
      + 'take longer (package installs, builds, test suites), pass `timeoutMs` up front instead of '
      + 'letting it get killed and retrying.',
    inputSchema: z.object({
      command: z.string().describe('The shell command to run.'),
      cwd: z.string().optional().describe('Workspace-relative working directory (optional).'),
      timeoutMs: z.number().optional().describe('Override the default timeout for this command, in milliseconds (capped at 600000 / 10 min). Use for installs/builds/test runs expected to take longer than the default.'),
    }),
    execute: async ({ command, cwd, timeoutMs }: { command: string; cwd?: string; timeoutMs?: number }) => {
      if (!command) throw new Error('Missing required "command" argument.');
      const result = await getCommandGate().runApproved(command, cwd, undefined, timeoutMs);
      const out = [result.stdout, result.stderr].filter(Boolean).join('\n---stderr---\n');

      // Throw ONLY when there is genuinely nothing to report — declined, disabled, or a spawn
      // failure. A TIMEOUT used to throw as well, which discarded every byte the command had
      // already printed: `commandGate` returns its partial stdout/stderr alongside `error`, and
      // the old `if (result.error) throw` ran first. That destroyed the output on exactly the
      // call most likely to need it (a long test/build run that ran out of time).
      if (result.error && !out) throw new Error(result.error);

      // The exit code is the entire point of running a verification command, and it was being
      // dropped on the floor — `CommandResult.exitCode` was never read. `tsc --noEmit` exiting 2,
      // a failing test suite, a linter with `--quiet`, `grep -q` finding nothing: all of them
      // looked identical to success, and a quiet failure returned a bare "(no output)". That also
      // silently defeated VERIFY_TOOLS in loop.ts, which treats a completed `runCommand` as
      // post-mutation verification — so "I ran the tests" counted as verified even when they failed.
      const notes: string[] = [];
      if (result.error) notes.push(result.error);
      else if (result.exitCode !== 0 && result.exitCode !== null) notes.push(`Exit code: ${result.exitCode} (command FAILED)`);
      // commandGate caps each stream at 10KB before this tool ever sees it, so capToolOutput's
      // own MAX_CHARS ceiling can never fire and its recovery hint was dead code. Surface the
      // hint off the gate's own truncation marker instead, so the model learns how to narrow it.
      if (out.includes('[output truncated]')) notes.push('Output was truncated — re-run piping through head/grep/tail to narrow it');

      const body = (out || '(no output)') + (notes.length ? `\n\n[${notes.join(' | ')}]` : '');
      return capToolOutput(body, MAX_CHARS, 'Re-run piping through head/grep/tail to narrow the output.');
    },
  });
}
