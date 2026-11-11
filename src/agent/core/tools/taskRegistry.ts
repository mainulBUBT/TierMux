// Background task registry — long-running processes (dev servers, watchers, big builds) that
// outlive the turn which started them. runCommand is one-shot: a `npm run dev` blocks the tool
// call for its whole 10-min cap, so the agent literally cannot keep a dev server alive while it
// works. Keyed by sessionId at module level because the toolset (and its closures) are rebuilt
// EVERY TURN — a per-build registry would forget tasks between turns. Same stable-map pattern
// opencodeLane.ts uses for session ids.
//
// Lifecycle — a task dies on: explicit stop (taskOutput action:"stop"), idle timeout (no output
// AND no reads for BACKGROUND_IDLE_TIMEOUT_MS — a forgotten dev server must not hold a slot
// forever), session deletion (killSessionTasks) or extension deactivate (killAllBackgroundTasks).
// The turn's abortSignal deliberately does NOT reach here: Stop ends the turn, not the server
// the turn started — otherwise `background` would just be a worse timeout.

import { spawn, type ChildProcess } from 'child_process';
import { killTree } from './shell';

export const MAX_BACKGROUND_TASKS = 3;
export const BACKGROUND_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const RING_CAP = 64 * 1024;
/** Re-append slack: slicing on every data event is O(n²) on chatty servers; trim in batches. */
const RING_SLACK = 16 * 1024;
/** Hard upper bound the ring can reach between trims — exported for the e2e bound check. */
export const RING_MAX = RING_CAP + RING_SLACK;
const SWEEP_INTERVAL_MS = 30_000;

export type TaskStatus = 'running' | 'exited' | 'killed' | 'idle-timeout';

export interface BackgroundTask {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: number;
  status: TaskStatus;
  exitCode: number | null;
  /** Set when the task did not run to completion: spawn failure, stop, idle timeout. */
  note?: string;
  /** Combined stdout+stderr — a server interleaves both; separating them buys nothing for a tail. */
  buffer: string;
  lastOutputAt: number;
  lastReadAt: number;
  /** Buffer length at the last taskOutput read, so "wait for NEW output" is a cursor, not a snapshot. */
  readCursor: number;
  child?: ChildProcess;
}

export interface StartResult {
  task?: BackgroundTask;
  error?: string;
}

