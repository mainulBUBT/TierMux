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
import { currentBranch, statusLines } from '../edits/gitSnapshot';
import { resolveVerifyCommand } from '../agent/core/tools/workspace/verifyCommand';
import { gatherProjectMap, formatFileMap, formatSymbolMap, attachSymbolsToMap, MAX_FILES_LISTED } from './fileMap';

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
  /** The project's verify command (manifest-detected or the setting) — stated up front so the
   *  model does not spend a search round discovering how the project is tested. */
  verifyCommand?: string;
}

export interface PromptContext {
  rules: string;
  memory: string;
  env: EnvFacts;
  /** The workspace's file layout — plan mode renders it (see composeSystemPrompt). */
  fileMap?: string;
  /** `path — symbol, symbol` sketch of source files, freshest first — rendered for agent/ask
   *  turns. Undefined when the symbol map is off (setting or small model window). */
  symbolMap?: string;
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
  try { env.verifyCommand = resolveVerifyCommand(); } catch { /* no workspace */ }
  return env;
}

let cache: { at: number; value: PromptContext; budget?: number } | undefined;

/** `symbolBudget` — chars for the source-symbol sketch, from the routed model's window
 *  (engine computes symbolBudgetForWindow). undefined skips the sketch entirely; the cache is
 *  keyed on it so a small-window turn never reuses a big-window sketch. */
export async function gatherPromptContext(symbolBudget?: number): Promise<PromptContext> {
  if (cache && Date.now() - cache.at < TTL_MS && cache.budget === symbolBudget) return cache.value;
  // Rules, memory and the environment block are independent reads — awaiting them
  // sequentially made the pre-turn gate pay the sum of five fs/git round-trips on every
  // message (2026-09-19). Run them concurrently; each is individually guarded.
  const [rules, memory, env, projectMap, symbolsOn] = await Promise.all([
    loadProjectRules().catch(() => ''),
    loadUserMemory().catch(() => ''),
    gatherEnv(),
    gatherProjectMap().catch(() => undefined),
    symbolMapEnabled(),
  ]);
  const safeRules = rules.length > MAX_RULES_INJECT
    ? rules.slice(0, MAX_RULES_INJECT) + '\n…[project rules truncated]'
    : rules;
  // Plan mode renders the symbol-ANNOTATED tree (names + inline symbols, 09b961b); agent/ask
  // render the flat sketch below instead — never both.
  const fileMap = projectMap
    ? (projectMap.symbols.size && projectMap.files.length <= MAX_FILES_LISTED
        ? attachSymbolsToMap(formatFileMap(projectMap.files), projectMap.symbols)
        : formatFileMap(projectMap.files))
    : undefined;
  const symbolMap = projectMap && symbolsOn && symbolBudget !== undefined && projectMap.symbols.size
    ? formatSymbolMap(projectMap, symbolBudget)
    : undefined;
  const value: PromptContext = { rules: safeRules, memory, env, fileMap, symbolMap };
  cache = { at: Date.now(), value, budget: symbolBudget };
  return value;
}

/** `tiermux.agent.symbolMap`, default on — a per-workspace opt-out for monorepos whose sketch
 *  crowds the prompt (and for anyone who pays per input token). Guarded: headless hosts degrade
 *  to ON, never to an error. */
function symbolMapEnabled(): boolean {
  try {
    return vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('symbolMap', true);
  } catch { return true; }
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
    ...(env.verifyCommand ? [`Verify command (the host runs it after your edits): ${env.verifyCommand}`] : []),
  ];
  return lines.join('\n').slice(0, MAX_ENV_CHARS);
}
