

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFile = promisify(execFileCb);
const TIMEOUT_MS = 15_000;

/** cwd-parameterised git that THROWS on failure. `gitSnapshot.git` returns '' on error, which is
 *  right for snapshot/restore (a missing tree is recoverable) but wrong for worktree lifecycle:
 *  a silently-failed `worktree add` would leave the pipeline assuming a worktree exists that
 *  doesn't, then write into the wrong place. Worktree ops must surface their failures. */
export async function gitExec(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await execFile('git', args, {
      cwd, maxBuffer: 50 * 1024 * 1024, timeout: TIMEOUT_MS,
      env: { ...process.env, ...env },
    });
    return stdout.toString();
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const stderr = (err.stderr ?? '').toString();
    const stdout = (err.stdout ?? '').toString();
    throw new GitError(`git ${args.join(' ')} failed in ${cwd}: ${err.message ?? stderr}`, stdout, stderr);
  }
}

export class GitError extends Error {
  constructor(message: string, readonly stdout: string, readonly stderr: string) {
    super(message);
    this.name = 'GitError';
  }
}

export interface WorktreeInfo {
  /** The branch checked out in this worktree, e.g. `tiermux/worker-<run>-<i>`. */
  branch: string;
  /** Absolute filesystem path of the linked worktree. */
  path: string;
}

/** Directory (under the repo root) where TierMux parks its linked worktrees. Keeping them in one
 *  place makes cleanup/glob-skipping uniform. `.git` ignores it via the worktree list anyway. */
export function worktreeDir(repoRoot: string, branch: string): string {
  return path.join(repoRoot, '.tiermux-worktrees', branch.replace(/[/\\]/g, '_'));
}

/** Create a linked worktree on a NEW branch off the repo's current HEAD. Branch-per-worker (not
 *  detached) so the branch survives worktree removal and can be merged/inspected by name. */
export async function createWorktree(repoRoot: string, branch: string, baseRef = 'HEAD'): Promise<WorktreeInfo> {
  const wtPath = worktreeDir(repoRoot, branch);
  // `-b` creates the branch from baseRef and checks it out in the new worktree in one step.
  await gitExec(repoRoot, ['worktree', 'add', '-b', branch, wtPath, baseRef]);
  return { branch, path: wtPath };
}

/** Create a branch off `baseRef` WITHOUT checking it out anywhere (for the staging branch, which
 *  gets its own worktree via `createWorktree` using an existing branch with `worktree add`). */
export async function createBranch(repoRoot: string, branch: string, baseRef = 'HEAD'): Promise<void> {
  await gitExec(repoRoot, ['branch', branch, baseRef]);
}

/** Create a worktree that checks out an EXISTING branch (e.g. the staging branch). */
export async function createWorktreeExistingBranch(repoRoot: string, branch: string): Promise<WorktreeInfo> {
  const wtPath = worktreeDir(repoRoot, branch);
  await gitExec(repoRoot, ['worktree', 'add', wtPath, branch]);
  return { branch, path: wtPath };
}

export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const out = await gitExec(repoRoot, ['worktree', 'list', '--porcelain']);
  const infos: WorktreeInfo[] = [];
  let curPath = '';
  let curBranch = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { curPath = line.slice('worktree '.length).trim(); }
    else if (line.startsWith('branch ')) { curBranch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, ''); }
    else if (line === '' && curPath) { infos.push({ branch: curBranch, path: curPath }); curPath = ''; curBranch = ''; }
  }
  if (curPath) infos.push({ branch: curBranch, path: curPath });
  return infos;
}

export async function removeWorktree(repoRoot: string, wtPath: string, opts: { force?: boolean } = {}): Promise<void> {
  await gitExec(repoRoot, ['worktree', 'remove', ...(opts.force ? ['-f'] : []), wtPath]);
}

export async function deleteBranch(repoRoot: string, branch: string, opts: { force?: boolean } = {}): Promise<void> {
  await gitExec(repoRoot, ['branch', ...(opts.force ? ['-D'] : ['-d']), branch]);
}

export interface MergeOutcome {
  ok: boolean;
  /** Present only on conflict: repo-relative paths git couldn't merge cleanly. */
  conflictFiles?: string[];
  /** Human-readable detail (conflict summary or merge commit line). */
  message: string;
}

/** Merge `branch` into whatever is checked out in the worktree at `targetWtPath`. This is how the
 *  pipeline lands worker branches into the staging branch: the staging branch is checked out in
 *  its own worktree, so we merge there without ever touching the user's main working tree.
 *
 *  NEVER auto-resolves. On conflict: `git merge --abort` rolls the index back, the worker branch
 *  is left intact for inspection, and the conflicting paths are returned. Silent auto-resolution is
 *  the worst failure mode for an unattended merge (a plausible-but-wrong half of a conflict gets
 *  committed), so a conflict always surfaces as a clean abort rather than a guess. */
export async function mergeBranchIntoWorktree(targetWtPath: string, branch: string, opts: { noFf?: boolean } = {}): Promise<MergeOutcome> {
  try {
    const msg = await gitExec(targetWtPath, ['merge', ...(opts.noFf === false ? [] : ['--no-ff']), '-m', `Merge ${branch} (TierMux pipeline)`, branch]);
    return { ok: true, message: msg.trim() };
  } catch (e) {
    // A merge conflict exits non-zero with conflict markers in the index. Detect, abort, report.
    const conflicts = await conflictPaths(targetWtPath).catch(() => []);
    try { await gitExec(targetWtPath, ['merge', '--abort']); } catch { /* may already be aborted/empty */ }
    const reason = e instanceof GitError ? e.stderr || e.message : String(e);
    return { ok: false, conflictFiles: conflicts, message: `Merge of ${branch} conflicted (${conflicts.length} files): ${reason.trim()}` };
  }
}

/** Repo-relative paths in a conflicted merge state (`Unmerged paths` section of `git status --porcelain`). */
async function conflictPaths(wtPath: string): Promise<string[]> {
  const out = await gitExec(wtPath, ['status', '--porcelain']);
  return out.split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(DD|AU|UD|UA|DU|AA|UU)/.test(l))
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

/** Files changed on `branch` relative to its merge-base with `baseRef` — i.e. what a worker
 *  actually touched. Used in the synthesis the pipeline reports back to the parent agent. */
export async function diffBranch(repoRoot: string, branch: string, baseRef = 'HEAD'): Promise<string[]> {
  const out = await gitExec(repoRoot, ['diff', '--name-only', '--no-renames', `${baseRef}...${branch}`]);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Current short ref name checked out in `wtPath` (defensive — confirms a worktree's state). */
export async function currentBranch(wtPath: string): Promise<string> {
  return (await gitExec(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

/** True if `branch` exists in the repo at `cwd`. */
export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await gitExec(cwd, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    return true;
  } catch { return false; }
}
