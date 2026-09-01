// v3 toolset (plan step 7) — the production tool registry. Each tool is tool()-form with a
// Zod schema, exception-safe execute (expected failures return { error }), and NO embedded
// approval — the streamText `toolApproval` policy decides IF a mutating tool runs.
//
// Kept tool inventory (v3.0): readFile, editFile, writeFile, deleteFile, listDir, glob, grep,
// runCommand. The legacy fleet/MCP/delegate/planRunner tools defer to v3.1 (plan §11).

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
   *  BEFORE the mutation. `before` is null when the file doesn't exist yet (a create). Host
   *  wires this to CheckpointManager.record(). This timing is load-bearing: the previous
   *  capture point (chatViewProvider's onTool, fired from the engine's onStepEnd) ran AFTER
   *  the tool had already written, so every "before" snapshot stored the post-edit content and
   *  checkpoint restore rewrote files with the very content it was supposed to undo —
   *  "Restored N files" with zero visible change (live repro 2026-08-28: "undo not
   *  restoreing files"). */
  onBeforeWrite?: (uri: import('vscode').Uri, before: string | null) => void;
  /** Plan-mode boundary — fires when the model calls `exitPlanMode` with its finished plan.
   *  The engine captures it into AgentResult.plan and stops the turn; the host renders the
   *  plan card from this STRUCTURE instead of re-deriving it from the reply text. */
  onPlanProposed?: (plan: ProposedPlan) => void;
}

/** Build the mode-filtered v3 ToolSet.
 *  `plan` (§12): read/search offered freely; `runCommand` IS offered but the policy gates
 *  every call through an ask; mutating file tools are absent AND policy-denied. `exitPlanMode`
 *  is plan mode's ONLY exit — the model calls it to hand the finished plan to the user, which
 *  also ends the turn (engine.ts stopWhen).
 *  `ask`: the full set MINUS editFile/writeFile/deleteFile — shell, search and sub-agents are
 *  all available so a question about the repo (git history, test output) is answerable; only
 *  file mutation is withheld. `agent`: the full set. */
// Return type pinned to ToolSet on purpose. The three branches no longer share a key
// hierarchy (exitPlanMode exists ONLY in plan mode), so the inferred union stopped satisfying
// ToolSet's index signature at the engine's cast site — nothing downstream uses the per-tool
// inference anyway; the engine passes this straight to streamText.
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
  // Ask mode is "everything except edits" — NOT "read-only tools only". The old strictly
  // read-only set had no runCommand, so a plain "what did the last commit do?" was
  // unanswerable: the model cannot shell out to `git log`, and glob/listDir hard-skip `.git`
  // (search.ts SKIP), so its honest report was "no .git found" while a rival agent answered
  // the same question by running `git log -1 --stat` from its own ask agent (live repro
  // 2026-09-01). runCommand is offered here and gated by the normal approval chain; only the
  // three file mutators are withheld, and resolvePolicy hard-denies them for this mode too.
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
