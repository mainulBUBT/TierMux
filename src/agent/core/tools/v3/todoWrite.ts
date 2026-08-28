// v3 todoWrite — task tracking (Claude Code's TodoWrite / Kilo's task list). The model writes
// the full task list up front for multi-step work and updates statuses as it goes; the host's
// onTodos callback posts the list to the webview's TodoSheet/plan card. Mutates NOTHING in the
// workspace — UI state only — so the policy treats it as read-only.
//
// v3 tool contract (see readFile.ts): tool()-form, zod schema with .describe() on every field,
// exception-safe execute (expected failures return { error }), no embedded approval.

import { tool } from 'ai';
import { z } from 'zod';
import type { TodoItem } from '../../../../shared/types';
import { capToolOutput } from '../capOutput';

const MAX_TODOS = 50;

/** The compact confirmation the model reads back — statuses visible so it can plan the next step. */
function confirmation(items: TodoItem[]): string {
  const counts = { completed: 0, in_progress: 0, pending: 0 };
  for (const t of items) counts[t.status]++;
  const mark = (s: TodoItem['status']) => (s === 'completed' ? '[x]' : s === 'in_progress' ? '[~]' : '[ ]');
  const lines = items.slice(0, 30).map((t) => `- ${mark(t.status)} ${t.content}`);
  if (items.length > 30) lines.push(`- … and ${items.length - 30} more`);
  return capToolOutput(
    `Task list updated (${items.length} item${items.length === 1 ? '' : 's'} — ${counts.completed} completed, ${counts.in_progress} in progress, ${counts.pending} pending):\n${lines.join('\n')}`,
    2_000,
  );
}

export function createTodoWriteTool(onTodos?: (todos: TodoItem[]) => void) {
  return tool({
    description:
      'Write the COMPLETE task list for the current task — full replacement, not a delta. '
      + 'Call this BEFORE starting multi-step work (3+ steps): list every step as pending, mark ONE as in_progress '
      + 'while working, set completed as each finishes, and never end the turn with items left in_progress. '
      + 'Send an empty array to clear the list.',
    inputSchema: z.object({
      todos: z.array(
        z.object({
          content: z.string().describe('Short imperative task description ("Fix the login redirect loop").'),
          status: z.enum(['pending', 'in_progress', 'completed']).describe('Current state of this item.'),
          difficulty: z.enum(['easy', 'medium', 'hard']).optional()
            .describe('Step difficulty for model routing; omit when unsure.'),
        }),
      ).max(MAX_TODOS).describe(`The COMPLETE updated task list (max ${MAX_TODOS}). Full replacement — include unchanged items.`),
    }),
    execute: async ({ todos }): Promise<string | { error: string }> => {
      try {
        if (todos.length > MAX_TODOS) return { error: `Too many items (max ${MAX_TODOS}).` };
        const blank = todos.findIndex((t) => !t.content || !t.content.trim());
        if (blank !== -1) return { error: `Item ${blank + 1} has empty content — every item needs a description.` };

        const items: TodoItem[] = todos.map((t) => ({
          content: t.content.trim(),
          status: t.status,
          ...(t.difficulty ? { difficulty: t.difficulty } : {}),
        }));
        try {
          onTodos?.(items);
        } catch {
          // A UI callback failure must never fail the tool — the list itself is still valid.
        }
        return confirmation(items);
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
