

import { AsyncLocalStorage } from 'node:async_hooks';
import * as vscode from 'vscode';

/** Per-async-context workspace root, so a parallel worker sub-agent resolves paths against its
 *  OWN git worktree. AsyncLocalStorage rather than a parameter because every path-taking tool
 *  factory is nullary and reads `workspaceFolders[0]` live inside `execute` — ALS redirects a
 *  whole async subtree without touching a factory signature. The main-agent path never sets a
 *  store, so its behaviour is unchanged; each worker's `rootStore.run` context never leaks. */
const rootStore = new AsyncLocalStorage<string>();

/** Run `fn` with `root` (an absolute filesystem path) as the implicit workspace root for any
 *  path-taking tool invoked inside it. Returns whatever `fn` returns. Callers outside the fleet
 *  pipeline never call this — they leave the store unset. */
export function runWithWorkspaceRoot<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return rootStore.run(root, fn);
}

/** The override root (absolute fs path) for the current async context, or `undefined` when running
 *  on the main-agent path. Tools consult this FIRST and fall back to `workspaceFolders[0]`. */
export function peekWorkspaceRoot(): string | undefined {
  return rootStore.getStore();
}

/** The effective workspace root as a Uri: the ALS override if set, otherwise the first workspace
 *  folder. Throws if neither is available. Every path resolution that used to read
 *  `workspaceFolders[0]` directly should go through this so fleet workers are scoped correctly. */
export function effectiveRootUri(): vscode.Uri {
  const override = peekWorkspaceRoot();
  if (override) return vscode.Uri.file(override);
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) throw new Error('No workspace folder is open.');
  return folders[0].uri;
}
