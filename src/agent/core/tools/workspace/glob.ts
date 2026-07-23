

import * as vscode from 'vscode';
import { tool } from 'ai';
import { z } from 'zod';

const MAX_RESULTS = 200;

export function createGlobTool() {
  return tool({
    description: 'Find files in the workspace matching a glob pattern (e.g. "src/**/*.ts").',
    inputSchema: z.object({ pattern: z.string().describe('Glob pattern, relative to the workspace root.') }),
    execute: async ({ pattern }: { pattern: string }) => {
      if (!pattern) throw new Error('Missing required "pattern" argument.');
      const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', MAX_RESULTS);
      if (!files.length) return '(no matches)';
      const list = files.map((f) => vscode.workspace.asRelativePath(f)).join('\n');
      // findFiles stops AT the cap, so hitting it means there may be more — tell the model so it
      // narrows the pattern instead of assuming it saw every match.
      return files.length >= MAX_RESULTS
        ? `${list}\n…[capped at ${MAX_RESULTS} matches — use a more specific pattern to see the rest.]`
        : list;
    },
  });
}
