// Runs shell commands for the agent's `runCommand` tool, behind an approval
// policy. Commands run in the workspace root with a timeout; stdout/stderr are
// captured (truncated) and returned to the model so it can verify and self-heal.
import * as vscode from 'vscode';
import { spawn } from 'child_process';

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

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n…[output truncated]' : s;
}

export class CommandGate {
  /** When set, approval is requested in the chat view instead of a native modal. */
  private confirmViaUi?: (command: string, cwd?: string) => Promise<boolean>;

  constructor(
    private readonly policy: () => CommandApproval,
    private readonly timeoutMs: () => number,
    private readonly extraAllowlist: () => string[],
  ) {}

  /** Route command approval through the webview (an inline Run/Skip card). Pass undefined to revert to the native modal. */
  setConfirmHandler(fn?: (command: string, cwd?: string) => Promise<boolean>): void {
    this.confirmViaUi = fn;
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
  private async approve(command: string, cwd?: string): Promise<boolean> {
    const policy = this.policy();
    if (policy === 'never') return false;
    if (policy === 'allowlist' && this.isAllowlisted(command)) return true;
    // Prefer an inline approval card in the chat view; fall back to a native modal.
    if (this.confirmViaUi) return this.confirmViaUi(command, cwd);
    const choice = await vscode.window.showWarningMessage(
      `The agent wants to run a command:\n\n${command}`,
      { modal: true },
      'Run',
    );
    return choice === 'Run';
  }

  async run(command: string, cwd?: string): Promise<CommandResult> {
    const cmd = command.trim();
    if (!cmd) return { exitCode: null, stdout: '', stderr: '', error: 'Empty command.' };
    if (this.policy() === 'never') {
      return { exitCode: null, stdout: '', stderr: '', error: 'Command execution is disabled (tiermux.agent.commandApproval = "never").' };
    }
    if (!(await this.approve(cmd, cwd))) {
      return { exitCode: null, stdout: '', stderr: '', error: 'User declined to run the command.' };
    }

    let workdir: string;
    try {
      workdir = this.resolveCwd(cwd);
    } catch (e) {
      return { exitCode: null, stdout: '', stderr: '', error: e instanceof Error ? e.message : String(e) };
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
