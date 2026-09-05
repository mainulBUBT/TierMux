/* resolveWorkspacePath: absolute-path normalization + real containment (2026-08-13 audit).
 * (1) Stripping the leading slash turned `<root>/src/a.ts` into `<root>/<root>/src/a.ts` —
 * readFile said "not found" while writeFile CREATED the junk file and reported success.
 * (2) joinPath normalizes `..` and the guard was a bare prefix, so `../Proj-backup/.env` escaped
 * from every path-taking tool and runCommand's cwd. Run: npm run test:e2e:resolve-path */
import * as vscode from 'vscode';
import { resolveWorkspacePath } from '../src/agent/core/tools/resolvePath';

const ROOT = '/htdocs/Proj';
(vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
  { uri: { fsPath: ROOT, path: ROOT } },
];

let bad = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) bad++; };

const resolved = (p: string): string | null => {
  try { return resolveWorkspacePath(p).path.replace(/\\/g, '/'); } catch { return null; }
};

// --- 1. absolute paths inside the workspace normalize to the REAL file, not a junk twin ---
ok('absolute path inside workspace resolves to the real file',
  resolved(`${ROOT}/src/agent/agent.ts`) === `${ROOT}/src/agent/agent.ts`);
ok('absolute path does not get the root duplicated',
  !(resolved(`${ROOT}/src/agent/agent.ts`) ?? '').includes(`${ROOT}${ROOT}`));
ok('the workspace root itself resolves', resolved(ROOT) === ROOT);

// --- 2. sibling / outside directories are rejected, not silently accepted ---
ok('sibling dir sharing a name prefix is REJECTED', resolved('../Proj-backup/.env') === null);
ok('sibling dir with a numeric suffix is REJECTED', resolved('../Proj2/secrets.txt') === null);
ok('plain parent traversal is REJECTED', resolved('../../etc/passwd') === null);
// An unrelated absolute path is deliberately NOT rejected: a leading slash is treated as a stray
// prefix on a workspace-relative path, because `/src/index.ts` meaning `src/index.ts` is a very
// common weak-model tic and rejecting it would break more real calls than it protects. What must
// hold is CONFINEMENT — it can never reach the real /etc/passwd.
ok('unrelated absolute path stays confined inside the workspace',
  resolved('/etc/passwd') === `${ROOT}/etc/passwd`);

// --- ordinary relative paths keep working exactly as before ---
ok('plain relative path still resolves', resolved('src/index.ts') === `${ROOT}/src/index.ts`);
ok('leading-slash relative path still resolves', resolved('/src/index.ts') === `${ROOT}/src/index.ts`);
ok('nested relative path still resolves', resolved('a/b/c.ts') === `${ROOT}/a/b/c.ts`);
ok('inner ".." that stays inside is allowed', resolved('src/../lib/x.ts') === `${ROOT}/lib/x.ts`);

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