function ageMs(from: number, now: number): string {
  const s = Math.max(0, Math.round((now - from) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export class BackgroundTaskRegistry {
  private tasks = new Map<string, BackgroundTask>();
  private seq = 0;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private now: () => number = Date.now,
    private idleTimeoutMs: number = BACKGROUND_IDLE_TIMEOUT_MS,
  ) {}

  /** Spawn detached like runShell does (own process group → killTree reaches descendants), but
   *  with no timeout and output kept in a ring buffer instead of a one-shot resolve. */
  start(command: string, opts: { cwd: string; sessionId?: string; signal?: AbortSignal }): StartResult {
    if (!command.trim()) return { error: 'Missing required "command" argument.' };
    const running = this.list().filter((t) => t.status === 'running');
    if (running.length >= MAX_BACKGROUND_TASKS) {
      // Naming the tenants lets the model pick one to stop instead of guessing or spawning more.
      const tenants = running.map((t) => `${t.id} (${ageMs(t.startedAt, this.now())}) ${t.command}`).join('; ');
      return { error: `Background task limit (${MAX_BACKGROUND_TASKS}) reached. Running: ${tenants}. Stop one first: taskOutput {"taskId":"${running[0].id}","action":"stop"}.` };
    }
    const id = `bg${++this.seq}`;
    const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
    const args = process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-lc', command];
    const now = this.now();
    const task: BackgroundTask = {
      id, command, cwd: opts.cwd, startedAt: now,
      status: 'running', exitCode: null, buffer: '',
      lastOutputAt: now, lastReadAt: now, readCursor: 0,
    };
    try {
      task.child = spawn(shell, args, { cwd: opts.cwd, detached: process.platform !== 'win32', windowsHide: true });
    } catch (e) {
      task.status = 'exited';
      task.note = `spawn failed: ${e instanceof Error ? e.message : String(e)}`;
      this.tasks.set(id, task);
      return { task };
    }
    const append = (d: Buffer): void => {
      task.buffer += d.toString();
      if (task.buffer.length > RING_CAP + RING_SLACK) task.buffer = task.buffer.slice(-RING_CAP);
      task.lastOutputAt = this.now();
    };
    task.child.stdout?.on('data', append);
    task.child.stderr?.on('data', append);
    task.child.on('error', (e) => {
      if (task.status === 'running') { task.status = 'exited'; task.note = `spawn failed: ${e.message}`; }
    });
    task.child.on('close', (code) => {
      task.exitCode = code;
      if (task.status === 'running') task.status = 'exited';
      this.maybeStopSweeping();
    });
    this.tasks.set(id, task);
    this.ensureSweeping();
    console.log(`[tiermux] background ${id} started (session ${opts.sessionId ?? '-'}): ${command}`);
    return { task };
  }

  list(): BackgroundTask[] {
    // Map preserves insertion order = start order (bg1, bg2, …).
    return [...this.tasks.values()];
  }

  get(id: string): BackgroundTask | undefined {
    return this.tasks.get(id);
  }

  /** Read (and advance) the read cursor — every read resets the idle clock, so an agent actively
   *  polling a quiet server keeps it alive. */
  read(id: string): BackgroundTask | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    t.lastReadAt = this.now();
    t.readCursor = t.buffer.length;
    return t;
  }

  /** Reset the idle clock without consuming output. browserVerify calls this (all tasks) around
   *  navigation: a dev server that only serves HTTP produces no output and is never read while
   *  being verified — without a touch it could be idle-killed mid-verify. */
  touch(id?: string): void {
    const now = this.now();
    if (id) { const t = this.tasks.get(id); if (t && t.status === 'running') t.lastReadAt = now; return; }
    for (const t of this.tasks.values()) if (t.status === 'running') t.lastReadAt = now;
  }

  stop(id: string): BackgroundTask | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    if (t.status === 'running') {
      if (t.child) killTree(t.child);
      t.status = 'killed';
      t.note = 'Stopped by taskOutput.';
      console.log(`[tiermux] background ${id} stopped: ${t.command}`);
    }
    this.maybeStopSweeping();
    return t;
  }

  /** Kill every task whose last activity (output or read) is older than the idle timeout.
   *  Public so tests can drive it with an injected clock instead of waiting real minutes. */
  sweep(): void {
    const now = this.now();
    for (const t of this.tasks.values()) {
      if (t.status !== 'running') continue;
      const lastActive = Math.max(t.lastOutputAt, t.lastReadAt);
      if (now - lastActive < this.idleTimeoutMs) continue;
      if (t.child) killTree(t.child);
      t.status = 'idle-timeout';
      t.note = `Idle ${ageMs(lastActive, now)} (no output, no reads) — killed to free a background slot.`;
      console.log(`[tiermux] background ${t.id} idle-timeout: ${t.command}`);
    }
    this.maybeStopSweeping();
  }

  killAll(): void {
    for (const t of this.tasks.values()) {
      if (t.status === 'running') {
        if (t.child) killTree(t.child);
        t.status = 'killed';
        t.note = 'Killed at shutdown.';
      }
    }
    this.maybeStopSweeping();
  }

  private ensureSweeping(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.(); // never hold the extension host (or an e2e process) open
  }

  private maybeStopSweeping(): void {
    if (!this.sweepTimer) return;
    if (this.tasks.size > 0 && this.list().some((t) => t.status === 'running')) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }
}

// ── Session-keyed registries ────────────────────────────────────────────────────────────────

const registries = new Map<string, BackgroundTaskRegistry>();

export function taskRegistryFor(sessionId?: string): BackgroundTaskRegistry {
  const key = sessionId || '-';
  let r = registries.get(key);
  if (!r) { r = new BackgroundTaskRegistry(); registries.set(key, r); }
  return r;
}

/** Session deletion is the real "session abort": the Stop button ends a TURN (tasks survive —
 *  that is the point of background), but deleting the session must not orphan its servers. */
export function killSessionTasks(sessionId: string): void {
  registries.get(sessionId)?.killAll();
  registries.delete(sessionId);
}

/** Extension deactivate — no orphan processes past a window reload. */
export function killAllBackgroundTasks(): void {
  for (const r of registries.values()) r.killAll();
  registries.clear();
}

/** Format a task line for list/read results. */
export function formatTaskLine(t: BackgroundTask, now: number): string {
  const state = t.status === 'running'
    ? `running ${ageMs(t.startedAt, now)}`
    : `${t.status}${t.exitCode !== null ? ` (exit ${t.exitCode})` : ''}`;
  return `${t.id}  ${state}  ${t.command}`;
}
