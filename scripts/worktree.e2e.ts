/* Exercises the real git worktree lifecycle the fleet pipeline depends on, against a throwaway
 * temp repo. No network, no models — just git. Verifies: create/list/remove worktrees, a clean
 * merge into a staging worktree, and that a conflicted merge is ABORTED (never auto-resolved) with
 * the conflicting paths reported back.
 *
 * Run: npm run test:e2e:worktree
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import {
  gitExec, createWorktree, createBranch, createWorktreeExistingBranch,
  removeWorktree, listWorktrees, mergeBranchIntoWorktree, diffBranch, GitError,
} from '../src/edits/worktree';

let bad = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) bad++; };

function gitInit(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
}

async function main(): Promise<void> {
  const repo = path.join(os.tmpdir(), `tiermux-wt-repo-${process.pid}-${Math.random().toString(36).slice(2, 6)}`);
  gitInit(repo);
  // Base commit with two disjoint files.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'A1\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'B1\n');
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo, stdio: 'ignore' });

  // ── 1. create / list / remove worktree ─────────────────────────────────────────────────
  const wt = await createWorktree(repo, 'tiermux/test-worker-1', 'HEAD');
  ok('worktree created on its own branch', fs.existsSync(path.join(wt.path, 'a.txt')));
  ok('worktree branch is checked out (HEAD moves independently)',
    execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt.path }).toString().trim() === 'tiermux/test-worker-1');

  const listed = await listWorktrees(repo);
  ok('listWorktrees includes the new worktree', listed.some((w) => w.branch === 'tiermux/test-worker-1'));

  // Edit in the worktree + commit on its branch.
  fs.writeFileSync(path.join(wt.path, 'a.txt'), 'A2\n');
  execFileSync('git', ['add', '-A'], { cwd: wt.path, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'worker-1 edit'], { cwd: wt.path, stdio: 'ignore' });
  const changed = await diffBranch(repo, 'tiermux/test-worker-1', 'HEAD');
  ok('diffBranch reports the edited file', changed.includes('a.txt'));

  // ── 2. clean merge into a staging worktree ─────────────────────────────────────────────
  await createBranch(repo, 'tiermux/staging-run', 'HEAD');
  const staging = await createWorktreeExistingBranch(repo, 'tiermux/staging-run');
  const clean = await mergeBranchIntoWorktree(staging.path, 'tiermux/test-worker-1');
  ok('clean merge into staging succeeds', clean.ok === true);
  ok('staging worktree now has the worker edit', fs.readFileSync(path.join(staging.path, 'a.txt'), 'utf8').includes('A2'));

  // ── 3. conflicted merge is ABORTED, not auto-resolved ──────────────────────────────────
  // Second worker edits the SAME line of a.txt from HEAD (simulating a partition that wasn't
  // disjoint) → merging it into staging (which already has worker-1's A2) must conflict.
  const wt2 = await createWorktree(repo, 'tiermux/test-worker-2', 'HEAD');
  fs.writeFileSync(path.join(wt2.path, 'a.txt'), 'A3\n');
  execFileSync('git', ['add', '-A'], { cwd: wt2.path, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'worker-2 conflicting edit'], { cwd: wt2.path, stdio: 'ignore' });

  const conflict = await mergeBranchIntoWorktree(staging.path, 'tiermux/test-worker-2');
  ok('conflicted merge returns ok=false', conflict.ok === false);
  ok('conflicted merge reports the conflicting file', !!conflict.conflictFiles && conflict.conflictFiles.includes('a.txt'));
  // Crucially, the merge was aborted — no conflict markers left in the working tree, staging still
  // holds worker-1's clean result, and the index is clean.
  const stagingContent = fs.readFileSync(path.join(staging.path, 'a.txt'), 'utf8');
  ok('conflicted merge aborted: no conflict markers left', !stagingContent.includes('<<<<<<<'));
  ok('conflicted merge aborted: staging retains prior clean merge', stagingContent.includes('A2'));
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: staging.path }).toString();
  ok('conflicted merge aborted: staging index is clean', status.trim() === '');

  // The conflicting worker branch survives (left for inspection).
  ok('conflicting worker branch still exists', execFileSync('git', ['rev-parse', '--verify', 'refs/heads/tiermux/test-worker-2'], { cwd: repo }).toString().trim().length > 0);

  // ── 4. cleanup: removeWorktree ─────────────────────────────────────────────────────────
  await removeWorktree(repo, wt.path, { force: true });
  await removeWorktree(repo, wt2.path, { force: true });
  await removeWorktree(repo, staging.path, { force: true });
  ok('removed worktree gone from disk', !fs.existsSync(wt.path));
  const afterList = await listWorktrees(repo);
  ok('removed worktree gone from list', !afterList.some((w) => w.path === wt.path));

  // ── 5. gitExec throws (not silent) on failure ──────────────────────────────────────────
  let threw = false;
  try { await gitExec(repo, ['worktree', 'add', '/nonexistent-path-xyz', 'HEAD']); }
  catch (e) { threw = e instanceof GitError; }
  ok('gitExec throws a GitError on failure (not silent "")', threw);

  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();
