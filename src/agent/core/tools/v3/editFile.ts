// v3 editFile (plan step 3) — the real tool in tool({inputSchema, execute}) form.
//
// Differences from the legacy src/agent/core/tools/filesystem/edit.ts:
//   - NO EditGate: approval moved out of the tool into the streamText `toolApproval` policy
//     (v3's division of labor). The tool applies or explains — the policy decides IF.
//   - Exception-safe: every failure returns { error } instead of throwing, so the model sees
//     the reason and self-corrects (a throw would end as a tool-error part — also survivable,
//     but a structured result is the v3 contract for EXPECTED failures).
//   - The matching tiers are kept verbatim in ./editMatch (exact-unique → whitespace-tolerant
//     → re-indent), extracted from applyEdit.ts so src/edits/** can be deleted in step 10.

import * as vscode from 'vscode';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveWorkspacePath } from '../resolvePath';
import { applyHunk } from './editMatch';

const hunkSchema = z.object({
  search: z.string().describe('Exact existing text to find.'),
  replace: z.string().describe('Text to replace it with.'),
});

export function createEditFileTool() {
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

        for (const hunk of hunks) {
          const next = applyHunk(text, hunk.search, hunk.replace);
          if ('error' in next) return { error: next.error };
          text = next.text;
        }

        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
        return `Edited ${path}.`;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
