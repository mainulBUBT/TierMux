// runCommand — the toolApproval policy decides IF a command runs; this tool only runs it and
// reports. Exit code is always reported so a failing test/build never looks like success.

import * as vscode from 'vscode';
import { tool } from 'ai';
import { z } from 'zod';
import { capToolOutput } from '../capOutput';
import { resolveWorkspacePath } from '../resolvePath';
import { runShell } from '../shell';

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
        // Same containment as every other path-taking tool: `cwd: "../"` must not leave the
        // workspace (review 2026-09-05 — grep and runCommand were the two tools without it).
        const workdir = cwd && cwd.trim() ? resolveWorkspacePath(cwd).fsPath : root;
        const merged = bindings.abortSignal || options.abortSignal
          ? AbortSignal.any([bindings.abortSignal, options.abortSignal].filter((s): s is AbortSignal => !!s))
          : undefined;
        const timeout = Math.min(timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

        const res = await runShell(command, { cwd: workdir, timeoutMs: timeout, signal: merged, streamCap: STREAM_CAP });
        if (res.error?.startsWith('spawn failed')) return res.error;
        const body = [res.stdout, res.stderr].filter(Boolean).join('\n---stderr---\n') || '(no output)';
        const notes: string[] = [];
        if (res.error) notes.push(res.error.replace(/\.$/, ''));
        else if (res.exitCode !== 0 && res.exitCode !== null) notes.push(`Exit code: ${res.exitCode} (command FAILED)`);
        const withNotes = body + (notes.length ? `\n\n[${notes.join(' | ')}]` : '');
        return capToolOutput(withNotes, MAX_CHARS, 'Re-run piping through head/grep/tail to narrow the output.');
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
