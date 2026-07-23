

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { rgPath } from '@vscode/ripgrep';
import { tool } from 'ai';
import { z } from 'zod';
import { capToolOutput } from '../capOutput';

const MAX_OUTPUT = 20 * 1024;
const TIMEOUT_MS = 15_000;

export function createGrepTool() {
  return tool({
    description: 'Search file contents in the workspace for a regex pattern (ripgrep-backed).',
    inputSchema: z.object({
      pattern: z.string().describe('Regex pattern to search for.'),
      path: z.string().optional().describe('Workspace-relative path to search within (optional, defaults to the whole workspace).'),
      glob: z.string().optional().describe('Optional glob to restrict which files are searched, e.g. "*.ts".'),
    }),
    execute: async ({ pattern, path, glob }: { pattern: string; path?: string; glob?: string }) => {
      if (!pattern) throw new Error('Missing required "pattern" argument.');
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) throw new Error('No workspace folder is open.');
      const searchPath = path && path.length ? path : '.';

      const rgArgs = ['--line-number', '--no-heading', '--color', 'never', '-m', '200'];
      if (glob) rgArgs.push('--glob', glob);
      rgArgs.push('--', pattern, searchPath);

      return new Promise<string>((resolve, reject) => {
        let out = '';
        let err = '';
        const child = spawn(rgPath, rgArgs, { cwd: root });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`grep timed out after ${TIMEOUT_MS}ms.`));
        }, TIMEOUT_MS);
        child.stdout.on('data', (d) => { if (out.length < MAX_OUTPUT) out += d.toString(); });
        child.stderr.on('data', (d) => { if (err.length < MAX_OUTPUT) err += d.toString(); });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 1 && !out) { resolve('(no matches)'); return; }
          if (code !== 0 && code !== 1) { reject(new Error(err || `ripgrep exited with code ${code}`)); return; }
          resolve(capToolOutput(out.trim() || '(no matches)', MAX_OUTPUT, 'Add a "path" or "glob" filter, or a more specific pattern, to narrow results.'));
        });
      });
    },
  });
}
