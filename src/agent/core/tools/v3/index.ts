// The tool registry. Each tool is tool()-form with a Zod schema, an exception-safe execute
// (expected failures return { error }), and NO embedded approval — the streamText
// `toolApproval` policy (src/permissions/policy.ts) decides IF a mutating tool runs.

export { createReadFileTool } from './readFile';
export { createEditFileTool } from './editFile';
export { createWriteFileTool, createDeleteFileTool } from './filesystemOps';
export { createListDirTool, createGlobTool, createGrepTool } from './search';
export { createRunCommandTool } from './runCommand';
export { createTodoWriteTool } from './todoWrite';
export { createGetDiagnosticsTool } from './getDiagnostics';
export { createAskUserTool } from './askUser';
export { createDelegateTaskTool } from './delegateTask';
export { createExitPlanModeTool } from './exitPlanMode';

import type { ToolSet } from 'ai';
import type { Mode } from '../../../../shared/types';
import type { TodoItem, ProposedPlan } from '../../../../shared/types';
import { createReadFileTool } from './readFile';
import { createEditFileTool } from './editFile';
import { createWriteFileTool, createDeleteFileTool } from './filesystemOps';
import { createListDirTool, createGlobTool, createGrepTool } from './search';
import { createRunCommandTool } from './runCommand';
import { createTodoWriteTool } from './todoWrite';
import { createGetDiagnosticsTool } from './getDiagnostics';
import { createAskUserTool } from './askUser';
import { createDelegateTaskTool } from './delegateTask';
import { createExitPlanModeTool } from './exitPlanMode';
import { createWebSearchTool } from '../network/webSearch';
import { createFetchUrlTool } from '../network/fetchUrl';
import { createMcpTools } from '../mcp/mcp';
import { getMcpManager } from '../mcp/manager';

/** Tools that never mutate anything — the permission policy auto-approves these (plan §3).
 *  `showTodo` is a legacy name kept for the set's historical shape; the live tool is `todoWrite`. */
export const READ_ONLY_TOOLS = new Set([
  'readFile', 'listDir', 'glob', 'grep', 'getDiagnostics', 'getSymbolGraph',
  'getDependencyTree', 'webSearch', 'delegateTask', 'fetchUrl', 'showTodo', 'todoWrite', 'askUser', 'recallNotes', 'checkPlan',
  // exitPlanMode writes nothing — it hands a structured plan to the host and ends the turn.
  // Approval of the PLAN happens on the card afterwards, so gating the tool itself would just
  // put an "Allow exitPlanMode?" prompt in front of the real approval UI.
  'exitPlanMode',
]);

export interface ToolsetBindings {
  abortSignal?: AbortSignal;
  sessionId?: string;
  requestId?: string;
  onTodos?: (todos: TodoItem[]) => void;
  /** Mid-turn clarifying-question channel — the toolset binds it as the `askUser` tool.
   *  The host implementation renders an in-chat card and resolves with the user's answer
   *  ('' when dismissed). Unset (e2e/sub-agent contexts) → the tool degrades to `{ error }`. */
  onAskUser?: (question: string, options?: string[]) => Promise<string>;
  /** Checkpoint baseline — fires INSIDE a write tool, after the pre-write content is read but
   *  BEFORE the mutation (`before` null = create). Capturing it from onStepEnd instead ran
   *  after the write, so Undo restored post-edit content (2026-08-28). */
  onBeforeWrite?: (uri: import('vscode').Uri, before: string | null) => void;
  /** Plan-mode boundary — fires when the model calls `exitPlanMode` with its finished plan.
   *  The engine captures it into AgentResult.plan and stops the turn; the host renders the
   *  plan card from this STRUCTURE instead of re-deriving it from the reply text. */
  onPlanProposed?: (plan: ProposedPlan) => void;
}

/** Build the mode-filtered ToolSet. `plan`: read/search + shell (policy asks) + exitPlanMode,
 *  the ONLY exit; `ask`: read/search + read-only shell; `agent`: everything. File mutators are
 *  absent AND policy-denied outside agent mode. Return type pinned to ToolSet because the
 *  branches no longer share a key set. */
export function buildV3ToolSet(mode: Mode, bindings: ToolsetBindings = {}): ToolSet {
  const readFile = createReadFileTool();
  const listDir = createListDirTool();
  const glob = createGlobTool();
  const grep = createGrepTool(bindings.abortSignal);
  const todoWrite = createTodoWriteTool(bindings.onTodos);
  // Web tools are read-only and keyless (TierMux's own engine: Yahoo/DDG/Marginalia + a
  // static-fetch reader) — offered in EVERY mode so "today's weather" style questions are
  // answerable instead of deflected. Restored from the v2 toolset after live deflections.
  const webSearch = createWebSearchTool();
  const fetchUrl = createFetchUrlTool();
  const getDiagnostics = createGetDiagnosticsTool();

  if (mode === 'plan') {
    return {
      readFile,
      listDir,
      glob,
      grep,
      webSearch,
      fetchUrl,
      todoWrite,
      getDiagnostics,
      askUser: createAskUserTool(bindings.onAskUser),
      delegateTask: createDelegateTaskTool(bindings),
      runCommand: createRunCommandTool(bindings),
      exitPlanMode: createExitPlanModeTool(bindings.onPlanProposed),
    };
  }
  // Ask mode: read-only Q&A. Shell is offered read-only (the policy auto-runs `git log`,
  // denies `rm -rf`, asks for the rest) so history questions are answered from real output.
  if (mode === 'ask') {
    return {
      readFile,
      listDir,
      glob,
      grep,
      webSearch,
      fetchUrl,
      todoWrite,
      getDiagnostics,
      askUser: createAskUserTool(bindings.onAskUser),
      delegateTask: createDelegateTaskTool(bindings),
      runCommand: createRunCommandTool(bindings),
    };
  }

  return {
    // MCP tools of every connected server — AGENT MODE ONLY: an MCP tool may write anything,
    // and the read-only modes cannot gate what they cannot classify. Spread first so a built-in
    // wins a name clash. Not in READ_ONLY_TOOLS, so the policy asks before running one.
    ...createMcpTools(getMcpManager()),
    readFile,
    listDir,
    glob,
    grep,
    webSearch,
    fetchUrl,
    todoWrite,
    getDiagnostics,
    askUser: createAskUserTool(bindings.onAskUser),
    delegateTask: createDelegateTaskTool(bindings),
    editFile: createEditFileTool(bindings),
    writeFile: createWriteFileTool(bindings),
    deleteFile: createDeleteFileTool(bindings),
    runCommand: createRunCommandTool(bindings),
  };
}
