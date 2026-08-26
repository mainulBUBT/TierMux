// v3 writeFile / deleteFile — plain vscode.workspace.fs, exception-safe, approval external.

import * as vscode from 'vscode';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveWorkspacePath } from '../resolvePath';

export function createWriteFileTool() {
  return tool({
    description:
      'Create or overwrite a file with the given text content. Parent directories are created '
      + 'automatically. Prefer editFile for changing part of an existing file.',
    inputSchema: z.object({
      path: z.string().describe('Workspace-relative file path.'),
      content: z.string().describe('Full file content to write.'),
    }),
    execute: async ({ path, content }): Promise<string | { error: string }> => {
      try {
        if (!path) return { error: 'Missing required "path" argument.' };
        const uri = resolveWorkspacePath(path);
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
        return `Wrote ${path}.`;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

export function createDeleteFileTool() {
  return tool({
    description:
      'Delete a file (or an empty directory) in the workspace. Destructive — use only when the '
      + 'task clearly calls for removal.',
    inputSchema: z.object({
      path: z.string().describe('Workspace-relative path to delete.'),
    }),
    execute: async ({ path }): Promise<string | { error: string }> => {
      try {
        if (!path) return { error: 'Missing required "path" argument.' };
        const uri = resolveWorkspacePath(path);
        await vscode.workspace.fs.delete(uri, { useTrash: true });
        return `Deleted ${path}.`;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
