// Per-turn prompt context — the Claude-Code-style environment block plus project rules and the
// user's standing memory, gathered ONCE per turn (the engine calls this before its first
// streamText pass and reuses the string for any continuation pass, so the system prefix stays
// byte-identical — good for provider prompt caches). Every source is individually guarded:
// a missing rules file, a non-git folder, or a headless host degrades to a shorter prompt, never
// to an error.

import * as vscode from 'vscode';
import * as nodeOs from 'os';
import { loadProjectRules } from './projectRules';
import { loadUserMemory } from './userMemory';
import { currentBranch } from '../edits/worktree';
import { statusLines } from '../edits/gitSnapshot';

/** Injection cap for project rules — loadProjectRules already caps at 8K, but a full 8K of
 *  rules on top of memory+env crowds small free-model context windows; 4K is the sane slice. */
const MAX_RULES_INJECT = 4_000;
const MAX_ENV_CHARS = 1_500;
const TTL_MS = 30_000;

export interface EnvFacts {
  date: string;
  os: string;
  workspaceName?: string;
  workspacePath?: string;
  branch?: string;
  dirtyCount?: number;
  openFiles?: number;
}

export interface PromptContext {
  rules: string;
  memory: string;
  env: EnvFacts;
}

async function gatherEnv(): Promise<EnvFacts> {
  const env: EnvFacts = {
    date: new Date().toISOString().slice(0, 10),
    os: `${process.platform} ${nodeOs.release()}`,
  };
  try {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (root) {
      env.workspacePath = root.fsPath;
      env.workspaceName = root.fsPath.split('/').filter(Boolean).pop();
      // Git facts — omitted (not error lines) outside a repo or when git is slow/absent.
      try { env.branch = await currentBranch(root.fsPath); } catch { /* not a repo */ }
      if (env.branch) {
        try { env.dirtyCount = (await statusLines(root.fsPath)).size; } catch { /* git failed */ }
      }
    }
  } catch { /* no workspace folder */ }
  try { env.openFiles = vscode.window.visibleTextEditors?.length; } catch { /* headless */ }
  return env;
}

let cache: { at: number; value: PromptContext } | undefined;

export async function gatherPromptContext(): Promise<PromptContext> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let rules = '';
  try { rules = await loadProjectRules(); } catch { /* absent */ }
  let memory = '';
  try { memory = await loadUserMemory(); } catch { /* absent */ }
  if (rules.length > MAX_RULES_INJECT) {
    rules = rules.slice(0, MAX_RULES_INJECT) + '\n…[project rules truncated]';
  }
  const value: PromptContext = { rules, memory, env: await gatherEnv() };
  cache = { at: Date.now(), value };
  return value;
}

/** Test hook — drops the memoized snapshot so the next gather re-reads everything. */
export function invalidatePromptContext(): void {
  cache = undefined;
}

/** The `<environment_context>` block — omitted lines when a fact is unavailable, never error lines. */
export function formatEnvBlock(env: EnvFacts): string {
  const lines = [
    `Date: ${env.date}`,
    `OS: ${env.os}`,
    ...(env.workspaceName ? [`Workspace: ${env.workspaceName}${env.workspacePath ? ` (${env.workspacePath})` : ''}`] : []),
    ...(env.branch ? [`Git: ${env.branch}${env.dirtyCount !== undefined ? ` · ${env.dirtyCount} dirty file${env.dirtyCount === 1 ? '' : 's'}` : ''}`] : []),
    ...(env.openFiles !== undefined ? [`Open files: ${env.openFiles}`] : []),
  ];
  return lines.join('\n').slice(0, MAX_ENV_CHARS);
}
