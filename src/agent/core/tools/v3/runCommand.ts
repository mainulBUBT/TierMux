// v3 runCommand — shell execution WITHOUT CommandGate: the toolApproval policy decides IF a
// command runs; this tool only runs it and reports. Direct spawn with a timeout, abort
// tree-kill, and per-stream output caps (same limits the old gate enforced).
// Exit code is always reported — a failing test/build must never look like success.

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { tool } from 'ai';
import { z } from 'zod';
import { capToolOutput } from '../capOutput';

const MAX_CHARS = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const STREAM_CAP = 10 * 1024;

export interface CommandBindings {
  abortSignal?: AbortSignal;
  sessionId?: string;
  requestId?: string;
}

export function createRunCommandTool(bindings: CommandBindings = {}) {
  return tool({
    description:
      'Run a shell command in the workspace and return its output (stdout+stderr+exit code). '
      + 'Commands are killed after the default timeout (~2 min) — for installs/builds/test '
      + 'suites pass `timeoutMs` up front (capped at 10 min).',
    inputSchema: z.object({
      command: z.string().describe('The shell command to run.'),
      cwd: z.string().optional().describe('Workspace-relative working directory (optional).'),
      timeoutMs: z.number().optional().describe('Timeout for this command in milliseconds (capped at 600000).'),
    }),
    execute: async ({ command, cwd, timeoutMs }, options: { abortSignal?: AbortSignal } = {}): Promise<string | { error: string }> => {
      try {
        if (!command) return { error: 'Missing required "command" argument.' };
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) return { error: 'No workspace folder is open.' };
        const merged = bindings.abortSignal || options.abortSignal
          ? AbortSignal.any([bindings.abortSignal, options.abortSignal].filter((s): s is AbortSignal => !!s))
          : undefined;

        const timeout = Math.min(timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
        const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
        const args = process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-lc', command];

        return await new Promise<string>((resolve) => {
          let out = '';
          let err = '';
          let timedOut = false;
          const child = spawn(shell, args, {
            cwd: cwd ? `${root}/${cwd.replace(/^\/+/, '')}` : root,
            signal: merged,
          });
          const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
          }, timeout);
          child.stdout?.on('data', (d) => { if (out.length < STREAM_CAP) out += d.toString(); });
          child.stderr?.on('data', (d) => { if (err.length < STREAM_CAP) err += d.toString(); });
          child.on('error', (e) => {
            clearTimeout(timer);
            resolve(`spawn failed: ${e.message}`);
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            const body = [out, err].filter(Boolean).join('\n---stderr---\n') || '(no output)';
            const notes: string[] = [];
            if (timedOut) notes.push(`Command timed out after ${timeout}ms and was killed`);
            else if (code !== 0 && code !== null) notes.push(`Exit code: ${code} (command FAILED)`);
            const withNotes = body + (notes.length ? `\n\n[${notes.join(' | ')}]` : '');
            resolve(capToolOutput(withNotes, MAX_CHARS, 'Re-run piping through head/grep/tail to narrow the output.'));
          });
        });
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
