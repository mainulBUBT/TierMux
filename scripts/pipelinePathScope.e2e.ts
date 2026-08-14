/* Validates the two pieces the fleet pipeline rests on, without needing git or network:
 *   1. ALS workspace-root scoping — a worker wrapped in runWithWorkspaceRoot resolves paths
 *      against ITS root, while the main-agent path (no ALS root) falls back to workspaceFolders[0].
 *   2. createWorkerToolApproval — the write-capable worker policy: mutating tools ALLOWED, but
 *      secrets reads, dangerous commands, mutating git, and blind edits DENIED.
 *
 * Run: npm run test:e2e:pipeline-paths
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import {
  runWithWorkspaceRoot, peekWorkspaceRoot, effectiveRootUri,
} from '../src/agent/core/tools/workspaceRoot';
import { resolveWorkspacePath } from '../src/agent/core/tools/resolvePath';
import {
  createWorkerToolApproval, isMutatingGit,
} from '../src/agent/core/policies/permission';

// The read-before-edit (blind-edit) gate is reused VERBATIM from the main turn policy
// (createToolApproval) and is already covered by the secretsGate / editGate suites, so this test
// focuses on what the worker policy changes relative to that: mutating tools are ALLOWED, and the
// secrets/dangerous/mutating-git gates still DENY.

const ROOT = '/htdocs/Proj';
(vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
  { uri: { fsPath: ROOT, path: ROOT } },
];

let bad = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) bad++; };

async function main(): Promise<void> {
  // ── 1. ALS root scoping ─────────────────────────────────────────────────────────────────
  ok('peekWorkspaceRoot is undefined on the main-agent path', peekWorkspaceRoot() === undefined);
  ok('effectiveRootUri falls back to workspaceFolders[0]', effectiveRootUri().fsPath === ROOT);
  ok('resolveWorkspacePath resolves under the live workspace root', resolveWorkspacePath('src/a.ts').fsPath === path.join(ROOT, 'src/a.ts'));

  const wt = path.join(os.tmpdir(), `tiermux-wt-test-${process.pid}`);
  fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });

  await runWithWorkspaceRoot(wt, async () => {
    ok('peekWorkspaceRoot returns the override inside runWithWorkspaceRoot', peekWorkspaceRoot() === wt);
    ok('effectiveRootUri uses the ALS root', effectiveRootUri().fsPath === wt);
    ok('resolveWorkspacePath resolves under the worktree', resolveWorkspacePath('a.ts').fsPath === path.join(wt, 'a.ts'));
    ok('subdir path resolves under the worktree', resolveWorkspacePath('sub/b.ts').fsPath === path.join(wt, 'sub', 'b.ts'));
    // The containment check now scopes to the worktree: an absolute path inside the LIVE workspace
    // but OUTSIDE the worktree must still resolve under (be confined to) the worktree, never escape.
    const resolved = resolveWorkspacePath('/etc/passwd');
    ok('escape attempt is confined to the worktree (not the FS root)', resolved.fsPath.startsWith(wt + path.sep) || resolved.fsPath === wt);
  });

  ok('ALS root clears after runWithWorkspaceRoot returns', peekWorkspaceRoot() === undefined);

  // ── 2. isMutatingGit ────────────────────────────────────────────────────────────────────
  for (const cmd of ['git status', 'git diff', 'git log --oneline', 'git show HEAD', 'git ls-files', 'git blame x.ts']) {
    ok(`read-only git allowed: "${cmd}"`, !isMutatingGit(cmd));
  }
  for (const cmd of ['git commit -m x', 'git checkout main', 'git push', 'git merge feat', 'git reset --hard', 'git clean -fd', 'git cherry-pick abc', 'git tag v1', 'git stash', 'git -c x=y commit -m x', 'git branch -d feat', 'git worktree add ../x']) {
    ok(`mutating git denied: "${cmd}"`, isMutatingGit(cmd));
  }
  ok('non-git command is not mutating-git', !isMutatingGit('npm test'));

  // ── 3. createWorkerToolApproval ────────────────────────────────────────────────────────
  const approve = createWorkerToolApproval();
  const decision = async (toolName: string, input: unknown): Promise<string> => {
    const v = await approve({ toolCall: { toolName, input } });
    return typeof v === 'object' && v ? (v as { type: string }).type : (v as string);
  };

  // Mutating tools are APPROVED (the whole point of a write-capable worker).
  ok('writeFile approved', await decision('writeFile', { path: 'new.ts', content: 'x' }) === 'approved');
  ok('createFile approved', await decision('createFile', { path: 'new.ts', content: 'x' }) === 'approved');
  ok('editFile approved', await decision('editFile', { path: 'new.ts', old: 'x', new: 'y' }) === 'approved');
  ok('deleteFile approved', await decision('deleteFile', { path: 'new.ts' }) === 'approved');
  ok('runCommand (npm test) approved', await decision('runCommand', { command: 'npm test' }) === 'approved');
  ok('runCommand (git status) approved', await decision('runCommand', { command: 'git status' }) === 'approved');

  // Safety gates still DENY.
  ok('readFile(.env) denied', await decision('readFile', { path: '.env' }) === 'denied');
  ok('grep over .env denied (secrets path)', await decision('grep', { pattern: 'x', path: '.env' }) === 'denied');
  ok('runCommand(cat .env) denied', await decision('runCommand', { command: 'cat .env' }) === 'denied');
  ok('runCommand(rm -rf x) denied (dangerous)', await decision('runCommand', { command: 'rm -rf dist' }) === 'denied');
  ok('runCommand(git commit) denied (mutating git)', await decision('runCommand', { command: 'git commit -m x' }) === 'denied');
  ok('runCommand(git push) denied (mutating git)', await decision('runCommand', { command: 'git push' }) === 'denied');

  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();
