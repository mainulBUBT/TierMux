

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { CheckpointFile } from '../messages';

const execFile = promisify(execFileCb);
const TIMEOUT_MS = 8000;

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await execFile('git', args, {
      cwd, maxBuffer: 50 * 1024 * 1024, timeout: TIMEOUT_MS,
      env: { ...process.env, ...env },
    });
    return stdout.toString();
  } catch {
    return '';
  }
}

/** True if `cwd` is inside a git work tree (so the git snapshot path is usable). */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const out = (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim();
  return out === 'true';
}

/**
 * Write the full current working tree (tracked + untracked, non-ignored) to a tree object via
 * a THROWAWAY index file, returning the tree SHA. Does NOT mutate HEAD, the real index, or the
 * working tree. Returns null only if `cwd` isn't a git repo at all — a repo with zero commits
 * still works: `read-tree HEAD` simply no-ops (caught by `git()`) and `add -A` builds the tree
 * from a fresh empty index, which captures the same "everything currently present" snapshot.
 */
export async function captureWorkingTree(cwd: string): Promise<string | null> {
  if (!(await isGitRepo(cwd))) return null;
  return writeWorkTree(cwd);
}

/** Stage the current worktree into a temp index seeded from HEAD and write its tree. */
async function writeWorkTree(cwd: string): Promise<string | null> {
  const tmpIndex = path.join(os.tmpdir(), `tiermux-idx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.idx`);
  try {
    await git(cwd, ['read-tree', 'HEAD'], { GIT_INDEX_FILE: tmpIndex });
    await git(cwd, ['add', '-A'], { GIT_INDEX_FILE: tmpIndex }); // respects .gitignore
    const tree = (await git(cwd, ['write-tree'], { GIT_INDEX_FILE: tmpIndex })).trim();
    return tree || null;
  } finally {
    try { await fs.promises.unlink(tmpIndex); } catch { /* already gone */ }
  }
}

/** Relative paths present in a tree (tracked + captured-untracked). */
async function treePaths(cwd: string, tree: string): Promise<Set<string>> {
  const out = await git(cwd, ['ls-tree', '-r', '--name-only', tree]);
  return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
}

/**
 * Files changed between `beginTree` and the CURRENT working tree, classified. Captures the
 * current tree the same way and diffs the two trees directly (no index involvement), so a file
 * whose content is identical to begin never appears — even if it's untracked.
 */
export async function changedSince(cwd: string, beginTree: string): Promise<CheckpointFile[]> {
  const curTree = await writeWorkTree(cwd);
  if (!curTree) return [];

  const diffOut = await git(cwd, ['diff', '--name-only', '--no-renames', beginTree, curTree]);
  const changed = diffOut.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!changed.length) return [];
  const inBegin = await treePaths(cwd, beginTree);
  const inCur = await treePaths(cwd, curTree);
  const out: CheckpointFile[] = [];
  for (const rel of changed) {
    const b = inBegin.has(rel), c = inCur.has(rel);
    const status: CheckpointFile['status'] | null = b && c ? 'modified' : b && !c ? 'deleted' : !b && c ? 'created' : null;
    if (!status) continue;
    out.push({ uri: vscode.Uri.joinPath(vscode.Uri.file(cwd), rel).toString(), rel, status });
  }
  return out;
}

/** A file's content at `tree`, or null if it didn't exist there (created-since-begin case). */
export async function readFileAtTree(cwd: string, tree: string, rel: string): Promise<string | null> {
  const out = await execFile('git', ['show', `${tree}:${rel}`], { cwd, maxBuffer: 50 * 1024 * 1024, timeout: TIMEOUT_MS })
    .then((r) => r.stdout.toString())
    .catch(() => null);
  return out;
}

/** Restore the working tree to `beginTree` for every path changed since then. Returns # touched. */
export async function restoreToTree(cwd: string, beginTree: string): Promise<number> {
  const changed = await changedSince(cwd, beginTree);
  const inBegin = await treePaths(cwd, beginTree);
  let n = 0;
  for (const f of changed) {
    const rel = f.rel;
    try {
      if (inBegin.has(rel)) {

        await git(cwd, ['restore', '--source', beginTree, '--worktree', '--', rel]);
      } else {

        const uri = vscode.Uri.file(path.join(cwd, rel));
        if (await pathExists(uri)) await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
      }
      n++;
    } catch { /* skip files we can't restore */ }
  }
  return n;
}

async function pathExists(p: vscode.Uri): Promise<boolean> {
  try { await vscode.workspace.fs.stat(p); return true; } catch { return false; }
}
