

import { tool } from 'ai';
import { z } from 'zod';
import type { TodoItem } from '../../../../shared/types';

export function createTodoWriteTool(onTodos: (todos: TodoItem[]) => void) {
  return tool({
    description: 'Report the current task todo list (replaces the previous list).',
    inputSchema: z.object({
      todos: z.array(z.object({
        content: z.string(),
        status: z.enum(['pending', 'in_progress', 'completed']),
      })),
    }),
    execute: async ({ todos }: { todos: Array<{ content: string; status: TodoItem['status'] }> }) => {
      const list: TodoItem[] = todos.filter((t) => t.content).map((t) => ({ content: t.content, status: t.status }));
      onTodos(list);
      return `Todo list updated (${list.length} items).`;
    },
  });
}
