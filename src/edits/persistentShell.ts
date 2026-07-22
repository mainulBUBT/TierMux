

import * as vscode from 'vscode';
import { stripAnsi, posixQuote } from './terminalUtil';

const ACTIVATION_TIMEOUT_MS = 3000;
const MAX_OUTPUT = 10 * 1024;

/**
 * One persistent `vscode.Terminal` per chat session, driven via the stable Terminal Shell
 * Integration API (`executeCommand`/`read`/`onDidEndTerminalShellExecution`) — so `cd`/exported
 * env vars from one `runCommand` tool call carry over to the next, matching what a real
 * developer shell does. Chosen over bundling `node-pty` (what Pochi does) specifically to avoid
 * native-module/Electron-ABI packaging risk; the terminal is also visible to the user, which
 * doubles as an inspectable log of everything the agent ran.
 *
 * Shell integration activates asynchronously and isn't guaranteed (Command Prompt doesn't
 * support it; some shell setups can conflict) — `run()` throws if it never activates within
 * `ACTIVATION_TIMEOUT_MS`, so the caller (CommandGate) can fall back to a plain one-shot spawn.
 */
export class PersistentShellManager {
  private readonly terminals = new Map<string, vscode.Terminal>();

  private getOrCreateTerminal(sessionId: string, cwd: string): vscode.Terminal {
    const existing = this.terminals.get(sessionId);
    if (existing && existing.exitStatus === undefined) return existing;
    const term = vscode.window.createTerminal({ name: `TierMux Agent (${sessionId.slice(0, 8)})`, cwd });
    this.terminals.set(sessionId, term);
    return term;
  }

  private waitForShellIntegration(term: vscode.Terminal, timeoutMs: number): Promise<vscode.TerminalShellIntegration | undefined> {
    if (term.shellIntegration) return Promise.resolve(term.shellIntegration);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { sub.dispose(); resolve(term.shellIntegration); }, timeoutMs);
      const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === term) {
          clearTimeout(timer);
          sub.dispose();
          resolve(e.shellIntegration);
        }
      });
    });
  }

  /**
   * Runs `command` in this session's persistent shell. `explicitCwd`, when given, is `cd`-ed
   * into before the command; when omitted, the command runs wherever the shell already is
   * (its own root cwd on first creation, or wherever an earlier command's own `cd` left it) —
   * that's the entire point of reusing one terminal instead of a fresh `spawn()` per call.
   * Throws if shell integration never activates; caller should fall back to a plain spawn.
   */
  async run(sessionId: string, command: string, explicitCwd: string | undefined, timeoutMs: number): Promise<{ stdout: string; exitCode: number | null }> {
    const term = this.getOrCreateTerminal(sessionId, explicitCwd ?? '.');
    const shellIntegration = await this.waitForShellIntegration(term, ACTIVATION_TIMEOUT_MS);
    if (!shellIntegration) throw new Error('Shell integration not available for this terminal/shell.');

    const fullCommand = explicitCwd ? `cd ${posixQuote(explicitCwd)} && (${command})` : command;
    const execution = shellIntegration.executeCommand(fullCommand);
    const stream = execution.read();

    let out = '';
    let exitCode: number | null = null;
    let settled = false;

    const endPromise = new Promise<void>((resolve) => {
      const sub = vscode.window.onDidEndTerminalShellExecution((e) => {
        if (e.execution === execution) {
          exitCode = e.exitCode ?? null;
          settled = true;
          sub.dispose();
          resolve();
        }
      });
    });
    const readPromise = (async () => {
      for await (const chunk of stream) {
        if (out.length < MAX_OUTPUT) out += stripAnsi(chunk);
      }
    })();
    const timeoutPromise = new Promise<void>((resolve) => { setTimeout(resolve, timeoutMs); });

    await Promise.race([Promise.all([endPromise, readPromise]), timeoutPromise]);

    if (!settled) {
      return { stdout: `${out.trim()}\n…[command timed out after ${timeoutMs}ms; it may still be running in the "TierMux Agent" terminal]`, exitCode: null };
    }
    return { stdout: out.trim(), exitCode };
  }

  /** Disposes every session's terminal — call on extension deactivate. */
  dispose(): void {
    for (const t of this.terminals.values()) t.dispose();
    this.terminals.clear();
  }
}
