

import * as vscode from 'vscode';
import { tool } from 'ai';
import { z } from 'zod';
import { minimatch } from 'minimatch';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { peekWorkspaceRoot } from '../workspaceRoot';

const MAX_RESULTS = 200;

/** Glob files relative to the workspace root. The main-agent path uses VS Code's `findFiles`
 *  (workspace-bound). A fleet-pipeline worker, however, runs inside `runWithWorkspaceRoot` scoped
 *  to a git worktree — and `findFiles`/`asRelativePath` ignore that override (they only know the
 *  live workspace folder). So when an ALS root is set we walk that directory ourselves with
 *  `minimatch` and return paths relative to the worktree, matching the main path's output shape. */
async function globInRoot(root: string, pattern: string): Promise<string[]> {
  const matches: string[] = [];
  const seen = new Set<string>();
  // Always skip the heavy/vendor dirs a workspace glob wouldn't surface either.
  const SKIP = new Set(['node_modules', '.git', '.tiermux-worktrees']);
  const stack: string[] = [root];
  while (stack.length) {
    if (matches.length >= MAX_RESULTS) break;
    const dir = stack.pop()!;
    let entries: import('fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (matches.length >= MAX_RESULTS) break;
      if (e.isDirectory() && SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (e.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (seen.has(rel)) continue;
      if (minimatch(rel, pattern, { dot: true })) {
        seen.add(rel);
        matches.push(rel);
      }
    }
  }
  return matches;
}

export function createGlobTool() {
  return tool({
    description:
      'Find files in the workspace matching a glob pattern (e.g. "src/**/*.ts"). Prefer this over `listDir` or a shell '
      + '`ls`/`find` when you are looking for files BY NAME or extension — it is faster, cheaper, and returns paths ready '
      + 'to feed readFile. Caps at 200 results; make the pattern more specific rather than paging.',
    inputSchema: z.object({ pattern: z.string().describe('Glob pattern, relative to the workspace root.') }),
    execute: async ({ pattern }: { pattern: string }) => {
      if (!pattern) throw new Error('Missing required "pattern" argument.');
      const override = peekWorkspaceRoot();
      if (override) {
        const list = await globInRoot(override, pattern);
        if (!list.length) return '(no matches)';
        return list.length >= MAX_RESULTS
          ? `${list.join('\n')}\n…[capped at ${MAX_RESULTS} matches — use a more specific pattern to see the rest.]`
          : list.join('\n');
      }
      const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', MAX_RESULTS);
      if (!files.length) return '(no matches)';
      const list = files.map((f) => vscode.workspace.asRelativePath(f)).join('\n');
      // findFiles stops AT the cap, so hitting it means there may be more — tell the model so it
      // narrows the pattern instead of assuming it saw every match.
      return files.length >= MAX_RESULTS
        ? `${list}\n…[capped at ${MAX_RESULTS} matches — use a more specific pattern to see the rest.]`
        : list;
    },
  });
}
