

import { tool } from 'ai';
import { z } from 'zod';
import { getEditGate } from '../gates';
import { resolveWorkspacePath } from '../resolvePath';

/** Covers both `writeFile` (overwrite/create) and `createFile` (must not already exist) — same
 *  tool names chatViewProvider.ts's FILE_WRITE_TOOL_NAMES already expects for checkpoint/UI
 *  handling, so no chatViewProvider change is needed. */
export function createWriteFileTool(createOnly: boolean) {
  return tool({
    description: createOnly
      ? 'Create a new file with the given content. Fails if the file already exists.'
      : 'Write content to a file, creating it if needed or overwriting it if it exists.',
    inputSchema: z.object({
      path: z.string().describe('Workspace-relative file path.'),
      content: z.string().describe('Full file content to write.'),
    }),
    execute: async ({ path, content }: { path: string; content: string }) => {
      if (!path) throw new Error('Missing required "path" argument.');
      const uri = resolveWorkspacePath(path);
      const gate = getEditGate();
      const result = createOnly ? await gate.createApproved(uri, content) : await gate.writeApproved(uri, content);
      if (!result.applied) throw new Error(result.error ?? 'Edit was not applied.');
      return `Wrote ${path}.`;
    },
  });
}
