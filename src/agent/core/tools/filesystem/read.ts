

import * as vscode from 'vscode';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveWorkspacePath } from '../resolvePath';

const MAX_CHARS = 100_000;

export function createReadTool() {
  return tool({
    description: 'Read the text content of a file in the workspace.',
    inputSchema: z.object({ path: z.string().describe('Workspace-relative file path.') }),
    execute: async ({ path }: { path: string }) => {
      if (!path) throw new Error('Missing required "path" argument.');
      const uri = resolveWorkspacePath(path);
      let text: string;
      try {
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        throw new Error(`File not found: ${path}`);
      }
      if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + `\n…[truncated, ${text.length} chars total]`;
      return text;
    },
  });
}
