

import { AsyncLocalStorage } from 'node:async_hooks';
import * as vscode from 'vscode';

/**
 * Per-async-context workspace root, used by the fleet pipeline so each parallel worker sub-agent
 * resolves file paths against its OWN git worktree instead of the live VS Code workspace folder.
 *
 * Why AsyncLocalStorage and not a parameter: every path-taking tool factory is nullary and reads
 * `vscode.workspace.workspaceFolders[0]` live, inside `execute`, at call time. That property is
 * read-only in the real VS Code API, so there is no per-call way to redirect it. ALS lets a worker
 * establish a root for its whole async subtree (the nested `generateText` loop and every tool call
 * it makes) without touching a single factory signature — `runWithWorkspaceRoot` wraps the call and
 * the tools consult `peekWorkspaceRoot()` first, falling back to `workspaceFolders[0]` when nothing
 * is set. The main-agent path never sets a store, so its behavior is bit-identical to before.
 *
 * Concurrency: each worker runs in its own ALS context (`rootStore.run`), and tools read the store
 * lazily inside `execute`, so parallel workers in a `Promise.all` never cross-contaminate roots.
 */
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
