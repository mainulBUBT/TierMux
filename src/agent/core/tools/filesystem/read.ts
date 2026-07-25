

import * as vscode from 'vscode';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveWorkspacePath } from '../resolvePath';
import { capToolOutput } from '../capOutput';

// A read result is re-sent on every later iteration of the turn, so the ceiling is per-result,
// not per-file. 30K chars (~7.5K tokens) leaves room for the task on small free-tier windows.
// `limit`/`offset` let the model page through a bigger file across calls instead of being stuck
// with a blindly-truncated dump.
const MAX_CHARS = 30_000;
const DEFAULT_LINE_LIMIT = 800;
// Batch cap: enough for a real multi-file investigation (see all N callers of a function in one
// round-trip) without one call turning into a full-repo dump that blows the shared MAX_CHARS
// budget before any single file gets a useful slice.
const MAX_PATHS_PER_CALL = 8;

/** Read one file, applying the same offset/limit windowing every path in a batched call shares. */
async function readOne(path: string, offset?: number, limit?: number): Promise<string> {
  const uri = resolveWorkspacePath(path);
  let text: string;
  try {
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return `File not found: ${path}`;
  }

  const lines = text.split('\n');
  const start = offset && offset > 0 ? offset - 1 : 0;
  const count = limit && limit > 0 ? limit : DEFAULT_LINE_LIMIT;
  const slice = lines.slice(start, start + count);
  const lastLine = start + slice.length; // 1-based end line actually returned
  let body = slice.join('\n');

  // Tell the model when there's more BELOW the returned window, and exactly how to fetch it.
  if (lastLine < lines.length) {
    body += `\n…[showing lines ${start + 1}–${lastLine} of ${lines.length}. Read again with offset=${lastLine + 1} for more.]`;
  }
  return body;
}

export function createReadTool() {
  return tool({
    description:
      'Read the text content of one or more files in the workspace (pass an array of paths to '
      + `read several files in a single call — prefer this over one readFile call per file when `
      + `you already know all the paths you need, e.g. every caller of a function). Large files `
      + `are paged: by default the first ${DEFAULT_LINE_LIMIT} lines are returned — pass "offset" `
      + '(1-based line) and "limit" to read a later section (applies to every path in a batch).',
    inputSchema: z.object({
      path: z.union([z.string(), z.array(z.string()).max(MAX_PATHS_PER_CALL)])
        .describe(`Workspace-relative file path, or an array of up to ${MAX_PATHS_PER_CALL} paths to read together.`),
      offset: z.number().int().positive().optional().describe('1-based line number to start reading from (default 1).'),
      limit: z.number().int().positive().optional().describe(`Maximum number of lines to return per file (default ${DEFAULT_LINE_LIMIT}).`),
    }),
    execute: async ({ path, offset, limit }: { path: string | string[]; offset?: number; limit?: number }) => {
      if (!path || (Array.isArray(path) && path.length === 0)) throw new Error('Missing required "path" argument.');
      const paths = Array.isArray(path) ? path : [path];

      if (paths.length === 1) {
        // Single-file path: same per-result cap as before, no header noise.
        const body = await readOne(paths[0], offset, limit);
        return capToolOutput(body, MAX_CHARS, 'Narrow with a smaller "limit" or read a specific range.');
      }

      // Batched: cap the COMBINED output, not per-file, so N files share one budget instead of
      // each independently claiming the full MAX_CHARS (which would make a batch call worse than
      // N separate calls instead of better).
      const perFileBudget = Math.floor(MAX_CHARS / paths.length);
      const sections = await Promise.all(paths.map(async (p) => {
        const body = await readOne(p, offset, limit);
        return `=== ${p} ===\n${capToolOutput(body, perFileBudget, `Narrow with a smaller "limit", or read ${p} alone for the full window.`)}`;
      }));
      return sections.join('\n\n');
    },
  });
}
