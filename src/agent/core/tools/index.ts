

// The only "registry"-shaped code left — a mode -> tool-subset filter + factory caller, not a
// dispatcher (the AI SDK's own tools: {...} record and toolApproval gate own execution).
//
// Every create*Tool() factory below closes over session-scoped data (onTodos, onAskUser, ...)
// instead of reading it from ToolExecutionOptions.context. That's a deliberate workaround, not
// a stylistic choice:
//
// AI SDK 7.0.34:
// runtimeContext currently does not propagate into
// ToolExecutionOptions.context despite documentation.
//
// Tools therefore capture session state via closures.
//
// Re-check on future AI SDK upgrades.
import * as vscode from 'vscode';
import type { ToolSet } from 'ai';
import type { AgentOpts, AgentMode } from '../../agent';
import type { McpManager } from '../../../mcp/mcpManager';
import type { Router } from '../../../router/router';
import { FILE_MUTATING_TOOLS, PLAN_MODE_EXTRA_EXCLUDED_TOOLS } from '../policies/permission';
import { createReadTool } from './filesystem/read';
import { createWriteFileTool } from './filesystem/write';
import { createEditTool } from './filesystem/edit';
import { createDeleteTool } from './filesystem/delete';
import { createShellTool } from './shell/bash';
import { createListDirTool } from './workspace/list';
import { createGlobTool } from './workspace/glob';
import { createGrepTool } from './workspace/grep';
import { createTodoWriteTool } from './ui/todo';
import { createQuestionTool } from './ui/question';
import { createMcpTools } from './mcp/mcp';
import { createExploreTool } from './explore';
import { createDelegateTool } from './delegate';
import { createImplementPipelineTool } from './fleet/implementPipeline';
import { createDiagnosticsTool } from './workspace/diagnostics';
import { createSymbolGraphTool } from './workspace/symbolGraph';
import { createDependencyTreeTool } from './workspace/dependencyTree';
import { createFetchUrlTool } from './network/fetchUrl';
import { createCheckUrlTool } from './network/checkUrl';
import { createWebSearchTool } from './network/webSearch';
import { createDeepSearchTool } from './network/deepSearch';
import { createRememberTool } from './context/remember';
import { createAskQuestionsTool } from './ui/askQuestions';

/** `tiermux.graph.enabled` — whether the structural code-graph tools are offered at all.
 *
 *  This setting shipped declared-but-never-read: package.json advertised `false` ("opt in for
 *  refactor-heavy work") while both tools were registered unconditionally on every turn, for
 *  every user, in both mode branches below. Toggling it did nothing. Now it gates them for real,
 *  and the default flipped to `true` so the behaviour everyone has actually been getting is what
 *  the setting describes — turning it OFF is the change, not on. */
function graphToolsEnabled(): boolean {
  return vscode.workspace.getConfiguration('tiermux.graph').get<boolean>('enabled', true);
}

// ── Small-window essential toolset ──────────────────────────────────────────────────────
// How open-source small-context agents stay viable: they do not offer big tool surfaces.
// Cline runs ~10 tools in total; aider uses none (chat-format edits) and sends a graph-ranked
// signature "repo map" instead of file bodies. The full TierMux agent set is 22 tools ≈ 6.3k
// tokens of schema — 20–40% of a 16–32k free-tier window before a single message (the same
// 2026-08-25 "loses context / does wrong work" repro that made the prune budget
// overhead-aware). Below the limit the model gets the minimal edit loop only.

/** The minimal navigate→edit→verify loop plus the two protocol tools the prompts and the step
 *  engine reference BY NAME (todowrite is the checklist contract; the system prompt routes
 *  clarifications through `question`). writeFile upserts, so createFile adds nothing here. */
const ESSENTIAL_TOOLS = new Set([
  'readFile', 'writeFile', 'editFile', 'listDir', 'glob', 'grep',
  'runCommand', 'getDiagnostics', 'todowrite', 'question',
]);

/** Context windows strictly below this get the essential-only set (undefined/0 → full set,
 *  the safe default when the window isn't known). 40k sits between the 32k and 64k catalog
 *  bands: at 64k+ the ~6.3k schema cost is noise; at 32k and below it is a fifth of the
 *  window or more. */
export const SMALL_WINDOW_TOOLS_LIMIT = 40_000;

/** Mode-critical tools the essential filter must never remove — plan mode's pre-flight
 *  clarify channel (its prompts, stopWhen, and the clarify flow key on it). */
const MODE_CRITICAL_TOOLS: Partial<Record<AgentMode, string[]>> = {
  plan: ['askQuestions'],
};

/** True when `contextWindowTokens` is a known window small enough to warrant the essential
 *  set. Exported for the toolset-budget e2e. */
export function isSmallToolsetWindow(contextWindowTokens: number | undefined): boolean {
  return typeof contextWindowTokens === 'number' && contextWindowTokens > 0 && contextWindowTokens < SMALL_WINDOW_TOOLS_LIMIT;
}

