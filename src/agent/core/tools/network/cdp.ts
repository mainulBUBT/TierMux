// Thin CDP-over-pipe client — the zero-dependency browser backend for browserVerify. We talk to
// the user's own Chrome/Edge directly instead of bundling a driver (playwright-core) or a browser
// (Chromium/Kitesurf-class services): no keys, no backend, no size bloat, and the page renders in
// the engine the user actually runs. Protocol verified empirically against Chrome 156 on
// 2026-11-11 (scripts spike): spawn with stdio ['ignore','pipe','pipe','pipe','pipe'], WRITE
// JSON commands NUL-terminated to fd 3, READ JSON responses/events NUL-terminated from fd 4.
// First response can take ~3 s (headless startup) — sends carry their own timeout and the tool
// carries a hard deadline, so a slow or dead Chrome degrades into a verdict, never a hang.

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { killTree } from '../shell';

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

type EventHandler = (params: Record<string, unknown>, sessionId?: string) => void;

const DEFAULT_SEND_TIMEOUT_MS = 20_000;

/** Platform candidates, best first. Chrome before Edge before Chromium — the engine the user
 *  actually browses with is the one whose rendering we want to verify. */
const CHROME_CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
};

/** Resolution order: explicit override (bindings/e2e) → env (headless hosts) → platform
 *  candidates. An EXPLICIT override that does not exist wins over the candidates (returns
 *  undefined): a user who pointed at a specific binary wants that error surfaced, not a silent
 *  substitution — and the e2e disable-path depends on it. */
export function findChromePath(setting?: string): string | undefined {
  const explicit = [setting, process.env.TIERMUX_CHROME_PATH].find((p): p is string => !!p && p.trim().length > 0);
  const picks = explicit ? [explicit] : (CHROME_CANDIDATES[process.platform] ?? []);
  for (const p of picks) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch { /* not readable — next candidate */ }
  }
  return undefined;
}

export class CdpPipeClient {
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, Set<EventHandler>>();
  private buf = '';
  private dead: Error | undefined;
  private readonly userDataDir: string;

  private constructor(readonly child: ChildProcess) {
    this.userDataDir = (child.spawnargs.find((a) => a.startsWith('--user-data-dir=')) ?? '').slice('--user-data-dir='.length);
    const recv = this.child.stdio[4];
    if (!recv) throw new Error('CDP pipe not available — spawn did not yield fd 4.');
    recv.on('data', (d: Buffer) => this.onBytes(d));
    // A crashed or killed Chrome must reject every in-flight send: browserVerify awaits those,
    // and an unanswered promise would ride the tool's whole deadline for no information.
    this.child.on('exit', () => this.die(new Error('Chrome exited unexpectedly.')));
    this.child.on('error', (e) => this.die(new Error(`Chrome failed to start: ${e.message}`)));
  }

  static launch(chromePath: string): CdpPipeClient {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cdp-'));
    const child = spawn(chromePath, [
      '--headless=new',
      '--remote-debugging-pipe',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-component-update',
      'about:blank',
    ], {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', // own process group → killTree reaches the renderer/GPU children
      windowsHide: true,
    });
    return new CdpPipeClient(child);
  }

  /** NUL-terminated JSON both ways. One data event can carry several messages or half of one —
   *  buffer, split on the terminator, keep the remainder for the next chunk. */
  private onBytes(d: Buffer): void {
    this.buf += d.toString();
    let nul: number;
    while ((nul = this.buf.indexOf('\0')) >= 0) {
      const frame = this.buf.slice(0, nul);
      this.buf = this.buf.slice(nul + 1);
      if (!frame.trim()) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      try {
        msg = JSON.parse(frame);
      } catch { continue; } // a torn frame must not kill the stream
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      } else if (msg.method) {
        for (const fn of this.handlers.get(msg.method) ?? []) {
          try { fn(msg.params ?? {}, msg.sessionId); } catch { /* a listener bug must not kill the pump */ }
        }
      }
    }
  }

  private die(err: Error): void {
    if (this.dead) return;
    this.dead = err;
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  send(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs = DEFAULT_SEND_TIMEOUT_MS): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.nextId;
    const wire: Record<string, unknown> = { id, method, ...(params ? { params } : {}) };
    if (sessionId) wire.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        (this.child.stdio[3] as NodeJS.WritableStream).write(JSON.stringify(wire) + '\0');
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  on(method: string, fn: EventHandler): void {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method)!.add(fn);
  }

  /** Open a page target and attach with FLATTENED sessions (sessionId at message top level,
   *  the only mode modern Chrome supports) — page domains (Page/Runtime/Network/Fetch/Log) ride
   *  this session id. */
  async newPage(timeoutMs?: number): Promise<{ targetId: string; sessionId: string }> {
    const target = await this.send('Target.createTarget', { url: 'about:blank' }, undefined, timeoutMs) as { targetId: string };
    const attached = await this.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, undefined, timeoutMs) as { sessionId: string };
    return { targetId: target.targetId, sessionId: attached.sessionId };
  }

  /** Kill the process tree and remove the temp profile. Retry the rm once — Chrome's renderer
   *  children can hold profile files open for a moment after the group kill. */
  dispose(): void {
    try { killTree(this.child); } catch { /* already gone */ }
    const rm = (): void => { try { fs.rmSync(this.userDataDir, { recursive: true, force: true }); } catch { /* retried below */ } };
    rm();
    setTimeout(rm, 500).unref?.();
  }
}
