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
  /** Per-stream cap in chars; output past it is dropped. */
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

export function runShell(command: string, opts: ShellOptions): Promise<ShellResult> {
  const cap = opts.streamCap ?? 10 * 1024;
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
  const args = process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-lc', command];
  return new Promise<ShellResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: ShellResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const child = spawn(shell, args, { cwd: opts.cwd, detached: process.platform !== 'win32', windowsHide: true });
    const onAbort = (): void => {
      killTree(child);
      finish({ exitCode: null, stdout, stderr, error: 'Aborted.' });
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      killTree(child);
      finish({ exitCode: null, stdout, stderr, error: `Command timed out after ${opts.timeoutMs}ms and was killed.` });
    }, opts.timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < cap) stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < cap) stderr += d.toString(); });
    child.on('error', (e) => finish({ exitCode: null, stdout, stderr, error: `spawn failed: ${e.message}` }));
    child.on('close', (code) => finish({ exitCode: code, stdout, stderr }));
  });
}
