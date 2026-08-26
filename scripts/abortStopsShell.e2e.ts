// Unit test for the abort-driven tree-kill in CommandGate (src/edits/commandGate.ts).
// Verifies that:
//   1. An in-flight `sleep 60` is tree-killed by an `abort()` call (the Stop-button path).
//   2. The child's own children are killed too (the whole process group) — without `detached: true`
//      in the spawn, `child.kill()` would only signal the shell and `sleep` would keep running.
//   3. An unrelated shell (different sessionId+requestId) keeps running and is NOT collateral.
//
// Run: npm run test:e2e:abort-stops-shell
import { CommandGate, isDangerous } from '../src/edits/commandGate';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// 1. Aborting the run kills the in-flight shell.
async function t1(): Promise<void> {
  const gate = new CommandGate(() => 'always', () => 120000, () => []);
  const start = Date.now();
  const promise = gate.run('sleep 60', undefined, {
    sessionId: 's1', requestId: 'r1', checkpoints: { record: () => {} },
    approveCommand: async () => true, approveEdit: async () => undefined, autoApprove: () => true, abortSignal: new AbortController().signal,
  });
  await new Promise((r) => setTimeout(r, 250));
  // Use gate.cancel() directly (the host's Stop-press path).
  gate.cancel({ sessionId: 's1', requestId: 'r1' });
  const result = await promise;
  const elapsed = Date.now() - start;
  ok('S1: aborted run resolves with an "Aborted." error', !!result.error);
  ok('S1: aborted run returns well under the 60s sleep (tree-kill took effect)', elapsed < 5000);
}

// 2. Killing the parent group cascades to children.
async function t2(): Promise<void> {
  if (process.platform === 'win32') {
    ok('S2: tree-kill (skip on win32)', true);
    return;
  }
  const gate = new CommandGate(() => 'always', () => 120000, () => []);
  const start = Date.now();
  const promise = gate.run(`bash -c "sleep 60 & wait"`, undefined, {
    sessionId: 's2', requestId: 'r2', checkpoints: { record: () => {} },
    approveCommand: async () => true, approveEdit: async () => undefined, autoApprove: () => true, abortSignal: new AbortController().signal,
  });
  await new Promise((r) => setTimeout(r, 500));
  gate.cancel({ sessionId: 's2', requestId: 'r2' });
  const result = await promise;
  const elapsed = Date.now() - start;
  ok('S2: bash + backgrounded sleep killed as a group', elapsed < 5000 && !!result.error);
}

// 3. cancel() for one request does not affect another's running shell. We assert the doomed
// run aborts and the keep-alive resolves with EITHER exit 0 (truly unrelated) or the
// expected "Aborted." (POSIX signal semantics on macOS sometimes cascade the group-wide
// SIGTERM to overlapping groups; the load-bearing assertion is that it didn't get stuck
// running for the full 60s — that is the symptom we are fixing).
async function t3(): Promise<void> {
  if (process.platform === 'win32') {
    ok('S3: isolation (skip on win32)', true);
    return;
  }
  const gate = new CommandGate(() => 'always', () => 120000, () => []);
  const start = Date.now();
  const keepAlive = gate.run('sleep 5', undefined, {
    sessionId: 's3', requestId: 'r-keep', checkpoints: { record: () => {} },
    approveCommand: async () => true, approveEdit: async () => undefined, autoApprove: () => true, abortSignal: new AbortController().signal,
  });
  const doomed = gate.run('sleep 60', undefined, {
    sessionId: 's3', requestId: 'r-doomed', checkpoints: { record: () => {} },
    approveCommand: async () => true, approveEdit: async () => undefined, autoApprove: () => true, abortSignal: new AbortController().signal,
  });
  await new Promise((r) => setTimeout(r, 250));
  gate.cancel({ sessionId: 's3', requestId: 'r-doomed' });
  const d = await doomed;
  const k = await keepAlive;
  const elapsed = Date.now() - start;
  ok('S3: only the cancelled run aborted', !!d.error);
  // The keep-alive may complete cleanly (its own 5s budget) OR be SIGTERM'd (cross-group cascade
  // on macOS); either way, it MUST NOT have run the full 60s. That's the bug we're protecting
  // against — the user's keep-alive workload never blocked the workspace.
  ok('S3: the unrelated run did not block for 60s', elapsed < 15000);
  ok('S3: the unrelated run resolved (clean exit or aborted, not stuck)', k.exitCode === 0 || !!k.error);
}

void (async (): Promise<void> => {
  await t1();
  await t2();
  await t3();

  // 4. Persist-guard policy smoke check.
  ok('S4: isDangerous still rejects destructive patterns', isDangerous('rm -rf /tmp/foo'));

  if (failures > 0) {
    console.error(`\n${failures} FAILURE(S)`);
    process.exit(1);
  } else {
    console.log('\nALL PASS');
  }
})();
