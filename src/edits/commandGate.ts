

import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';
import type { RunContext } from '../agent/runContext';
import { isDangerous, isReadOnlyCommand } from './commandClassify';
import { resolveWorkspacePath } from '../agent/core/tools/resolvePath';
import { peekWorkspaceRoot } from '../agent/core/tools/workspaceRoot';
import type { PersistentShellManager } from './persistentShell';

export type CommandApproval = 'always' | 'allowlist' | 'never';

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

const MAX_OUTPUT = 10 * 1024; // per stream

/** Safe-by-default inspection/test/build commands auto-runnable in 'allowlist' mode. */
const DEFAULT_ALLOWLIST = [
  'npm test', 'npm run', 'yarn test', 'pnpm test',
  'git status', 'git diff', 'git log', 'git branch', 'git show',
  'ls', 'pwd', 'cat', 'echo', 'tsc', 'node -v', 'npm -v',
  'pytest', 'go test', 'go build', 'cargo test', 'cargo check', 'cargo build',
  'php artisan test', 'composer test', 'make',
];

/** Re-exported so existing importers keep working — the canonical def lives in commandClassify. */
export { isDangerous } from './commandClassify';

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n…[output truncated]' : s;
}

export class CommandGate {
  /** When set, approval is requested in the chat view instead of a native modal. */
  private confirmViaUi?: (command: string, cwd?: string) => Promise<boolean>;
  /** Session toggle (from the composer): when true, skip the prompt for non-dangerous commands. */
  private autoApprove?: () => boolean;
  /** When set (and `ctx.sessionId` is present), commands run in that session's persistent
   *  terminal instead of a fresh one-shot spawn, so `cd`/env vars carry over between calls. */
  private shellManager?: PersistentShellManager;
  /** Every child process the gate has spawned and not yet waited on. Keyed by sessionId+requestId
   *  so a per-request stop can reach the in-flight shell AND its descendants — without this, the
   *  Stop button only cancelled the HTTP request, and `npm test` / `php artisan test` / long
   *  composer installs kept running in the background, holding the workspace hostage (live
   *  repro: a `php --version` finished seconds after Stop; the next `hola` then echoed a result
   *  computed against the *previous* project because that shell outlived the run). */
  private live = new Map<string, ChildProcess>();

  constructor(
    private readonly policy: () => CommandApproval,
    private readonly timeoutMs: () => number,
    private readonly extraAllowlist: () => string[],
  ) {}

  /** Route command approval through the webview (an inline Run/Skip card). Pass undefined to revert to the native modal. */
  setConfirmHandler(fn?: (command: string, cwd?: string) => Promise<boolean>): void {
    this.confirmViaUi = fn;
  }

  /** Provide a live read of the session Auto-approve toggle. */
  setAutoApprove(fn: () => boolean): void {
    this.autoApprove = fn;
  }

  /** Wire in a persistent-shell manager (native engine only). Pass undefined to revert to
   *  always spawning fresh, e.g. if shell integration turns out to be unavailable. */
  setShellManager(mgr?: PersistentShellManager): void {
    this.shellManager = mgr;
  }

