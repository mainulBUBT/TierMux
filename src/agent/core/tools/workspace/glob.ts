

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
      return files.map((f) => vscode.workspace.asRelativePath(f)).join('\n');
    },
  });
}
