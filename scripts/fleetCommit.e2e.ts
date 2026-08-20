/* The fleet pipeline must actually KEEP the work its workers do.
 *
 * From a 2026-08-20 audit: nothing in the pipeline ever committed. Workers are forbidden from
 * running git themselves (WORKER_SYSTEM + createWorkerToolApproval), so their branch stayed
 * identical to HEAD. The consequences chained silently:
 *   - diffBranch('HEAD...branch') → [] , so the report said "0 files changed"
 *   - mergeBranchIntoWorktree     → "Already up to date", merging nothing
 *   - the finally-block `git worktree remove -f` → DELETED the uncommitted work
 * …while synthesize() still reported "MERGED". The user's parallel work vanished and the agent
 * told them it had landed. There were no tests referencing implementPipeline at all, which is
 * why 336 lines of pipeline could be a no-op without anyone noticing.
 *
 * This drives REAL git in a temp repo — no mocks — because the bug lived entirely in what git
 * actually does with an uncommitted worktree, which a mocked test would have happily faked.
 *
 * Run: npm run test:e2e:fleet-commit
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorktree, createBranch, createWorktreeExistingBranch, removeWorktree,
  mergeBranchIntoWorktree, diffBranch, commitAll, ensureWorktreeDirIgnored,
} from '../src/edits/worktree';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function main(): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), 'tiermux-fleet-'));
  try {
    git(repo, 'init', '-q', '.');
    git(repo, 'config', 'user.email', 'test@tiermux.local');
    git(repo, 'config', 'user.name', 'TierMux Test');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');

    // What the pipeline pins once, up front. Every diff is relative to this rather than the
    // literal 'HEAD' — inside a worker's worktree HEAD resolves to that worker's own branch.
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    await ensureWorktreeDirIgnored(repo);

    console.log('— A worker\'s edits survive cleanup and reach the staging branch —');
    const stagingBranch = 'tiermux/staging-test';
    await createBranch(repo, stagingBranch, 'HEAD');
    const stagingWt = await createWorktreeExistingBranch(repo, stagingBranch);

    const wBranch = 'tiermux/worker-test-0';
    const wt = await createWorktree(repo, wBranch, 'HEAD');

    // What a worker does: edit an existing file and create a new one. No git — workers can't.
    writeFileSync(join(wt.path, 'base.txt'), 'base\nworker edit\n');
    mkdirSync(join(wt.path, 'src'), { recursive: true });
    writeFileSync(join(wt.path, 'src', 'new.ts'), 'export const added = true;\n');

    const committed = await commitAll(wt.path, 'TierMux worker: test goal');
    ok('commitAll reports it committed something', committed === true);

    const changed = await diffBranch(wt.path, wBranch, baseSha);
    ok('diffBranch now sees the modified file', changed.includes('base.txt'), changed.join(','));
    ok('diffBranch sees the NEW file too (git add -A, not -u)', changed.includes('src/new.ts'));
    // The regression that made the fix look broken: from inside the worker's own worktree, the
    // literal 'HEAD' IS the worker branch, so this comparison is the branch against itself.
    ok('and \'HEAD\' from inside the worktree would have reported nothing (why baseSha is needed)',
      (await diffBranch(wt.path, wBranch, 'HEAD')).length === 0);

    const outcome = await mergeBranchIntoWorktree(stagingWt.path, wBranch);
    ok('the merge succeeds', outcome.ok, outcome.message.split('\n')[0]);
    ok('the merge was not a no-op', !/already up to date/i.test(outcome.message));

    // The step that used to destroy everything.
    await removeWorktree(repo, wt.path, { force: true });
    ok('the worktree directory is gone', !existsSync(wt.path));
    ok('but the work survives on the branch',
      git(repo, 'show', `${wBranch}:src/new.ts`).includes('added = true'));
    ok('and the work is present on the staging branch',
      git(repo, 'show', `${stagingBranch}:src/new.ts`).includes('added = true'));
    ok('the staging branch really differs from the base now',
      (await diffBranch(repo, stagingBranch, baseSha)).length > 0);

    console.log('\n— A worker that changed nothing is reported honestly —');
    const emptyBranch = 'tiermux/worker-test-empty';
    const emptyWt = await createWorktree(repo, emptyBranch, 'HEAD');
    const none = await commitAll(emptyWt.path, 'TierMux worker: did nothing');
    ok('commitAll reports nothing to commit', none === false);
    ok('an empty worker branch has no diff', (await diffBranch(repo, emptyBranch, baseSha)).length === 0);
    await removeWorktree(repo, emptyWt.path, { force: true });

    console.log('\n— The user\'s own working tree is never touched —');
    // Without ensureWorktreeDirIgnored this reports `?? .tiermux-worktrees/` for the whole run,
    // which a `git add -A` would sweep entire checked-out worktrees into a commit.
    ok('main worktree stays clean while a worktree is live', git(repo, 'status', '--porcelain') === '',
      git(repo, 'status', '--porcelain'));
    ok('main branch has no worker commit', !git(repo, 'log', '--oneline').includes('worker'));
    ok('the ignore entry is repo-local, not in a tracked .gitignore', !existsSync(join(repo, '.gitignore')));
    ok('ensureWorktreeDirIgnored is idempotent', await (async () => {
      await ensureWorktreeDirIgnored(repo);
      await ensureWorktreeDirIgnored(repo);
      const ex = git(repo, 'rev-parse', '--git-common-dir');
      const p = join(ex.startsWith('/') ? ex : join(repo, ex), 'info', 'exclude');
      const body = execFileSync('cat', [p], { encoding: 'utf8' });
      return body.split('\n').filter((l) => l.trim() === '.tiermux-worktrees/').length === 1;
    })());

    await removeWorktree(repo, stagingWt.path, { force: true });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }

  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();
