/* Background tasks: runCommand {background:true} must return AT ONCE (a dev server must not eat
 * the turn's timeout), taskOutput reads/lists/stops with cursor semantics, the cap names its
 * tenants, the idle sweep frees forgotten servers (driven on an injected clock — no real 30 min),
 * touch() keeps a quiet server alive, and session deletion / extension shutdown kill what they
 * should. Stop-the-TURN is deliberately NOT a kill path — that is the feature.
 * Run: npm run test:e2e:background-tasks */
import * as os from 'os';
import { createRunCommandTool } from '../src/agent/core/tools/v3/runCommand';
import { createTaskOutputTool } from '../src/agent/core/tools/v3/taskOutput';
import {
  BackgroundTaskRegistry, RING_MAX, taskRegistryFor, killSessionTasks, killAllBackgroundTasks,
} from '../src/agent/core/tools/taskRegistry';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';
import { capMiddle } from '../src/agent/core/tools/capOutput';

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? `   (${detail})` : ''}`);
};

const SESSION = 'tm-e2e-bg';
type Exec = { execute: (a: unknown, o?: unknown) => Promise<string | { error: string }> };
const runCommand = createRunCommandTool({ sessionId: SESSION, allowBackground: true }) as Exec;
const taskOutput = createTaskOutputTool({ sessionId: SESSION }) as Exec;
/** Fetch INSIDE each section: killSessionTasks() between sections removes the registry from the
 *  session map, so a reference captured earlier watches a dead instance. */
const liveRegistry = () => taskRegistryFor(SESSION);

const isErr = (r: unknown): r is { error: string } => typeof r === 'object' && r !== null && 'error' in r;
const isStr = (r: unknown): r is string => typeof r === 'string';

/** Poll until cond() or timeout — a spawned process's close event is asynchronous. */
async function waitFor(what: string, cond: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond() ? true : (console.log(`  (timeout waiting: ${what})`), false);
}

async function main(): Promise<void> {
  console.log('— A background start returns at once, and the process keeps running —');
  await runWithWorkspaceRoot(process.cwd(), async () => {
    const registry = liveRegistry();
    const t0 = Date.now();
    const r = await runCommand.execute({ command: 'sleep 20 && echo done', background: true });
    const elapsed = Date.now() - t0;
    check('start returns immediately (<2s)', isStr(r) && elapsed < 2000, `${elapsed}ms`);
    check('result names the task id and the reader', isStr(r) && /bg\d+ started/.test(r) && r.includes('taskOutput'), isStr(r) ? r : '');
    const task = registry.list()[0];
    check('task is running, not waited on', task?.status === 'running');
    await taskOutput.execute({ taskId: task.id, action: 'stop' });
  });
  killSessionTasks(SESSION); // fresh registry (bg1…) for the next section

  console.log('\n— Reading is cursor-based: new output arrives, quiet reads say so —');
  await runWithWorkspaceRoot(process.cwd(), async () => {
    const registry = liveRegistry();
    const r = await runCommand.execute({ command: 'echo hello && sleep 8', background: true });
    const id = isStr(r) ? (r.match(/bg\d+/)?.[0] ?? '') : '';
    check('started', !!id, String(r));
    const got = await waitFor('first output', () => (registry.get(id)?.buffer ?? '').includes('hello'));
    check('output captured', got);
    const r1 = await taskOutput.execute({ taskId: id, waitMs: 200 });
    check('read returns the tail', isStr(r1) && r1.includes('hello'), String(r1));
    const r2 = await taskOutput.execute({ taskId: id, waitMs: 300 });
    check('quiet read reports no new output fast', isStr(r2) && r2.includes('no new output'), String(r2));
    await taskOutput.execute({ taskId: id, action: 'stop' });
  });
  killSessionTasks(SESSION);

  console.log('\n— No taskId lists every task; an unknown id is an error naming the known ones —');
  await runWithWorkspaceRoot(process.cwd(), async () => {
    const registry = liveRegistry();
    await runCommand.execute({ command: 'sleep 10', background: true });
    await runCommand.execute({ command: 'sleep 10', background: true });
    const lst = await taskOutput.execute({ action: 'list' });
    check('list shows both ids and commands', isStr(lst) && lst.includes('bg1') && lst.includes('bg2') && lst.includes('sleep 10'), String(lst));
    const lst2 = await taskOutput.execute({});
    check('empty call behaves like list', isStr(lst2) && lst2 === lst);
    const bad = await taskOutput.execute({ taskId: 'bg99' });
    check('unknown id errors with the roster', isErr(bad) && /Unknown task id/.test(bad.error) && bad.error.includes('bg1'), isErr(bad) ? bad.error : String(bad));
    const stopped = await taskOutput.execute({ taskId: 'bg1', action: 'stop' });
    check('stop kills and confirms', isStr(stopped) && stopped.includes('Stopped bg1'), String(stopped));
    const dead = await waitFor('kill lands', () => registry.get('bg1')?.status === 'killed');
    check('status is killed, not exited', dead && registry.get('bg1')?.status === 'killed');
  });
  killSessionTasks(SESSION);

  console.log('\n— The cap refuses, names its tenants, and frees on stop —');
  await runWithWorkspaceRoot(process.cwd(), async () => {
    for (let i = 0; i < 3; i++) await runCommand.execute({ command: `sleep 30 # server ${i + 1}`, background: true });
    const t0 = Date.now();
    const r4 = await runCommand.execute({ command: 'sleep 5', background: true });
    check('4th start refused', isErr(r4), String(r4));
    check('refusal is immediate', Date.now() - t0 < 1000);
    check('refusal names the tenants and the way out', isErr(r4) && /bg1/.test(r4.error) && /server 1/.test(r4.error) && r4.error.includes('"action":"stop"'), isErr(r4) ? r4.error : String(r4));
    await taskOutput.execute({ taskId: 'bg2', action: 'stop' });
    const r5 = await runCommand.execute({ command: 'sleep 5', background: true });
    check('a freed slot accepts a new task', isStr(r5) && /bg4 started/.test(r5), String(r5));
  });
  killSessionTasks(SESSION);

  console.log('\n— The ring buffer keeps the TAIL, not the head —');
  {
    // 20k lines ≈ 240KB against a ~64KB ring: line-1 must be gone, line-20000 must survive.
    const reg = new BackgroundTaskRegistry();
    const { task } = reg.start('for i in $(seq 1 20000); do echo "line-$i"; done', { cwd: os.tmpdir() }) ?? {};
    check('spawned', !!task);
    if (task) {
      await waitFor('command ends', () => task.status !== 'running', 15000);
      check(`buffer stays near the cap (≤${RING_MAX})`, task.buffer.length <= RING_MAX, String(task.buffer.length));
      check('tail survives', task.buffer.includes('line-20000'));
      check('head is dropped', !task.buffer.includes('line-1\n'));
    }
    reg.killAll();
  }

  console.log('\n— Synchronous output keeps its END: a test summary printed last survives the cap —');
  {
    const cmd = `node -e "for (let i = 0; i < 3000; i++) console.log('noise line ' + i); console.log('Tests: 3 failed, 12 passed')"`;
    const r = await runWithWorkspaceRoot(os.tmpdir(), () => runCommand.execute({ command: cmd }));
    check('the last line (the summary) is in the result', isStr(r) && r.includes('Tests: 3 failed, 12 passed'), isStr(r) ? r.slice(-300) : String(r));
    check('the first lines are kept too', isStr(r) && r.includes('noise line 0\n'), '');
    check('the cut is marked, not silent', isStr(r) && /omitted from the middle/.test(r), '');
    check('a clean exit says so', isStr(r) && r.includes('Exit code: 0'), isStr(r) ? r.slice(-200) : '');
    const m = capMiddle('HEAD\n' + 'x\n'.repeat(5000) + 'TAIL', 1000);
    check('capMiddle keeps head and tail within budget', m.startsWith('HEAD') && m.endsWith('TAIL') && m.length < 1100, String(m.length));
  }

  console.log('\n— Ring trim moves the read cursor with it: output after a trim is still "new" —');
  {
    const reg = new BackgroundTaskRegistry();
    const cmd = `node -e "process.stdout.write('x'.repeat(70000)); setTimeout(() => process.stdout.write('y'.repeat(20000) + 'LATE'), 400)"`;
    const t = reg.start(cmd, { cwd: os.tmpdir() }).task!;
    await waitFor('first burst', () => t.buffer.length >= 70_000);
    reg.read(t.id);
    await waitFor('second burst', () => t.buffer.includes('LATE'));
    check('buffer was trimmed past the old cursor position', t.buffer.length < 70_000 + 20_000, String(t.buffer.length));
    check('new output after the trim is unread (cursor moved with the trim)', t.buffer.length > t.readCursor, `${t.buffer.length} vs ${t.readCursor}`);
    check('unread part is exactly the new output', t.buffer.length - t.readCursor === 20_004, String(t.buffer.length - t.readCursor));
    reg.killAll();
  }

  console.log('\n— Idle sweep on an injected clock: 30 quiet minutes frees the slot, touch postpones it —');
  {
    let clock = 1_000_000;
    const reg = new BackgroundTaskRegistry(() => clock, 30 * 60 * 1000);
    const a = reg.start('sleep 600', { cwd: os.tmpdir() }).task!;
    clock += 10 * 60 * 1000; // b starts 10 min younger than a
    const b = reg.start('sleep 600', { cwd: os.tmpdir() }).task!;
    clock += 19 * 60 * 1000; reg.sweep(); // a: 29 min, b: 19 min
    check('29 quiet minutes: still running', a.status === 'running' && b.status === 'running');
    clock += 2 * 60 * 1000; reg.sweep(); // a: 31 min, b: 21 min
    check('31 quiet minutes: idle-timeout', a.status === 'idle-timeout', a.status);
    check('younger task survives the same sweep', b.status === 'running', b.status);
    clock += 8 * 60 * 1000; reg.touch(); reg.sweep(); // b: 29 min old, but just touched
    check('touch() at minute 29 keeps b alive', b.status === 'running', b.status);
    clock += 29 * 60 * 1000; reg.sweep(); // b: 58 min since output, 29 min since touch
    check('29 min after touch: still running', b.status === 'running', b.status);
    clock += 2 * 60 * 1000; reg.sweep(); // 31 min since touch
    check('untouched past the limit: killed', b.status === 'idle-timeout', b.status);
    const c = reg.start('sleep 600', { cwd: os.tmpdir() }).task!;
    clock += 25 * 60 * 1000; reg.read(c.id);
    clock += 25 * 60 * 1000; reg.sweep(); // 50 min since output, 25 since read
    check('a read also resets the idle clock', c.status === 'running', c.status);
    clock += 6 * 60 * 1000; reg.sweep(); // 31 min since read
    check('31 min after the last read: killed', c.status === 'idle-timeout', c.status);
    reg.killAll();
  }

  console.log('\n— Session delete kills only that session; shutdown kills everything —');
  await runWithWorkspaceRoot(process.cwd(), async () => {
    const registry = liveRegistry();
    await runCommand.execute({ command: 'sleep 30', background: true });       // SESSION
    const other = taskRegistryFor('tm-e2e-other');
    other.start('sleep 30', { cwd: os.tmpdir() });
    killSessionTasks(SESSION);
    check('session task killed', registry.list().every((t) => t.status !== 'running'));
    check("other session's task untouched", other.list().some((t) => t.status === 'running'));
    killAllBackgroundTasks();
    check('shutdown kills the rest', other.list().every((t) => t.status !== 'running'));
  });

  console.log('\n— Background stays out of read-only contexts —');
  await runWithWorkspaceRoot(process.cwd(), async () => {
    const plain = createRunCommandTool({ sessionId: 'x' }) as Exec; // no allowBackground
    const r = await plain.execute({ command: 'sleep 5', background: true });
    check('agent-mode flag required', isErr(r) && /agent mode only/.test(r.error), String(r));
    const ro = createRunCommandTool({ sessionId: 'x', readOnly: true }) as Exec;
    const r2 = await ro.execute({ command: 'sleep 5', background: true });
    check('read-only context refuses it earlier', isErr(r2) && /read-only/.test(r2.error), String(r2));
  });

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
