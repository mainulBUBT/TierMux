// v3 readFile (plan step 3) — the real tool in tool({inputSchema, execute}) form.
//
// Same behavior as the legacy src/agent/core/tools/filesystem/read.ts (line-numbered
// `<file path>` output, offset/limit paging, batch reads, per-result cap), with the v3
// contract applied: execute() NEVER throws — expected failures come back as `{ error }`
// so the model sees them and self-corrects on the next turn (Path A defense).
//
// Approval: none — readFile is in READ_ONLY_TOOLS; the toolApproval policy auto-approves it.

import * as vscode from 'vscode';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveWorkspacePath } from '../resolvePath';
import { capToolOutput } from '../capOutput';

const MAX_CHARS = 30_000;
const DEFAULT_LINE_LIMIT = 800;
const MAX_PATHS_PER_CALL = 8;

/** Read one file, `cat -n`-style line numbers so the model can cite path:line and derive
 *  exact editFile search strings (which must NOT include the numbers). */
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
  const lastLine = start + slice.length;

  const width = String(lastLine).length;
  const numbered = slice.map((line, i) => `${String(start + i + 1).padStart(width)}\t${line}`);
  let body = `<file path="${path}">\n${numbered.join('\n')}\n</file>`;

  if (lastLine < lines.length) {
    body += `\n…[showing lines ${start + 1}–${lastLine} of ${lines.length}. Read again with offset=${lastLine + 1} for more.]`;
  }
  return body;
}

export function createReadFileTool() {
  return tool({
    description:
      'Read the text content of one or more files in the workspace (pass an array of paths to '
      + 'read several files in a single call). Large files are paged: by default the first '
      + `${DEFAULT_LINE_LIMIT} lines are returned — pass "offset" (1-based line) and "limit" to read `
      + 'a later section (applies to every path in a batch).',
    inputSchema: z.object({
      path: z.union([z.string(), z.array(z.string()).max(MAX_PATHS_PER_CALL)])
        .describe(`Workspace-relative file path, or an array of up to ${MAX_PATHS_PER_CALL} paths to read together.`),
      offset: z.number().int().positive().optional().describe('1-based line number to start reading from (default 1).'),
      limit: z.number().int().positive().optional().describe(`Maximum number of lines to return per file (default ${DEFAULT_LINE_LIMIT}).`),
    }),
    execute: async ({ path, offset, limit }): Promise<string | { error: string }> => {
      try {
        if (!path || (Array.isArray(path) && path.length === 0)) {
          return { error: 'Missing required "path" argument.' };
        }
        const paths = Array.isArray(path) ? path : [path];

        if (paths.length === 1) {
          const body = await readOne(paths[0], offset, limit);
          return capToolOutput(body, MAX_CHARS, 'Narrow with a smaller "limit" or read a specific range.');
        }

        // Batched: cap the COMBINED output so N files share one budget.
        const perFileBudget = Math.floor(MAX_CHARS / paths.length);
        const sections = await Promise.all(paths.map(async (p) => {
          const body = await readOne(p, offset, limit);
          return capToolOutput(body, perFileBudget, `Narrow with a smaller "limit", or read ${p} alone for the full window.`);
        }));
        return sections.join('\n\n');
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
