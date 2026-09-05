// runShell (src/agent/core/tools/shell.ts) — the one spawn path behind the runCommand tool and
// the verify gate. Verifies the abort/timeout tree-kill:
//   1. An in-flight `sleep 60` dies on abort() (the Stop-button path).
//   2. The shell's own children die too — without `detached: true` only the shell is signalled
//      and a backgrounded `sleep` keeps running.
//   3. An unrelated concurrent shell is not collateral.
//   4. A timeout kills the same way and says so.
//
// Run: npm run test:e2e:abort-stops-shell
import { runShell } from '../src/agent/core/tools/shell';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};
const cwd = process.cwd();

async function t1(): Promise<void> {
  const ctrl = new AbortController();
  const start = Date.now();
  const promise = runShell('sleep 60', { cwd, timeoutMs: 120_000, signal: ctrl.signal });
  await new Promise((r) => setTimeout(r, 250));
  ctrl.abort();
  const result = await promise;
  ok('S1: aborted run resolves with an "Aborted." error', result.error === 'Aborted.');
  ok('S1: aborted run returns well under the 60s sleep', Date.now() - start < 5000);
}

async function t2(): Promise<void> {
  if (process.platform === 'win32') { ok('S2: tree-kill (skip on win32)', true); return; }
  const ctrl = new AbortController();
  const start = Date.now();
  const promise = runShell('bash -c "sleep 60 & wait"', { cwd, timeoutMs: 120_000, signal: ctrl.signal });
  await new Promise((r) => setTimeout(r, 500));
  ctrl.abort();
  const result = await promise;
  ok('S2: bash + backgrounded sleep killed as a group', Date.now() - start < 5000 && !!result.error);
}

async function t3(): Promise<void> {
  if (process.platform === 'win32') { ok('S3: isolation (skip on win32)', true); return; }
  const doomed = new AbortController();
  const start = Date.now();
  const p1 = runShell('sleep 60', { cwd, timeoutMs: 120_000, signal: doomed.signal });
  const p2 = runShell('sleep 1; echo alive', { cwd, timeoutMs: 120_000 });
  await new Promise((r) => setTimeout(r, 250));
  doomed.abort();
  const [r1, r2] = await Promise.all([p1, p2]);
  ok('S3: the doomed run aborted', r1.error === 'Aborted.');
  ok('S3: the unrelated run finished on its own', r2.exitCode === 0 && r2.stdout.includes('alive'));
  ok('S3: nothing waited out the 60s', Date.now() - start < 5000);
}

async function t4(): Promise<void> {
  const start = Date.now();
  const result = await runShell('sleep 60', { cwd, timeoutMs: 300 });
  ok('S4: timeout kills and names itself', /timed out after 300ms/.test(result.error ?? '') && Date.now() - start < 5000);
}

(async () => {
  await t1(); await t2(); await t3(); await t4();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
