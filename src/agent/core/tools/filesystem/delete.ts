

import { tool } from 'ai';
import { z } from 'zod';
import { getEditGate } from '../gates';
import { resolveWorkspacePath } from '../resolvePath';

export function createDeleteTool() {
  return tool({
    description: 'Delete a file from the workspace.',
    inputSchema: z.object({ path: z.string().describe('Workspace-relative file path.') }),
    execute: async ({ path }: { path: string }) => {
      if (!path) throw new Error('Missing required "path" argument.');
      const uri = resolveWorkspacePath(path);
      const result = await getEditGate().removeApproved(uri);
      if (!result.applied) throw new Error(result.error ?? 'Delete was not applied.');
      return `Deleted ${path}.`;
    },
  });
}
