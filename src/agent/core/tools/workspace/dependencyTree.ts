

import * as vscode from 'vscode';
import { tool } from 'ai';
import { z } from 'zod';
import { getWorkspaceIndex } from '../indexAccess';
import { incSymbolHit } from '../../../../context/telemetry';
import { capToolOutput } from '../capOutput';

const MAX_CHARS = 4 * 1024;
const MAX_DEPTH = 4;

/** getDependencyTree — the workspace import graph. Answers the two questions that otherwise take
 *  many grep/glob/readFile loops: "what does this file rely on?" (dependencies) and "what breaks
 *  if I change this file?" (dependents). Built from regex-extracted imports resolved to graph
 *  keys, so it's instant once a file is indexed and re-indexed live by the FileSystemWatcher. */
export function createDependencyTreeTool() {
  return tool({
    description:
      'Show a file\'s dependency graph: the files it IMPORTS (dependencies), or the files that IMPORT it (dependents). '
      + 'Use this to assess the blast radius of a change (dependents) or what a module relies on (dependencies) '
      + 'INSTEAD of grepping for import statements. Resolves relative imports across JS/TS, PHP, Python, and Go. '
      + 'Only currently-indexed/open files are covered; untouched files are read on demand.',
    inputSchema: z.object({
      path: z.string().describe('Workspace-relative file path.'),
      direction: z.enum(['dependents', 'dependencies', 'both']).optional().describe('"dependents" = what imports this file (blast radius); "dependencies" = what this file imports; "both" = both. Default "both".'),
      depth: z.number().optional().describe('Graph depth for "dependencies" walks (default 1, max 4). Dependents are always 1 level.'),
    }),
    execute: async ({ path, direction, depth }: { path: string; direction?: 'dependents' | 'dependencies' | 'both'; depth?: number }) => {
      if (!path) throw new Error('Missing required "path" argument.');
      getWorkspaceIndex(); // ensure initialized (throws clearly if not, like other tools)
      const rel = toWorkspaceRelative(path);
      const dir = direction ?? 'both';
      const d = Math.min(Math.max(depth ?? 1, 1), MAX_DEPTH);
      const idx = getWorkspaceIndex();

      const sections: string[] = [];
      if (dir === 'dependents' || dir === 'both') {
        const deps = await idx.dependentsOf(rel, 1);
        if (deps.length) {
          incSymbolHit();
          sections.push(`Dependents (${deps.length} — files that import ${rel}, i.e. blast radius):`);
          sections.push(deps.map((e) => `  ← ${e.path}`).join('\n'));
        } else {
          sections.push(`Dependents: none indexed (nothing imports ${rel}).`);
        }
      }
      if (dir === 'dependencies' || dir === 'both') {
        const deps = await idx.dependenciesOf(rel, d);
        if (deps.length) {
          incSymbolHit();
          sections.push(`Dependencies (depth ${d} — what ${rel} imports):`);
          sections.push(deps.map((e) => `  → ${e.path}`).join('\n'));
        } else {
          sections.push(`Dependencies: none resolved (this file imports nothing tracked, or its imports are external/unresolved).`);
        }
      }
      return capToolOutput(sections.join('\n'), MAX_CHARS, 'Narrow the depth or direction to see more detail on a branch.');
    },
  });
}

/** Normalize whatever the model passed (absolute fs path, workspace-relative, or with leading
 *  slash) to a clean workspace-relative key matching the index, without throwing on a bad path
 *  (resolveWorkspacePath would) — the tool should report "not found", not error. */
function toWorkspaceRelative(path: string): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.replace(/\\/g, '/');
  let p = path.replace(/\\/g, '/');
  if (root && p.startsWith(root)) p = p.slice(root.length);
  return p.replace(/^\/+/, '');
}
