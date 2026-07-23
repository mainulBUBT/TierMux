

import * as vscode from 'vscode';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveWorkspacePath } from '../resolvePath';
import { capToolOutput } from '../capOutput';

// A read result is re-sent on every later iteration of the turn, so the ceiling is per-result,
// not per-file. 30K chars (~7.5K tokens) leaves room for the task on small free-tier windows.
// `limit`/`offset` let the model page through a bigger file across calls instead of being stuck
// with a blindly-truncated dump.
const MAX_CHARS = 30_000;
const DEFAULT_LINE_LIMIT = 800;

export function createReadTool() {
  return tool({
    description:
      'Read the text content of a file in the workspace. Large files are paged: by default the '
      + `first ${DEFAULT_LINE_LIMIT} lines are returned — pass "offset" (1-based line) and "limit" to read a later section.`,
    inputSchema: z.object({
      path: z.string().describe('Workspace-relative file path.'),
      offset: z.number().int().positive().optional().describe('1-based line number to start reading from (default 1).'),
      limit: z.number().int().positive().optional().describe(`Maximum number of lines to return (default ${DEFAULT_LINE_LIMIT}).`),
    }),
    execute: async ({ path, offset, limit }: { path: string; offset?: number; limit?: number }) => {
      if (!path) throw new Error('Missing required "path" argument.');
      const uri = resolveWorkspacePath(path);
      let text: string;
      try {
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        throw new Error(`File not found: ${path}`);
      }

      const lines = text.split('\n');
      const start = offset && offset > 0 ? offset - 1 : 0;
      const count = limit && limit > 0 ? limit : DEFAULT_LINE_LIMIT;
      const slice = lines.slice(start, start + count);
      const lastLine = start + slice.length; // 1-based end line actually returned
      let body = slice.join('\n');

      // Tell the model when there's more BELOW the returned window, and exactly how to fetch it.
      if (lastLine < lines.length) {
        body += `\n…[showing lines ${start + 1}–${lastLine} of ${lines.length}. Read again with offset=${lastLine + 1} for more.]`;
      }
      // Secondary guard: a window of very long lines can still blow the char budget.
      return capToolOutput(body, MAX_CHARS, 'Narrow with a smaller "limit" or read a specific range.');
    },
  });
}
