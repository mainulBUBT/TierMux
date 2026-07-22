

import * as vscode from 'vscode';

/** Resolves a workspace-relative path to a Uri, confined to the workspace root — same
 *  escape check CommandGate.resolveCwd already applies to `cwd`. */
export function resolveWorkspacePath(relPath: string): vscode.Uri {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) throw new Error('No workspace folder is open.');
  const root = folders[0].uri;
  const uri = vscode.Uri.joinPath(root, relPath.replace(/^\/+/, ''));
  if (!uri.path.startsWith(root.path)) throw new Error(`Path escapes the workspace: ${relPath}`);
  return uri;
}