/** Keep only ESSENTIAL_TOOLS (∪ the mode's critical tools) from an already mode-filtered
 *  set. Intersection, never addition: a tool the mode didn't offer stays unavailable. */
function toEssential(set: ToolSet, mode: AgentMode): ToolSet {
  const keep = new Set([...ESSENTIAL_TOOLS, ...(MODE_CRITICAL_TOOLS[mode] ?? [])]);
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(set)) if (keep.has(name)) out[name] = t;
  return out;
}

export function createToolSet(opts: AgentOpts, mcp: McpManager | undefined, router: Router, contextWindowTokens?: number): ToolSet {
  const essential = isSmallToolsetWindow(contextWindowTokens);
  // Typed as ToolSet so the empty branch spreads as "no keys" rather than being inferred as
  // `{ getSymbolGraph: undefined }`, which does not satisfy ToolSet's index signature.
  const graphTools: ToolSet = graphToolsEnabled()
    ? { getSymbolGraph: createSymbolGraphTool(), getDependencyTree: createDependencyTreeTool() }
    : {};
  // Ask mode: read-only codebase search plus shell — no file write/edit/delete. `runCommand` is
  // allowed here so the model can run status/inspection commands (tests, git diff, a linter) while
  // discussing; permission.ts denies any command that isn't read-only outside agent mode, so this
  // cannot be used to touch the workspace. Router.route() streams fine with tools attached (routerProvider.ts
  // accumulates tool-call deltas internally), so this no longer needs the "zero tools" workaround
  // it once did.
  if (opts.mode === 'ask') {
    const set: ToolSet = {
      readFile: createReadTool(),
      listDir: createListDirTool(),
      glob: createGlobTool(),
      grep: createGrepTool(),
      runCommand: createShellTool(),
      ...graphTools,
      explore: createExploreTool(router, opts.abortSignal),
      delegate: createDelegateTool(router, opts.abortSignal),
      checkUrl: createCheckUrlTool(),
      webSearch: createWebSearchTool(),
      fetchUrl: createFetchUrlTool(),
      deepSearch: createDeepSearchTool(),
    };
    return essential ? toEssential(set, opts.mode) : set;
  }

  const all: ToolSet = {
    writeFile: createWriteFileTool(false),
    createFile: createWriteFileTool(true),
    editFile: createEditTool(),
    deleteFile: createDeleteTool(),
    runCommand: createShellTool(),
    readFile: createReadTool(),
    listDir: createListDirTool(),
    glob: createGlobTool(),
    grep: createGrepTool(),
    ...graphTools,
    getDiagnostics: createDiagnosticsTool(),
    fetchUrl: createFetchUrlTool(),
    checkUrl: createCheckUrlTool(),
    webSearch: createWebSearchTool(),
    deepSearch: createDeepSearchTool(),
    explore: createExploreTool(router, opts.abortSignal),
    delegate: createDelegateTool(router, opts.abortSignal),
    implementPipeline: createImplementPipelineTool(router, opts.abortSignal),
    todowrite: createTodoWriteTool(opts.onTodos),
    question: createQuestionTool(opts.onAskUser),
    remember: createRememberTool(),
    ...createMcpTools(mcp),
  };

  if (opts.mode === 'agent') return essential ? toEssential(all, opts.mode) : all;

  // plan mode: the model never even sees a file-mutating tool's schema, rather than showing it
  // and denying execution at call time (defense-in-depth mirrored in policies/permission.ts).
  // `runCommand` stays in the set — plan mode is for brainstorming/gathering info with the model
  // (and its subagents), which includes running read/inspection commands, not just file edits.
  // Also excludes low-risk-but-side-effecting tools (e.g. `remember`) that aren't gated by
  // approval but still shouldn't run during a mode that's meant to produce zero file-write side
  // effects.
  // MCP tool names are collected before filtering: an MCP server exposes arbitrary third-party
  // tools, including writing ones, and nothing in FILE_MUTATING_TOOLS knows their names. Leaving
  // them in plan mode meant a mode documented as producing zero side effects could call any write
  // tool a connected server happened to offer. Excluding the whole namespace is the only safe
  // rule available — we cannot introspect an arbitrary server's side effects.
  const mcpToolNames = new Set(Object.keys(createMcpTools(mcp)));
  const filtered: ToolSet = {};
  for (const [name, t] of Object.entries(all)) {
    if (FILE_MUTATING_TOOLS.has(name) || PLAN_MODE_EXTRA_EXCLUDED_TOOLS.has(name)) continue;
    if (mcpToolNames.has(name)) continue;
    filtered[name] = t;
  }
  // Plan-mode-only pre-flight clarify tool (replaces the ???QUESTIONS??? text sentinel as the
  // primary channel — see clarify.ts, which stays as the fallback). Deliberately not in `all`:
  // agent/ask mode already have `question` for mid-task clarification, a different UX (different
  // UI card, different resend/history semantics) — offering both here would be redundant.
  filtered.askQuestions = createAskQuestionsTool();
  return essential ? toEssential(filtered, opts.mode) : filtered;
}
