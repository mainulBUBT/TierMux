

import * as vscode from 'vscode';
import { effectiveRootUri } from './workspaceRoot';

/** Strip a leading workspace-root prefix so an ABSOLUTE path inside the workspace becomes
 *  relative. Weak models echo absolute paths from grep hits and diagnostics; merely deleting the
 *  leading slash produced `<root>/<root>/src/a.ts`, which passed containment — readFile said
 *  "not found" while writeFile CREATED the junk file and reported success. Matches both `fsPath`
 *  and `path` so separator style does not matter. */
function stripWorkspacePrefix(input: string, root: vscode.Uri): string {
  const normalized = input.replace(/\\/g, '/');
  for (const base of [root.fsPath, root.path]) {
    if (!base) continue;
    const b = base.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized === b) return '';
    if (normalized.startsWith(b + '/')) return normalized.slice(b.length + 1);
  }
  // Otherwise a leading slash is a stray prefix on a relative path (`/src/index.ts` is a common
  // weak-model tic). `/etc/passwd` therefore lands at `<root>/etc/passwd` — still CONFINED, just
  // an oddly-named miss rather than an escape.
  return input;
}

/** Resolves a workspace-relative path to a Uri, confined to the workspace root — same
 *  containment every path-taking tool (including runCommand's `cwd`) uses. */
export function resolveWorkspacePath(relPath: string): vscode.Uri {
  // Goes through `effectiveRootUri` so a fleet-pipeline worker (wrapped in
  // `runWithWorkspaceRoot`) resolves paths against its OWN worktree, while the main-agent path —
  // which never sets an ALS root — falls through to `workspaceFolders[0]` exactly as before.
  const root = effectiveRootUri();
  const rel = stripWorkspacePrefix((relPath ?? '').trim(), root);
  const uri = vscode.Uri.joinPath(root, rel.replace(/^[/\\]+/, ''));
  if (!isInsideRoot(uri, root)) throw new Error(`Path escapes the workspace: ${relPath}`);
  return uri;
}

/** Extra directories `readFile` may read from, outside the workspace. Populated when a skill
 *  that ships its own files is invoked: a BUNDLED skill lives under the extension folder, so
 *  its own `references/` were unreadable and the instruction to read them silently failed.
 *  Read-only and opt-in — writes and commands keep the plain workspace containment. */
const readableRoots = new Set<string>();

export function registerReadableRoot(dir: string): void {
  const d = (dir ?? '').trim();
  if (d) readableRoots.add(d.replace(/\\/g, '/').replace(/\/+$/, ''));
}

/** Test seam — production only ever adds. */
export function __clearReadableRoots(): void {
  readableRoots.clear();
}

/** Workspace containment, plus an absolute path inside a registered readable root. Used by
 *  readFile alone; every mutating tool stays on resolveWorkspacePath. */
export function resolveReadablePath(relPath: string): vscode.Uri {
  const raw = (relPath ?? '').trim().replace(/\\/g, '/');
  if (raw.startsWith('/')) {
    for (const root of readableRoots) {
      if (raw === root || raw.startsWith(root + '/')) return vscode.Uri.file(raw);
    }
  }
  return resolveWorkspacePath(relPath);
}

/** Containment test on a real path-segment boundary: bare `startsWith(root.path)` let a SIBLING
 *  through (`/htdocs/Proj-backup/.env` starts with `/htdocs/Proj`), and joinPath normalises `..`,
 *  so `../Proj-backup/.env` was accepted by every path-taking tool. */
export function isInsideRoot(uri: vscode.Uri, root: vscode.Uri): boolean {
  const base = root.path.replace(/\/+$/, '');
  return uri.path === base || uri.path.startsWith(base + '/');
}
