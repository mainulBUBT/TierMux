// taskOutput — the read side of the background-task registry (see taskRegistry.ts). Reading is
// cursor-based: a read remembers the buffer position, so `waitMs` blocks until NEW output lands
// (a dev server that already printed its banner does not make the agent wait 5 s every poll).
// With no taskId it LISTS every task — the model can start a server in turn 3 and must still be
// able to find its id in turn 20 without remembering it.

import { tool } from 'ai';
import { z } from 'zod';
import { capToolOutput } from '../capOutput';
import { taskRegistryFor, formatTaskLine, type BackgroundTask } from '../taskRegistry';

const TAIL_CHARS = 4_000;
const MAX_WAIT_MS = 30_000;
const DEFAULT_WAIT_MS = 5_000;
const POLL_MS = 100;

export interface TaskOutputBindings {
  sessionId?: string;
  requestId?: string;
}

function tail(t: BackgroundTask, registryNow: () => number): string {
  const head = `${formatTaskLine(t, registryNow())}${t.note ? `\n(${t.note})` : ''}`;
  const body = t.buffer ? t.buffer.slice(-TAIL_CHARS) : '(no output yet)';
  const more = t.buffer.length > TAIL_CHARS ? `\n…[oldest ${t.buffer.length - TAIL_CHARS} chars dropped — ring buffer]` : '';
  return `${head}\n${body}${more}`;
}

export function createTaskOutputTool(bindings: TaskOutputBindings = {}) {
  return tool({
    description:
      'Read, list or stop a background task started by runCommand {"background":true} (dev servers, '
      + 'watchers, long builds). With no taskId (or action "list") it lists every background task — '
      + 'call that first when you do not remember the id. "read" waits up to waitMs for NEW output '
      + 'and returns the tail; a still-running task with no new output says so instead of hanging.',
    inputExamples: [
      { input: { taskId: 'bg1' } },
      { input: { action: 'list' } },
      { input: { taskId: 'bg1', action: 'stop' } },
    ],
    inputSchema: z.object({
      taskId: z.string().optional().describe('Task id from runCommand (bg1, bg2, …). Omit to list every background task.'),
      action: z.enum(['read', 'stop', 'list']).optional().describe('"read" (default): tail new output. "stop": kill the task. "list": list all tasks.'),
      waitMs: z.number().optional().describe('How long to wait for new output before returning (max 30000, default 5000).'),
    }),
    execute: async ({ taskId, action, waitMs }, options: { abortSignal?: AbortSignal } = {}): Promise<string | { error: string }> => {
      try {
        const registry = taskRegistryFor(bindings.sessionId);

        if (action === 'list' || (!taskId && !action) || (!taskId && action === 'read')) {
          const all = registry.list();
          if (all.length === 0) return 'No background tasks in this session.';
          return all.map((t) => formatTaskLine(t, Date.now()) + (t.note ? `  — ${t.note}` : '')).join('\n');
        }

        if (!taskId) return { error: 'Missing "taskId" (or pass action:"list" to see every task).' };
        const task = registry.get(taskId);
        if (!task) {
          const known = registry.list().map((t) => t.id).join(', ') || 'none';
          return { error: `Unknown task id "${taskId}". Known tasks: ${known}.` };
        }

        if (action === 'stop') {
          const stopped = registry.stop(taskId);
          return stopped ? `Stopped ${taskId}: ${stopped.command}\n${stopped.buffer ? `Last output:\n${stopped.buffer.slice(-TAIL_CHARS)}` : '(no output)'}` : { error: 'Failed to stop.' };
        }

        // read — wait for output past the cursor, or the process ending, or the wait budget.
        const wait = Math.min(Math.max(waitMs && waitMs > 0 ? waitMs : DEFAULT_WAIT_MS, 0), MAX_WAIT_MS);
        const deadline = Date.now() + wait;
        while (
          task.status === 'running'
          && task.buffer.length <= task.readCursor
          && Date.now() < deadline
          && !options.abortSignal?.aborted
        ) {
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
        // Freshness BEFORE read() advances the cursor to buffer.length.
        const sawNew = task.buffer.length > task.readCursor || task.status !== 'running';
        registry.read(taskId); // advance the cursor + reset the idle clock
        const waitedNote = !sawNew && task.status === 'running' ? '\n[still running — no new output within the wait]' : '';
        return capToolOutput(tail(task, Date.now) + waitedNote, 6_000, 'Read again with a larger waitMs, or narrow the server log.');
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