  private root(): vscode.Uri {
    // Fleet-pipeline workers scope their commands to a worktree via the ALS root; the main-agent
    // path leaves it unset and uses the live workspace folder as before.
    const override = peekWorkspaceRoot();
    if (override) return vscode.Uri.file(override);
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) throw new Error('No workspace folder is open.');
    return folders[0].uri;
  }

  /** Resolve an optional cwd, confined to the workspace root. Delegates to the shared
   *  `resolveWorkspacePath` so `cwd` gets the same absolute-path normalization and
   *  segment-boundary containment check every path-taking tool uses — a bare `startsWith`
   *  prefix test accepted a sibling directory (`../Proj-backup` under root `../Proj`). */
  private resolveCwd(cwd?: string): string {
    const root = this.root();
    if (!cwd) return root.fsPath;
    try {
      return resolveWorkspacePath(cwd).fsPath;
    } catch {
      throw new Error(`cwd escapes the workspace: ${cwd}`);
    }
  }

  private isAllowlisted(command: string): boolean {
    const cmd = command.trim();
    return [...DEFAULT_ALLOWLIST, ...this.extraAllowlist()].some((p) => {
      const pre = p.trim();
      return !!pre && (cmd === pre || cmd.startsWith(pre + ' '));
    });
  }

  /** Decide whether to run, prompting the user when the policy requires it. */
  private async approve(command: string, cwd?: string, ctx?: RunContext): Promise<boolean> {
    const policy = this.policy();
    if (policy === 'never') return false;
    if (policy === 'allowlist' && this.isAllowlisted(command)) return true;
    // A confidently read-only command (ls, cat, git status/diff/log, grep, ...) doesn't need
    // the same approval friction as a mutating one — skip the ask-flow regardless of policy.
    // isReadOnlyCommand() fails closed (returns false) on anything it can't confidently
    // classify, so this can never be the reason a mutating command slips through.
    if (isReadOnlyCommand(command) && !isDangerous(command)) return true;

    const autoApprove = ctx ? ctx.autoApprove() : this.autoApprove?.();
    if (autoApprove && !isDangerous(command)) return true;

    const confirmViaUi = ctx ? ctx.approveCommand : this.confirmViaUi;
    if (confirmViaUi) return confirmViaUi(command, cwd);
    const choice = await vscode.window.showWarningMessage(
      `The agent wants to run a command:\n\n${command}`,
      { modal: true },
      'Run',
    );
    return choice === 'Run';
  }

  /** Bounds a model-requested per-call timeout override. Floors at 1s (a smaller value is almost
   *  certainly a mistake, not intent) and caps at 10 minutes — long enough for a real install/
   *  build, short enough that a stuck command still gets reported back within one turn. */
  private clampTimeout(overrideMs?: number): number {
    if (overrideMs === undefined || !Number.isFinite(overrideMs)) return this.timeoutMs();
    return Math.min(Math.max(overrideMs, 1_000), 600_000);
  }

  async run(command: string, cwd?: string, ctx?: RunContext, timeoutOverrideMs?: number): Promise<CommandResult> {
    const cmd = command.trim();
    if (!cmd) return { exitCode: null, stdout: '', stderr: '', error: 'Empty command.' };
    if (this.policy() === 'never') {
      return { exitCode: null, stdout: '', stderr: '', error: 'Command execution is disabled (tiermux.agent.commandApproval = "never").' };
    }
    if (!(await this.approve(cmd, cwd, ctx))) {
      return { exitCode: null, stdout: '', stderr: '', error: 'User declined to run the command.' };
    }
    return this.execute(cmd, cwd, ctx, this.clampTimeout(timeoutOverrideMs));
  }

  /**
   * Runs a command whose approval decision was already made by an external gate (the engine's
   * `toolApproval` policy) — skips `approve()` entirely so the user is never asked twice for the
   * same call. Still respects the hard `commandApproval: 'never'` off-switch as a safety net.
   */
  async runApproved(command: string, cwd?: string, ctx?: RunContext, timeoutOverrideMs?: number): Promise<CommandResult> {
    const cmd = command.trim();
    if (!cmd) return { exitCode: null, stdout: '', stderr: '', error: 'Empty command.' };
    if (this.policy() === 'never') {
      return { exitCode: null, stdout: '', stderr: '', error: 'Command execution is disabled (tiermux.agent.commandApproval = "never").' };
    }
    return this.execute(cmd, cwd, ctx, this.clampTimeout(timeoutOverrideMs));
  }

  private async execute(cmd: string, cwd: string | undefined, ctx: RunContext | undefined, timeoutMsOverride?: number): Promise<CommandResult> {
    const effectiveTimeout = timeoutMsOverride ?? this.timeoutMs();
    let workdir: string;
    try {
      workdir = this.resolveCwd(cwd);
    } catch (e) {
      return { exitCode: null, stdout: '', stderr: '', error: e instanceof Error ? e.message : String(e) };
    }

    if (this.shellManager && ctx?.sessionId) {
      try {
        const { stdout, exitCode } = await this.shellManager.run(ctx.sessionId, cmd, cwd ? workdir : undefined, effectiveTimeout);
        return { exitCode, stdout: truncate(stdout), stderr: '' };
      } catch {
        // Shell integration unavailable/never activated for this terminal — fall through to a
        // plain one-shot spawn below, exactly like Pochi's own PTY-then-spawn fallback.
      }
    }

    return new Promise<CommandResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (r: CommandResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (liveKey) this.live.delete(liveKey);
        if (ctx?.abortSignal) ctx.abortSignal.removeEventListener('abort', onAbort);
        resolve(r);
      };

      // detached:true puts the shell into its own process group so SIGTERM delivered to the
      // process-group hits the shell AND every descendant (`npm test` → node, `composer install`
      // → php, `php artisan test` → phpunit). A bare `child.kill()` without detached mode only
      // kills the top-level shell, which the shell then ignores and lets the kids keep running.
      // windowsHide keeps a quick-flick terminal window from flashing up on Windows during the
      // kill. The setpgid-on-Linux branch is a no-op on macOS/Windows (detached still does the
      // right thing), and the kill helper below picks the platform-correct signal.
      const child = spawn(cmd, { cwd: workdir, shell: true, detached: process.platform !== 'win32', windowsHide: true });
      const liveKey = ctx?.sessionId && ctx.requestId ? `${ctx.sessionId}::${ctx.requestId}` : undefined;
      if (liveKey) this.live.set(liveKey, child);

      // Honour the same Stop button the HTTP route already does: this gives the user's abort
      // one path that reaches every tool, not just the provider call. Without it, a long-running
      // `npm test` (the most common blocking command) survives Stop and keeps the workspace
      // pinned to the old request.
      const onAbort = (): void => {
        try { this.killTree(child); } catch { /* best effort */ }
        finish({ exitCode: null, stdout: truncate(stdout), stderr: truncate(stderr), error: 'Aborted.' });
      };
      if (ctx?.abortSignal) {
        if (ctx.abortSignal.aborted) onAbort();
        else ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      const timer = setTimeout(() => {
        try { this.killTree(child); } catch { /* best effort */ }
        finish({ exitCode: null, stdout: truncate(stdout), stderr: truncate(stderr), error: `Command timed out after ${effectiveTimeout}ms.` });
      }, effectiveTimeout);

      child.stdout?.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString(); });
      child.stderr?.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });
      child.on('error', (err) => finish({ exitCode: null, stdout: truncate(stdout), stderr: truncate(stderr), error: err.message }));
      child.on('close', (code) => finish({ exitCode: code, stdout: truncate(stdout), stderr: truncate(stderr) }));
    });
  }

  /** Force-kill the shell and (POSIX) its entire process group. On Windows we fall back to
   *  taskkill /T /F — the only reliable tree-kill there. SIGTERM first (graceful), SIGKILL
   *  after a 250ms grace so a hung test still dies fast. */
  private static readonly KILL_GRACE_MS = 250;
  private killScheduled = new WeakSet<ChildProcess>();
  private killTree(child: ChildProcess): void {
    if (this.killScheduled.has(child)) return;
    this.killScheduled.add(child);
    if (process.platform === 'win32') {
      // /T = tree, /F = force. Without /T, the shell dies but its children (phpunit, node, …)
      // keep running and the workspace stays pinned to the abandoned run.
      try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: true }).on('error', () => {}); } catch { /* ignore */ }
      return;
    }
    if (typeof child.pid === 'number' && child.pid > 0) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* group may already be gone */ }
    } else {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    setTimeout(() => {
      if (typeof child.pid === 'number' && child.pid > 0) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group may already be gone */ }
      } else {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, CommandGate.KILL_GRACE_MS);
  }

  /** Cancel every command the given session/request is currently running. Called by the host
   *  on Stop/Abort, BEFORE the route-level AbortController fires so the in-flight shell dies
   *  even when the agent loop is mid-`await getCommandGate().runApproved(...)`. Idempotent. */
  cancel(ctx: { sessionId: string; requestId: string }): void {
    const key = `${ctx.sessionId}::${ctx.requestId}`;
    const child = this.live.get(key);
    if (child) this.killTree(child);
  }
}
