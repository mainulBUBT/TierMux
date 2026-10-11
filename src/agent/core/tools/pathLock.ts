// One queue per file for the read-modify-write tools: the SDK runs a step's tool calls
// concurrently, and two overlapping writes to one path lose (or interleave) one of them.

import * as fs from 'fs';
import * as nodePath from 'path';
import type * as vscode from 'vscode';

const tails = new Map<string, Promise<void>>();

/** Same file ⇒ same key: symlinks resolved, case folded where the filesystem usually ignores it. */
function lockKey(uri: vscode.Uri): string {
  let p = nodePath.resolve(uri.fsPath);
  try { p = fs.realpathSync.native(p); } catch {
    try { p = nodePath.join(fs.realpathSync.native(nodePath.dirname(p)), nodePath.basename(p)); } catch { /* not on local disk */ }
  }
  return process.platform === 'linux' ? p : p.toLowerCase();
}

export function withPathLock<T>(uri: vscode.Uri, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(uri);
  const run = (tails.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.then(() => {}, () => {});
  tails.set(key, tail);
  void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}
