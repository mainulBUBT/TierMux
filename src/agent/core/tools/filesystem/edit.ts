

import { tool } from 'ai';
import { z } from 'zod';
import { getEditGate } from '../gates';
import { resolveWorkspacePath } from '../resolvePath';
import { verifyNoteFor } from '../workspace/formatDiagnostics';

const hunkSchema = z.object({
  search: z.string().describe('Exact existing text to find.'),
  replace: z.string().describe('Text to replace it with.'),
});

/** Exact-string search/replace — no diff library, matches EditGate.edit's existing approach.
 *  Supports two shapes:
 *   - single hunk: { path, search, replace }  (unchanged, backward compatible)
 *   - multi-hunk:  { path, edits: [{ search, replace }, ...] } — patch a whole file in one call.
 *  Multi-hunk reads the file once, applies every hunk in order, and writes once, so multiple
 *  changes to the same file can't race or clobber each other. Prefer `edits` for >1 change. */
export function createEditTool() {
  return tool({
    description:
      'Replace exact blocks of text in a file. You must have read the file this turn (with readFile) before editing — '
      + 'this tool fails on a file you have not read. `search` must match the file content EXACTLY, including whitespace '
      + 'and indentation; readFile output shows `cat -n`-style line numbers — those are annotations, never include them '
      + 'in `search`. For multiple changes in the SAME file, pass `edits: [{search, replace}, ...]` — they apply atomically '
      + 'in one read/write instead of N separate calls. Use the single `search`/`replace` form for a one-off change.',
    inputSchema: z.object({
      path: z.string().describe('Workspace-relative file path.'),
      search: z.string().optional().describe('Exact existing text to find (single-hunk form).'),
      replace: z.string().optional().describe('Text to replace it with (single-hunk form).'),
      edits: z.array(hunkSchema).optional().describe('Ordered list of {search, replace} hunks for multiple changes in one file.'),
    }),
    execute: async (args: { path: string; search?: string; replace?: string; edits?: Array<{ search: string; replace: string }> }) => {
      const { path, search, replace, edits } = args;
      if (!path) throw new Error('Missing required "path" argument.');
      const uri = resolveWorkspacePath(path);
      const gate = getEditGate();
      let result;
      if (Array.isArray(edits) && edits.length > 0) {
        result = await gate.editMultiApproved(uri, edits);
      } else {
        if (!search) throw new Error('Missing required "search" argument (or pass "edits" for multiple hunks).');
        result = await gate.editApproved(uri, search, replace ?? '');
      }
      if (!result.applied) throw new Error(result.error ?? 'Edit was not applied.');
      // Self-correct loop: surface any NEW error diagnostic in the same tool round instead of
      // relying on the model to remember a separate getDiagnostics call at the end of the task.
      return `Edited ${path}.${await verifyNoteFor(uri)}`;
    },
  });
}
