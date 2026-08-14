

import * as vscode from 'vscode';
import { effectiveRootUri } from './workspaceRoot';

/** Strips a leading workspace-root prefix, so an ABSOLUTE path that already points inside the
 *  workspace becomes workspace-relative. Weak models routinely echo absolute paths straight back
 *  out of grep hits, diagnostics, and error text. The previous `relPath.replace(/^\/+/, '')`
 *  merely deleted the leading slash, turning `<root>/src/a.ts` into `<root>/<root>/src/a.ts` —
 *  a junk path that still passed the containment check below. The damage was silent and
 *  asymmetric: `readFile` reported "File not found" for a file that plainly exists, while
 *  `writeFile`/`createFile` CREATED the junk file, returned `applied: true`, and reported
 *  "Wrote <root>/src/a.ts" — full positive confirmation for an edit that never touched the real
 *  file. (`getDependencyTree` already carried a private copy of this normalization; this hoists
 *  the same idea to every path-taking tool.) Matches both `fsPath` and `path` so it works
 *  regardless of separator style. */
function stripWorkspacePrefix(input: string, root: vscode.Uri): string {
  const normalized = input.replace(/\\/g, '/');
  for (const base of [root.fsPath, root.path]) {
    if (!base) continue;
    const b = base.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized === b) return '';
    if (normalized.startsWith(b + '/')) return normalized.slice(b.length + 1);
  }
  // Anything else keeps the historical lenient treatment: a leading slash is taken as a stray
  // prefix on a workspace-relative path, not as a filesystem root. That leniency is deliberate —
  // `/src/index.ts` meaning `src/index.ts` is a very common weak-model tic, and rejecting it
  // would break far more real calls than it protects. An unrelated absolute path like
  // `/etc/passwd` therefore lands at `<root>/etc/passwd`: still fully CONFINED to the workspace
  // (the security property that matters), just an oddly-named miss rather than an escape.
  return input;
}

/** Resolves a workspace-relative path to a Uri, confined to the workspace root — same
 *  escape check CommandGate.resolveCwd already applies to `cwd`. */
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

/** Containment test that requires a real path-segment boundary. A bare
 *  `uri.path.startsWith(root.path)` lets a SIBLING directory through, because
 *  `/htdocs/Proj-backup/.env`.startsWith(`/htdocs/Proj`) is true — and `Uri.joinPath` normalizes
 *  `..`, so `../Proj-backup/.env` resolved cleanly outside the root and was accepted by every
 *  path-taking tool (readFile/writeFile/editFile/deleteFile). Comparing against `root + '/'`
 *  (while still allowing the root itself) closes it. */
export function isInsideRoot(uri: vscode.Uri, root: vscode.Uri): boolean {
  const base = root.path.replace(/\/+$/, '');
  return uri.path === base || uri.path.startsWith(base + '/');
}
