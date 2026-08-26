// v3 listDir / glob / grep — carried over from the legacy implementations (they were already
// gate-free), with the v3 exception-safe contract applied.

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { rgPath } from '@vscode/ripgrep';
import { tool } from 'ai';
import { z } from 'zod';
import { minimatch } from 'minimatch';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { resolveWorkspacePath } from '../resolvePath';
import { capToolOutput } from '../capOutput';
import { peekWorkspaceRoot } from '../workspaceRoot';

const LIST_MAX_CHARS = 10_000;
const GLOB_MAX_RESULTS = 200;
const GREP_MAX_OUTPUT = 20 * 1024;
const GREP_TIMEOUT_MS = 15_000;

export function createListDirTool() {
  return tool({
    description:
      'List the files and folders directly inside ONE workspace directory (non-recursive). '
      + 'Use `glob` when looking for files by name/pattern, `grep` when looking for content.',
    inputSchema: z.object({ path: z.string().optional().describe('Workspace-relative directory path (empty for the workspace root).') }),
    execute: async ({ path: rel }): Promise<string | { error: string }> => {
      try {
        const uri = resolveWorkspacePath(rel ?? '');
        let entries: [string, vscode.FileType][];
        try {
          entries = await vscode.workspace.fs.readDirectory(uri);
        } catch {
          return { error: `Directory not found: ${rel || '.'}` };
        }
        const lines = entries.map(([name, type]) => (type === vscode.FileType.Directory ? name + '/' : name));
        return lines.length ? capToolOutput(lines.join('\n'), LIST_MAX_CHARS, 'List a specific subdirectory to narrow.') : '(empty directory)';
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

/** Walk an ALS override root with minimatch (same skip-list as the legacy glob). */
async function globInRoot(root: string, pattern: string): Promise<string[]> {
  const matches: string[] = [];
  const seen = new Set<string>();
  const SKIP = new Set(['node_modules', '.git', '.tiermux-worktrees']);
  const stack: string[] = [root];
  while (stack.length) {
    if (matches.length >= GLOB_MAX_RESULTS) break;
    const dir = stack.pop()!;
    let entries: import('fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (matches.length >= GLOB_MAX_RESULTS) break;
      if (e.isDirectory() && SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (e.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (seen.has(rel)) continue;
      if (minimatch(rel, pattern, { dot: true })) {
        seen.add(rel);
        matches.push(rel);
      }
    }
  }
  return matches;
}

export function createGlobTool() {
  return tool({
    description:
      'Find files in the workspace matching a glob pattern (e.g. "src/**/*.ts"). Prefer over '
      + '`listDir` or a shell `ls`/`find` when looking for files BY NAME or extension. Caps at '
      + '200 results; make the pattern more specific rather than paging.',
    inputSchema: z.object({ pattern: z.string().describe('Glob pattern, relative to the workspace root.') }),
    execute: async ({ pattern }): Promise<string | { error: string }> => {
      try {
        if (!pattern) return { error: 'Missing required "pattern" argument.' };
        const override = peekWorkspaceRoot();
        if (override) {
          const list = await globInRoot(override, pattern);
          if (!list.length) return '(no matches)';
          return list.length >= GLOB_MAX_RESULTS
            ? `${list.join('\n')}\n…[capped at ${GLOB_MAX_RESULTS} matches — use a more specific pattern.]`
            : list.join('\n');
        }
        const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', GLOB_MAX_RESULTS);
        if (!files.length) return '(no matches)';
        const list = files.map((f) => vscode.workspace.asRelativePath(f)).join('\n');
        return files.length >= GLOB_MAX_RESULTS
          ? `${list}\n…[capped at ${GLOB_MAX_RESULTS} matches — use a more specific pattern.]`
          : list;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

export function createGrepTool(runAbort?: AbortSignal) {
  return tool({
    description:
      'Search file contents in the workspace for a regex pattern (ripgrep-backed). Results are '
      + '`path:line:text` per match. ALWAYS narrow the scope: pass `glob` (e.g. "*.ts") or `path` '
      + '(a subdirectory). Caps at 200 matches per file and ~20KB output.',
    inputSchema: z.object({
      pattern: z.string().describe('Regex pattern to search for.'),
      path: z.string().optional().describe('Workspace-relative path to search within (defaults to the whole workspace).'),
      glob: z.string().optional().describe('Glob to restrict which files are searched, e.g. "*.ts".'),
    }),
    execute: async ({ pattern, path: rel, glob }, options: { abortSignal?: AbortSignal } = {}): Promise<string | { error: string }> => {
      try {
        if (!pattern) return { error: 'Missing required "pattern" argument.' };
        const root = peekWorkspaceRoot() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) return { error: 'No workspace folder is open.' };
        const merged = runAbort || options.abortSignal
          ? AbortSignal.any([runAbort, options.abortSignal].filter((s): s is AbortSignal => !!s))
          : undefined;

        const rgArgs = ['--line-number', '--no-heading', '--color', 'never', '-m', '200'];
        if (glob) rgArgs.push('--glob', glob);
        rgArgs.push('--', pattern, rel && rel.length ? rel : '.');

        const out: string = await new Promise<string>((resolve, reject) => {
          let buf = '';
          let err = '';
          const child = spawn(rgPath, rgArgs, { cwd: root, signal: merged });
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`grep timed out after ${GREP_TIMEOUT_MS}ms.`));
          }, GREP_TIMEOUT_MS);
          child.stdout.on('data', (d) => { if (buf.length < GREP_MAX_OUTPUT) buf += d.toString(); });
          child.stderr.on('data', (d) => { if (err.length < GREP_MAX_OUTPUT) err += d.toString(); });
          child.on('error', (e) => { clearTimeout(timer); reject(e); });
          child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 1 && !buf) { resolve(''); return; }
            if (code !== 0 && code !== 1) { reject(new Error(err || `ripgrep exited with code ${code}`)); return; }
            resolve(buf);
          });
        });
        return capToolOutput(out.trim() || '(no matches)', GREP_MAX_OUTPUT, 'Add a "path" or "glob" filter, or a more specific pattern.');
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
