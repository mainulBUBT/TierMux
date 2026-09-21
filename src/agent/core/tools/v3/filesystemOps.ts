// v3 writeFile / deleteFile — plain vscode.workspace.fs, exception-safe, approval external.
// Both append the shared post-mutation diagnostics note (see editFile.ts's diagnosticsNote) so
// a file the language servers newly break — including cross-file breaks from a delete — is
// visible to the model in the same turn.

import * as vscode from 'vscode';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveWorkspacePath, resolveReadablePath } from '../resolvePath';
import { visibleFileState } from './visibleRead';
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
      + 'automatically. To replace an existing file you must have its CURRENT full content in view '
      + '(read whole with readFile, not paged or elided) — otherwise the call is refused. Prefer '
      + 'editFile for changing part of an existing file.',
    inputSchema: z.object({
      path: z.string().describe('Workspace-relative file path.'),
      content: z.string().describe('Full file content to write.'),
    }),
    execute: async ({ path, content }, options): Promise<string | { error: string }> => {
      try {
        if (!path) return { error: 'Missing required "path" argument.' };
        const uri = resolveWorkspacePath(path);
        let existing: string | null = null;
        try { existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { /* create */ }
        // A full overwrite is only safe from a verbatim, current copy. The transcript is what the
        // model actually sees (aged/pruned already), so a read that was stubbed or is stale fails.
        const messages = options?.messages;
        if (existing && messages) {
          const target = uri.toString();
          const same = (p: string) => { try { return resolveReadablePath(p).toString() === target; } catch { return false; } };
          const seen = visibleFileState(messages, existing, same);
          if (seen.kind !== 'match') {
            const lines = existing.split('\n').length;
            const why = seen.kind === 'stale' ? 'has changed since you read it' : 'is not in view (never read, paged, or elided)';
            return {
              error: `${path} already exists and ${why}, so writeFile would replace content you cannot see. `
                + (lines > 800
                  ? `It has ${lines} lines — too large to rewrite blind; use editFile for the change.`
                  : `Call readFile on "${path}" (whole file), then resend writeFile with the complete intended content — or use editFile for a partial change.`),
            };
          }
        }
        let before = new Set<string>();
        try { before = workspaceErrorSignatures(vscode.languages.getDiagnostics()); } catch { /* unavailable */ }
        try { bindings.onBeforeWrite?.(uri, existing); } catch { /* checkpointing must never block a write */ }
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
