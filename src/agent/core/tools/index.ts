

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
import type { AgentOpts } from '../../agent';
import type { McpManager } from '../../../mcp/mcpManager';
import type { Router } from '../../../router/router';
import { MUTATING_TOOLS, PLAN_MODE_EXTRA_EXCLUDED_TOOLS } from '../policies/permission';
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
import { createImplementPipelineTool } from './fleet/implementPipeline';
import { createDiagnosticsTool } from './workspace/diagnostics';
import { createSymbolGraphTool } from './workspace/symbolGraph';
import { createDependencyTreeTool } from './workspace/dependencyTree';
import { createFetchUrlTool } from './network/fetchUrl';
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

export function createToolSet(opts: AgentOpts, mcp: McpManager | undefined, router: Router): ToolSet {
  // Typed as ToolSet so the empty branch spreads as "no keys" rather than being inferred as
  // `{ getSymbolGraph: undefined }`, which does not satisfy ToolSet's index signature.
  const graphTools: ToolSet = graphToolsEnabled()
    ? { getSymbolGraph: createSymbolGraphTool(), getDependencyTree: createDependencyTreeTool() }
    : {};
  // Ask mode: read-only codebase search only — no edit/write/delete/shell. Router.route()
  // streams fine with tools attached (routerProvider.ts accumulates tool-call deltas
  // internally), so this no longer needs the "zero tools" workaround it once did.
  if (opts.mode === 'ask') {
    return {
      readFile: createReadTool(),
      listDir: createListDirTool(),
      glob: createGlobTool(),
      grep: createGrepTool(),
      ...graphTools,
      explore: createExploreTool(router, opts.abortSignal),
      webSearch: createWebSearchTool(),
      fetchUrl: createFetchUrlTool(),
      deepSearch: createDeepSearchTool(),
    };
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
    webSearch: createWebSearchTool(),
    deepSearch: createDeepSearchTool(),
    explore: createExploreTool(router, opts.abortSignal),
    implementPipeline: createImplementPipelineTool(router, opts.abortSignal),
    todowrite: createTodoWriteTool(opts.onTodos),
    question: createQuestionTool(opts.onAskUser),
    remember: createRememberTool(),
    ...createMcpTools(mcp),
  };

  if (opts.mode === 'agent') return all;

  // plan mode: the model never even sees a mutating tool's schema, rather than showing it
  // and denying execution at call time (defense-in-depth mirrored in policies/permission.ts).
  // Also excludes low-risk-but-side-effecting tools (e.g. `remember`) that aren't gated by
  // approval but still shouldn't run during a mode that's meant to produce zero side effects.
  const filtered: ToolSet = {};
  for (const [name, t] of Object.entries(all)) {
    if (MUTATING_TOOLS.has(name) || PLAN_MODE_EXTRA_EXCLUDED_TOOLS.has(name)) continue;
    filtered[name] = t;
  }
  // Plan-mode-only pre-flight clarify tool (replaces the ???QUESTIONS??? text sentinel as the
  // primary channel — see clarify.ts, which stays as the fallback). Deliberately not in `all`:
  // agent/ask mode already have `question` for mid-task clarification, a different UX (different
  // UI card, different resend/history semantics) — offering both here would be redundant.
  filtered.askQuestions = createAskQuestionsTool();
  return filtered;
}
