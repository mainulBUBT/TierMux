

import * as vscode from 'vscode';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveWorkspacePath } from '../resolvePath';
import { capToolOutput } from '../capOutput';

// A directory can hold thousands of entries (e.g. a build output dir) — cap so listing one
// doesn't flood the context that every later iteration re-sends.
const MAX_CHARS = 10_000;

export function createListDirTool() {
  return tool({
    description: 'List the files and folders directly inside a workspace directory.',
    inputSchema: z.object({ path: z.string().optional().describe('Workspace-relative directory path (empty for the workspace root).') }),
    execute: async ({ path }: { path?: string }) => {
      const uri = resolveWorkspacePath(path ?? '');
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(uri);
      } catch {
        throw new Error(`Directory not found: ${path || '.'}`);
      }
      const lines = entries.map(([name, type]) => (type === vscode.FileType.Directory ? name + '/' : name));
      return lines.length ? capToolOutput(lines.join('\n'), MAX_CHARS, 'List a specific subdirectory to narrow.') : '(empty directory)';
    },
  });
}
