// editFile — search/replace edits. No approval inside the tool (the toolApproval policy
// decides); expected failures return { error } so the model can self-correct; the matching
// tiers live in ./editMatch.

import * as vscode from 'vscode';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveWorkspacePath } from '../resolvePath';
import type { ToolsetBindings } from './index';
import { applyHunk } from './editMatch';
import {
  NEW_DIAGNOSTICS_MARKER,
  newErrorsSince,
  waitForDiagnosticsSettled,
  workspaceErrorSignatures,
} from '../workspace/formatDiagnostics';

/** Post-edit note: NEW language-server errors after this edit (pre-existing ones excluded).
 *  Rides in the tool result; failure-isolated so a host without diagnostics never turns a
 *  successful edit into an error. */
export async function diagnosticsNote(uri: vscode.Uri, before: Set<string>): Promise<string> {
  try {
    await waitForDiagnosticsSettled(uri, 1200);
    const fresh = newErrorsSince(before, vscode.languages.getDiagnostics());
    if (fresh.length) return `\n\n${NEW_DIAGNOSTICS_MARKER}\n${fresh.slice(0, 10).join('\n')}`;
  } catch {
    // diagnostics unavailable (headless/e2e mock) — plain success result
  }
  return '';
}

const hunkSchema = z.object({
  search: z.string().describe('Exact existing text to find.'),
  replace: z.string().describe('Text to replace it with.'),
});

export function createEditFileTool(bindings: ToolsetBindings = {}) {
  return tool({
    description:
      'Replace exact blocks of text in a file. `search` must match the file content EXACTLY, '
      + 'including whitespace and indentation; readFile output shows `cat -n`-style line numbers — '
      + 'those are annotations, never include them in `search`. For multiple changes in the SAME '
      + 'file, pass `edits: [{search, replace}, ...]` — they apply atomically in one read/write. '
      + 'Use the single `search`/`replace` form for a one-off change.',
    inputSchema: z.object({
      path: z.string().describe('Workspace-relative file path.'),
      search: z.string().optional().describe('Exact existing text to find (single-hunk form).'),
      replace: z.string().optional().describe('Text to replace it with (single-hunk form).'),
      edits: z.array(hunkSchema).optional().describe('Ordered list of {search, replace} hunks for multiple changes in one file.'),
    }),
    execute: async ({ path, search, replace, edits }): Promise<string | { error: string }> => {
      try {
        if (!path) return { error: 'Missing required "path" argument.' };
        const hunks = Array.isArray(edits) && edits.length > 0
          ? edits
          : search !== undefined
            ? [{ search, replace: replace ?? '' }]
            : undefined;
        if (!hunks) return { error: 'Missing required "search" argument (or pass "edits" for multiple hunks).' };

        const uri = resolveWorkspacePath(path);
        let text: string;
        try {
          text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        } catch {
          return { error: `File not found: ${path}` };
        }
        // Checkpoint baseline BEFORE mutating (timing is the whole point — see ToolsetBindings).
        try { bindings.onBeforeWrite?.(uri, text); } catch { /* checkpointing must never block an edit */ }

        // Baseline snapshot BEFORE mutating, so the note can name only NEWLY introduced errors.
        let before = new Set<string>();
        try { before = workspaceErrorSignatures(vscode.languages.getDiagnostics()); } catch { /* unavailable */ }

        for (let i = 0; i < hunks.length; i++) {
          const next = applyHunk(text, hunks[i].search, hunks[i].replace);
          if ('error' in next) {
            // WHICH hunk failed, and that none were written (hunks apply to an in-memory copy;
            // the file is written once below), so the model knows to re-send all of them.
            const where = hunks.length > 1 ? `Hunk ${i + 1} of ${hunks.length} failed: ` : '';
            const rollback = hunks.length > 1 ? ' No changes were written — re-send all hunks once this one is fixed.' : '';
            return { error: `${where}${next.error}${rollback}` };
          }
          text = next.text;
        }

        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
        return `Edited ${path}.${await diagnosticsNote(uri, before)}`;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
