// readFile — line-numbered `<file path>` output, offset/limit paging, batch reads, per-result
// cap. execute() never throws: expected failures come back as `{ error }`.

import * as vscode from 'vscode';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveWorkspacePath } from '../resolvePath';
import { capToolOutput } from '../capOutput';

const MAX_CHARS = 30_000;
const DEFAULT_LINE_LIMIT = 800;
const MAX_PATHS_PER_CALL = 8;

/** Room left for the `<file …>` wrapper and the trailing paging marker when fitting lines to
 *  a character budget. The marker MUST survive — it is the only thing that tells the model
 *  where to resume. */
const PAGING_MARKER_RESERVE = 240;

/** Read one file with `cat -n`-style line numbers. `charBudget` is enforced HERE on a line
 *  boundary: slicing the result afterwards cut mid-line AND deleted the trailing "read again
 *  with offset=N" marker, so the model had no way to resume (2026-08-30, 42,864-char file). */
async function readOne(
  path: string,
  offset?: number,
  limit?: number,
  charBudget = MAX_CHARS,
): Promise<string> {
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

  const width = String(start + slice.length).length;
  const numbered = slice.map((line, i) => `${String(start + i + 1).padStart(width)}\t${line}`);

  // Fit to the budget on a line boundary. At least one line always ships, even if that single
  // line is itself over budget — returning an empty window would be a worse dead end.
  const lineBudget = Math.max(0, charBudget - path.length - PAGING_MARKER_RESERVE);
  let used = 0;
  let kept = 0;
  while (kept < numbered.length) {
    const next = used + numbered[kept].length + 1;
    if (kept > 0 && next > lineBudget) break;
    used = next;
    kept++;
  }

  const shown = numbered.slice(0, kept);
  const lastLine = start + shown.length;
  let body = `<file path="${path}">\n${shown.join('\n')}\n</file>`;

  if (lastLine < lines.length) {
    const why = kept < slice.length ? 'output size' : 'the line limit';
    body += `\n…[showing lines ${start + 1}–${lastLine} of ${lines.length}, cut by ${why}.`
      + ` Read again with offset=${lastLine + 1} to continue from the next line.]`;
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
          // readOne already fits the budget on a line boundary; capToolOutput stays only as a
          // backstop for a single line longer than the whole budget.
          const body = await readOne(paths[0], offset, limit, MAX_CHARS);
          return capToolOutput(body, MAX_CHARS, 'Narrow with a smaller "limit" or read a specific range.');
        }

        // Batched: cap the COMBINED output so N files share one budget.
        const perFileBudget = Math.floor(MAX_CHARS / paths.length);
        const sections = await Promise.all(paths.map(async (p) => {
          const body = await readOne(p, offset, limit, perFileBudget);
          return capToolOutput(body, perFileBudget, `Narrow with a smaller "limit", or read ${p} alone for the full window.`);
        }));
        return sections.join('\n\n');
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
