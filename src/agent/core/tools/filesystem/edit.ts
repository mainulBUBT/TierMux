

import { tool } from 'ai';
import { z } from 'zod';
import { getEditGate } from '../gates';
import { resolveWorkspacePath } from '../resolvePath';
import { verifyNoteFor } from '../workspace/formatDiagnostics';

/** Exact-string search/replace — no diff library, matches EditGate.edit's existing approach. */
export function createEditTool() {
  return tool({
    description: 'Replace an exact block of text in a file with new text. `search` must match existing file content exactly (including whitespace).',
    inputSchema: z.object({
      path: z.string().describe('Workspace-relative file path.'),
      search: z.string().describe('Exact existing text to find.'),
      replace: z.string().describe('Text to replace it with.'),
    }),
    execute: async ({ path, search, replace }: { path: string; search: string; replace: string }) => {
      if (!path || !search) throw new Error('Missing required "path"/"search" argument.');
      const uri = resolveWorkspacePath(path);
      const result = await getEditGate().editApproved(uri, search, replace);
      if (!result.applied) throw new Error(result.error ?? 'Edit was not applied.');
      // Self-correct loop: surface any NEW error diagnostic in the same tool round instead of
      // relying on the model to remember a separate getDiagnostics call at the end of the task.
      return `Edited ${path}.${await verifyNoteFor(uri)}`;
    },
  });
}
