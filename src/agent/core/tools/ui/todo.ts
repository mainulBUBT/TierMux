

import { tool } from 'ai';
import { z } from 'zod';
import type { TodoItem } from '../../../../shared/types';

export function createTodoWriteTool(onTodos: (todos: TodoItem[]) => void) {
  return tool({
    description:
      'Report your current task todo list (each call REPLACES the previous list). Discipline: for any task past a '
      + 'couple of steps, write the list FIRST — one item per verifiable step; keep EXACTLY ONE item `in_progress`; '
      + 'mark an item `completed` the moment it is done and start the next; add newly discovered steps instead of '
      + 'silently doing them. Do not end your turn while items are still `pending`/`in_progress` — either finish them '
      + 'or say plainly what blocked you. Skip the list entirely for a one-step task.',
    inputSchema: z.object({
      todos: z.array(z.union([
        z.string().transform((content) => ({ content, status: 'pending' as const })),
        z.object({
          content: z.string(),
          status: z.enum(['pending', 'in_progress', 'completed']),
          difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
        }),
      ])).describe('The full current list; plain strings become pending items.'),
    }),
    execute: async ({ todos }: { todos: Array<{ content: string; status: TodoItem['status']; difficulty?: TodoItem['difficulty'] }> }) => {
      const list: TodoItem[] = todos.filter((t) => t.content).map((t) => ({ content: t.content, status: t.status, ...(t.difficulty ? { difficulty: t.difficulty } : {}) }));
      onTodos(list);
      return `Todo list updated (${list.length} items).`;
    },
  });
}
