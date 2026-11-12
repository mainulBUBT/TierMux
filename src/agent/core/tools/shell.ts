// One-shot shell execution shared by the runCommand tool and the verify gate. Spawns detached
// (own process group) so an abort or timeout kills the shell AND its descendants — `npm test`
// → node, `composer install` → php. A bare child.kill() only reaches the shell, and the
// children kept running past Stop (live repro: a `php --version` finished seconds after Stop
// and the next turn read a result computed against the previous project).

import { spawn, type ChildProcess } from 'child_process';

export interface ShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command did not run to completion: aborted, timed out, or failed to spawn. */
  error?: string;
}

export interface ShellOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Per-stream cap in chars. Past it the stream keeps its first quarter and a rolling tail,
   *  with a marker where the middle was dropped. */
  streamCap?: number;
}

const KILL_GRACE_MS = 250;

/** SIGTERM the process group, SIGKILL after a short grace; taskkill /T /F on Windows. */
export function killTree(child: ChildProcess): void {
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: true }).on('error', () => {}); } catch { /* ignore */ }
    return;
  }
  const pid = typeof child.pid === 'number' && child.pid > 0 ? -child.pid : undefined;
  try { if (pid) process.kill(pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => {
    try { if (pid) process.kill(pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already gone */ }
  }, KILL_GRACE_MS);
}

/** Bounded collector for one output stream: a fixed head plus a rolling tail. A head-only cap
 *  dropped exactly the part that matters — a test run's summary and stack tails come last. */
class HeadTail {
  private head = '';
  private tail = '';
  private dropped = 0;
  constructor(private readonly headCap: number, private readonly tailCap: number) {}
  push(chunk: string): void {
    if (this.head.length < this.headCap) {
      const take = chunk.slice(0, this.headCap - this.head.length);
      this.head += take;
      chunk = chunk.slice(take.length);
    }
    if (!chunk) return;
    this.tail += chunk;
    if (this.tail.length > this.tailCap * 2) {
      const cut = this.tail.length - this.tailCap;
      this.dropped += cut;
      this.tail = this.tail.slice(cut);
    }
  }
  toString(): string {
    let tail = this.tail;
    let dropped = this.dropped;
    if (tail.length > this.tailCap) {
      dropped += tail.length - this.tailCap;
      tail = tail.slice(-this.tailCap);
    }
    if (dropped === 0) return this.head + tail;
    const nl = tail.indexOf('\n');
    if (nl !== -1 && nl < 200) { dropped += nl + 1; tail = tail.slice(nl + 1); }
    return `${this.head}\n…[${dropped.toLocaleString()} chars of output omitted from the middle]…\n${tail}`;
  }
}

export function runShell(command: string, opts: ShellOptions): Promise<ShellResult> {
  const cap = opts.streamCap ?? 10 * 1024;
  const headCap = Math.floor(cap / 4);
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
  const args = process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-lc', command];
  return new Promise<ShellResult>((resolve) => {
    const out = new HeadTail(headCap, cap - headCap);
    const err = new HeadTail(headCap, cap - headCap);
    let settled = false;
    const finish = (r: Omit<ShellResult, 'stdout' | 'stderr'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ ...r, stdout: out.toString(), stderr: err.toString() });
    };
    const child = spawn(shell, args, { cwd: opts.cwd, detached: process.platform !== 'win32', windowsHide: true });
    const onAbort = (): void => {
      killTree(child);
      finish({ exitCode: null, error: 'Aborted.' });
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      killTree(child);
      finish({ exitCode: null, error: `Command timed out after ${opts.timeoutMs}ms and was killed.` });
    }, opts.timeoutMs);
    // setEncoding: a multi-byte character split across two chunks decodes whole, not as U+FFFD.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => out.push(d));
    child.stderr?.on('data', (d: string) => err.push(d));
    child.on('error', (e) => finish({ exitCode: null, error: `spawn failed: ${e.message}` }));
    child.on('close', (code) => finish({ exitCode: code }));
  });
}
