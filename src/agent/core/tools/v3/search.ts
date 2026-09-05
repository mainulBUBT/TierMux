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
/** Ceiling on `context` (2026-09-05). Each context line is re-sent on every remaining step of
 *  the turn (see capOutput.ts), so an unbounded -C turns one grep into a whole-file read by
 *  another name — which is the cost this option exists to avoid. */
const MAX_CONTEXT_LINES = 10;

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
      + '(a subdirectory). Use `filesOnly` when you only need WHICH files match, and `context` '
      + 'when you need the surrounding lines — both avoid a follow-up readFile. '
      + 'Caps at 200 matches per file and ~20KB output.',
    inputSchema: z.object({
      pattern: z.string().describe('Regex pattern to search for.'),
      path: z.string().optional().describe('Workspace-relative path to search within (defaults to the whole workspace).'),
      glob: z.string().optional().describe('Glob to restrict which files are searched, e.g. "*.ts".'),
      context: z.number().int().min(0).max(MAX_CONTEXT_LINES).optional()
        .describe(`Lines of surrounding context to show around each match (0-${MAX_CONTEXT_LINES}). Use this instead of reading the whole file.`),
      filesOnly: z.boolean().optional()
        .describe('Return only the paths of files that contain a match, one per line — no line numbers, no matched text. Far smaller output when the question is "where is X used?".'),
      ignoreCase: z.boolean().optional().describe('Case-insensitive match.'),
    }),
    execute: async (
      { pattern, path: rel, glob, context, filesOnly, ignoreCase },
      options: { abortSignal?: AbortSignal } = {},
    ): Promise<string | { error: string }> => {
      try {
        if (!pattern) return { error: 'Missing required "pattern" argument.' };
        const root = peekWorkspaceRoot() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) return { error: 'No workspace folder is open.' };
        const merged = runAbort || options.abortSignal
          ? AbortSignal.any([runAbort, options.abortSignal].filter((s): s is AbortSignal => !!s))
          : undefined;

        // `-l` prints paths only, so line numbers/context are meaningless with it — rg would
        // accept them and silently ignore them, but keeping the argv honest makes the failure
        // mode (if any) legible in a trace.
        const rgArgs = ['--no-heading', '--color', 'never'];
        if (filesOnly) {
          rgArgs.push('--files-with-matches');
        } else {
          rgArgs.push('--line-number', '-m', '200');
          if (context && context > 0) rgArgs.push('--context', String(Math.min(context, MAX_CONTEXT_LINES)));
        }
        if (ignoreCase) rgArgs.push('--ignore-case');
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
        const hint = filesOnly
          ? 'Add a "path" or "glob" filter, or a more specific pattern.'
          : 'Add a "path" or "glob" filter, a more specific pattern, or pass filesOnly:true to get just the paths.';
        return capToolOutput(out.trim() || '(no matches)', GREP_MAX_OUTPUT, hint);
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
