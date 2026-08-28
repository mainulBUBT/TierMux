// v3 writeFile / deleteFile — plain vscode.workspace.fs, exception-safe, approval external.
// Both append the shared post-mutation diagnostics note (see editFile.ts's diagnosticsNote) so
// a file the language servers newly break — including cross-file breaks from a delete — is
// visible to the model in the same turn.

import * as vscode from 'vscode';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveWorkspacePath } from '../resolvePath';
import { workspaceErrorSignatures } from '../workspace/formatDiagnostics';
import { diagnosticsNote } from './editFile';
import type { ToolsetBindings } from './index';

/** Checkpoint baseline BEFORE mutating (timing is the whole point — see ToolsetBindings). */
async function recordBaseline(bindings: ToolsetBindings, uri: vscode.Uri): Promise<void> {
  try {
    let before: string | null = null;
    try { before = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { /* create */ }
    bindings.onBeforeWrite?.(uri, before);
  } catch { /* checkpointing must never block a write */ }
}

export function createWriteFileTool(bindings: ToolsetBindings = {}) {
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
        let before = new Set<string>();
        try { before = workspaceErrorSignatures(vscode.languages.getDiagnostics()); } catch { /* unavailable */ }
        await recordBaseline(bindings, uri);
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
        return `Wrote ${path}.${await diagnosticsNote(uri, before)}`;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

export function createDeleteFileTool(bindings: ToolsetBindings = {}) {
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
        let before = new Set<string>();
        try { before = workspaceErrorSignatures(vscode.languages.getDiagnostics()); } catch { /* unavailable */ }
        await recordBaseline(bindings, uri);
        await vscode.workspace.fs.delete(uri, { useTrash: true });
        return `Deleted ${path}.${await diagnosticsNote(uri, before)}`;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
