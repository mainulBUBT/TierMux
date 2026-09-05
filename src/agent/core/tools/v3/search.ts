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
import { effectiveRootUri, peekWorkspaceRoot } from '../workspaceRoot';

const LIST_MAX_CHARS = 10_000;
const GLOB_MAX_RESULTS = 200;
const GREP_MAX_OUTPUT = 20 * 1024;
const GREP_TIMEOUT_MS = 15_000;
/** Ceiling on `context` (2026-09-05). Not a re-send bound — compact.ts's `ageToolOutputs`
 *  already stubs any tool result over 2k chars once it leaves the last three tool messages,
 *  and grep is first in its REDERIVABLE_TOOLS list, so a fat grep lives for ~3 steps, not the
 *  whole turn. This is a per-CALL bound: every context line multiplies the per-file volume
 *  (`-m 200` counts MATCHED lines only), and past 10 a wide-context grep is a readFile with a
 *  worse marker. Enforced by the schema alone — the SDK filters a call that fails validation
 *  out of execution, so no runtime clamp is needed. */
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
      + '`path:line:text` per match; with `context`, surrounding lines appear as `path-line-text` '
      + 'and `--` separates non-adjacent groups; with `filesOnly`, one matching path per line and '
      + 'nothing else (`context` is ignored). ALWAYS narrow the scope: pass `glob` (e.g. "*.ts") '
      + 'or `path` (a subdirectory). Use `filesOnly` when you only need WHICH files match, and '
      + '`context` when you need the surrounding lines — both avoid a follow-up readFile. Caps at '
      + '200 matches per file (line mode) and ~20KB output.',
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
        // Same containment every other path-taking tool has (resolvePath.ts). grep was the one
        // tool handing its `path` to a subprocess raw, so `../` or an absolute path searched
        // OUTSIDE the workspace — and `filesOnly` had just made enumerating a sibling tree
        // cheap and quiet (review 2026-09-05). Search stays rooted at cwd so hits print
        // workspace-relative, as before.
        const root = effectiveRootUri().fsPath;
        const target = rel && rel.trim() ? path.relative(root, resolveWorkspacePath(rel).fsPath) || '.' : '.';
        const merged = runAbort || options.abortSignal
          ? AbortSignal.any([runAbort, options.abortSignal].filter((s): s is AbortSignal => !!s))
          : undefined;

        // -l prints paths only; rg silently ignores -n/-C/-m alongside it, so don't pass them.
        const rgArgs = ['--no-heading', '--color', 'never'];
        if (filesOnly) {
          rgArgs.push('--files-with-matches');
        } else {
          rgArgs.push('--line-number', '-m', '200');
          if (context) rgArgs.push('--context', String(context));
        }
        if (ignoreCase) rgArgs.push('--ignore-case');
        if (glob) rgArgs.push('--glob', glob);
        rgArgs.push('--', pattern, target);

        const out = await new Promise<{ text: string; capped: boolean }>((resolve, reject) => {
          let buf = '';
          let err = '';
          let capped = false;
          let settled = false;
          const child = spawn(rgPath, rgArgs, { cwd: root, signal: merged });
          const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
          const timer = setTimeout(() => {
            child.kill();
            done(() => reject(new Error(`grep timed out after ${GREP_TIMEOUT_MS}ms.`)));
          }, GREP_TIMEOUT_MS);
          child.stdout.on('data', (d: Buffer) => {
            if (capped) return;
            buf += d.toString();
            // Stop rg the moment the cap is reached. Before this it kept scanning the whole
            // tree with its output discarded, until it finished or the 15s timer fired — and
            // the timer REJECTED, throwing away the 20KB already in hand. `context` made that
            // ~21x more likely (200 matches × 21 lines fills the cap inside one file).
            if (buf.length >= GREP_MAX_OUTPUT) {
              capped = true;
              buf = buf.slice(0, GREP_MAX_OUTPUT);
              child.kill();
            }
          });
          child.stderr.on('data', (d: Buffer) => { if (err.length < GREP_MAX_OUTPUT) err += d.toString(); });
          child.on('error', (e) => done(() => reject(e)));
          child.on('close', (code) => done(() => {
            // A capped run was killed by us: the buffer IS the result. Otherwise rg's exit
            // codes are 0 = matches, 1 = none, 2 = SOME path errored — and 2 arrives with the
            // matches it did find still on stdout (one chmod-000 dir, a dangling symlink, a
            // root-owned cache). Only an EMPTY buffer with a non-1 exit is a failure.
            if (capped || buf) { resolve({ text: buf, capped }); return; }
            if (code === 1 || code === 0) { resolve({ text: '', capped: false }); return; }
            reject(new Error(err.trim() || `ripgrep exited with code ${code}`));
          }));
        });
        const hint = filesOnly
          ? 'Add a "path" or "glob" filter, or a more specific pattern.'
          : 'Add a "path" or "glob" filter, a more specific pattern, or pass filesOnly:true to get just the paths.';
        const text = out.text.trim() || '(no matches)';
        // A capped run was stopped mid-search, so the true total is unknown — say so rather
        // than let capToolOutput print "N of M" against the clipped buffer (the review's
        // repro: 720KB of matches reported as "45,056 of 65,536 chars omitted").
        return out.capped
          ? `${text}\n…[truncated at ${GREP_MAX_OUTPUT.toLocaleString()} chars — search stopped early, more matches exist. ${hint}]`
          : capToolOutput(text, GREP_MAX_OUTPUT, hint);
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
