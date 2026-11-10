// todoWrite — task tracking (Claude Code's TodoWrite). The model writes the full list up front
// and updates statuses as it goes; onTodos posts it to the webview. Mutates nothing, so the
// policy treats it as read-only.

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

const tokens = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

function similarity(a: string, b: string): number {
  const [ta, tb] = [tokens(a), tokens(b)];
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared / Math.max(1, Math.min(ta.size, tb.size));
}

/** The list the user sees stays one list. Full replacement let every model, every failover and every
 *  Continue reword, reorder or un-finish it (owner report 2026-11-04: "todo bar bar change hoy"), so
 *  the wording and order of an item stay, a finished item stays finished, and only new work is
 *  appended. Same length with no wording match means the model reworded in place. An empty list clears. */
export function mergeTodos(existing: TodoItem[], incoming: TodoItem[]): TodoItem[] {
  if (!existing.length || !incoming.length) return incoming;
  const unused = new Set(incoming.map((_, i) => i));
  const claim = (item: TodoItem): number | undefined => {
    let best: number | undefined;
    let bestScore = 0.6;
    for (const i of unused) {
      const score = similarity(item.content, incoming[i].content);
      if (score > bestScore || (score === bestScore && best === undefined)) { best = i; bestScore = score; }
    }
    if (best !== undefined) unused.delete(best);
    return best;
  };
  const matches = existing.map(claim);
  if (incoming.length === existing.length) {
    const rest = [...unused];
    matches.forEach((m, i) => {
      if (m === undefined) { matches[i] = rest.shift(); unused.delete(matches[i] as number); }
    });
  }
  const merged = existing.map((item, i) => {
    const m = matches[i];
    if (m === undefined || item.status === 'completed') return item;
    return { content: item.content, status: incoming[m].status };
  });
  return [...merged, ...[...unused].map((i) => incoming[i])];
}

export function createTodoWriteTool(onTodos?: (todos: TodoItem[]) => void, currentTodos?: () => TodoItem[] | undefined) {
  return tool({
    description:
      'Write the task list for the current task. Send every item each time, keeping its wording: the host keeps an existing '
      + "item's wording and position, a completed item stays completed, and items you add are appended. "
      + 'For multi-phase work (several files, or steps whose order matters): list every step as pending, mark ONE as in_progress '
      + 'while working, set completed as each finishes, and never end the turn with items left in_progress. '
      + 'Not for a single focused task, a question, or a few tool calls that are really one step — each call is a round-trip. '
      + 'Send an empty array to clear the list.',
    inputSchema: z.object({
      todos: z.array(
        z.object({
          content: z.string().describe('Short imperative task description ("Fix the login redirect loop").'),
          status: z.enum(['pending', 'in_progress', 'completed']).describe('Current state of this item.'),
        }),
      ).max(MAX_TODOS).describe(`The complete task list (max ${MAX_TODOS}). Include unchanged items, with their wording unchanged.`),
    }),
    execute: async ({ todos }): Promise<string | { error: string }> => {
      try {
        if (todos.length > MAX_TODOS) return { error: `Too many items (max ${MAX_TODOS}).` };
        const blank = todos.findIndex((t) => !t.content || !t.content.trim());
        if (blank !== -1) return { error: `Item ${blank + 1} has empty content — every item needs a description.` };

        const items = mergeTodos(currentTodos?.() ?? [], todos.map((t) => ({
          content: t.content.trim(),
          status: t.status,
        })));
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
