

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { rgPath } from '@vscode/ripgrep';

const MAX_MATCHES = 200;
const TIMEOUT_MS = 10_000;

/** Grep-style text search across the workspace, ripgrep-backed — used by chatViewProvider's
 *  `/grep` command and its autocomplete-as-you-type variant. Best-effort: returns [] on any
 *  failure (no workspace open, ripgrep error, timeout) rather than throwing. */
export async function findTextInWorkspace(pattern: string): Promise<Array<{ path: string; lineNumber: number; lineText: string }>> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root || !pattern.trim()) return [];

  return new Promise((resolve) => {
    const rgArgs = ['--line-number', '--no-heading', '--color', 'never', '-m', String(MAX_MATCHES), '--', pattern, '.'];
    let out = '';
    const child = spawn(rgPath, rgArgs, { cwd: root });
    const timer = setTimeout(() => { child.kill(); resolve([]); }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve([]); });
    child.on('close', () => {
      clearTimeout(timer);
      const results: Array<{ path: string; lineNumber: number; lineText: string }> = [];
      for (const line of out.split('\n')) {
        const m = line.match(/^(.+?):(\d+):(.*)$/);
        if (m) results.push({ path: m[1], lineNumber: parseInt(m[2], 10), lineText: m[3] });
      }
      resolve(results.slice(0, MAX_MATCHES));
    });
  });
}
