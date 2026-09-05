// editFile — search/replace edits.
//   - No approval inside the tool: the streamText `toolApproval` policy decides IF it runs.
//   - Exception-safe: every failure returns { error } instead of throwing, so the model sees
//     the reason and self-corrects (a throw would end as a tool-error part — also survivable,
//     but a structured result is the v3 contract for EXPECTED failures).
//   - The matching tiers are kept verbatim in ./editMatch (exact-unique → whitespace-tolerant
//     → re-indent), extracted from applyEdit.ts so src/edits/** can be deleted in step 10.

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

/** Post-edit verify note: errors the language servers report AFTER this edit that weren't there
 *  before it (pre-existing problems are excluded via the before/after diff). Kilo-style in-tool
 *  feedback — the note rides in the tool RESULT; the model decides what to do with it. The whole
 *  check is failure-isolated: a host without a diagnostics API must never turn a successful edit
 *  into an error. */
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
            // WHICH hunk failed, and that none were written. Without the index a model holding
            // five hunks got one bare "not found" and had to guess which to fix; without the
            // "no changes written" half it could not tell whether to re-send all five or the
            // remainder (hunks apply to an in-memory copy and the file is written once, below,
            // so a mid-list failure leaves the file untouched).
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
