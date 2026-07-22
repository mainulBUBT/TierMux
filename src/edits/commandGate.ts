

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import type { RunContext } from '../agent/runContext';
import { isReadOnlyCommand } from './commandClassify';
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

/**
 * Destructive patterns that always prompt for confirmation, even when Auto-approve
 * is on — a safety net so unattended runs can't silently wipe data or rewrite history.
 */
const DANGEROUS = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, // rm -rf / rm -fr / rm -r -f …
  /\bgit\s+push\b.*(--force|-f\b)/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\b.*-[a-z]*f/i,
  /\b(sudo|chmod|chown)\b/i,
  /\b(mkfs|dd|shutdown|reboot|kill(all)?)\b/i,
  /\bnpm\s+publish\b/i,
  /[>]\s*\/dev\//i, // writing to device files
  /:\s*\(\s*\)\s*\{/, // fork-bomb shape :(){ :|:& };:
];

/** True for commands too destructive to run unattended; these always ask, even in Auto-approve. */
export function isDangerous(command: string): boolean {
  return DANGEROUS.some((re) => re.test(command));
}

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
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) throw new Error('No workspace folder is open.');
    return folders[0].uri;
  }

  /** Resolve an optional cwd, confined to the workspace root. */
  private resolveCwd(cwd?: string): string {
    const root = this.root();
    if (!cwd) return root.fsPath;
    const uri = vscode.Uri.joinPath(root, cwd.replace(/^\/+/, ''));
    if (!uri.path.startsWith(root.path)) throw new Error(`cwd escapes the workspace: ${cwd}`);
    return uri.fsPath;
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

  async run(command: string, cwd?: string, ctx?: RunContext): Promise<CommandResult> {
    const cmd = command.trim();
    if (!cmd) return { exitCode: null, stdout: '', stderr: '', error: 'Empty command.' };
    if (this.policy() === 'never') {
      return { exitCode: null, stdout: '', stderr: '', error: 'Command execution is disabled (tiermux.agent.commandApproval = "never").' };
    }
    if (!(await this.approve(cmd, cwd, ctx))) {
      return { exitCode: null, stdout: '', stderr: '', error: 'User declined to run the command.' };
    }
    return this.execute(cmd, cwd, ctx);
  }

  /**
   * Runs a command whose approval decision was already made by an external gate (the engine's
   * `toolApproval` policy) — skips `approve()` entirely so the user is never asked twice for the
   * same call. Still respects the hard `commandApproval: 'never'` off-switch as a safety net.
   */
  async runApproved(command: string, cwd?: string, ctx?: RunContext): Promise<CommandResult> {
    const cmd = command.trim();
    if (!cmd) return { exitCode: null, stdout: '', stderr: '', error: 'Empty command.' };
    if (this.policy() === 'never') {
      return { exitCode: null, stdout: '', stderr: '', error: 'Command execution is disabled (tiermux.agent.commandApproval = "never").' };
    }
    return this.execute(cmd, cwd, ctx);
  }

  private async execute(cmd: string, cwd: string | undefined, ctx: RunContext | undefined): Promise<CommandResult> {
    let workdir: string;
    try {
      workdir = this.resolveCwd(cwd);
    } catch (e) {
      return { exitCode: null, stdout: '', stderr: '', error: e instanceof Error ? e.message : String(e) };
    }

    if (this.shellManager && ctx?.sessionId) {
      try {
        const { stdout, exitCode } = await this.shellManager.run(ctx.sessionId, cmd, cwd ? workdir : undefined, this.timeoutMs());
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
        resolve(r);
      };

      const child = spawn(cmd, { cwd: workdir, shell: true });
      const timer = setTimeout(() => {
        child.kill();
        finish({ exitCode: null, stdout: truncate(stdout), stderr: truncate(stderr), error: `Command timed out after ${this.timeoutMs()}ms.` });
      }, this.timeoutMs());

      child.stdout?.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString(); });
      child.stderr?.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });
      child.on('error', (err) => finish({ exitCode: null, stdout: truncate(stdout), stderr: truncate(stderr), error: err.message }));
      child.on('close', (code) => finish({ exitCode: code, stdout: truncate(stdout), stderr: truncate(stderr) }));
    });
  }
}
