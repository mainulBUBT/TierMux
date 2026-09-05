// v3 toolset (plan step 7) — the production tool registry. Each tool is tool()-form with a
// Zod schema, exception-safe execute (expected failures return { error }), and NO embedded
// approval — the streamText `toolApproval` policy decides IF a mutating tool runs.
//
// Kept tool inventory (v3.0): readFile, editFile, writeFile, deleteFile, listDir, glob, grep,
// runCommand, plus every connected MCP server's tools in agent mode (wired 2026-09-05 —
// the bridge had shipped uncalled). The legacy fleet/planRunner tools defer to v3.1.

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
 *  `ask`: read/search plus READ-ONLY shell — runCommand is offered but the policy auto-runs
 *  only confidently read-only commands (ls, git log), denies destructive ones outright, and
 *  asks for the rest; the three file mutators are absent AND policy-denied.
 *  `agent`: the full set. */
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
  // Ask mode is read-only Q&A: file mutation is withheld, shell is offered READ-ONLY.
  // The policy auto-runs confidently read-only commands (ls, git log/status/diff),
  // hard-denies destructive ones (rm -rf, push --force), and asks for the ambiguous
  // rest — so "what did the last commit do?" is answered from real `git log` output,
  // never from memory, while nothing can be changed. delegateTask stays: the sub-agent
  // is read-only research, no mutation possible.
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
    // MCP tools of every connected server (2026-09-05). `createMcpTools` existed and was called
    // by NOTHING for the whole v3 era: servers connected, "Reconnect MCP Servers" worked,
    // `tiermux.mcpServers` was documented, and the model was never shown one of their tools.
    //
    // AGENT MODE ONLY, deliberately. An MCP tool's capability is unknowable from here — it may
    // write anything — and the two read-only modes cannot gate what they cannot classify:
    // plan mode's policy denies every non-READ_ONLY tool (offering one that is always denied is
    // worse than not offering it), and ask mode would fall through to the normal chain and
    // AUTO-APPROVE it under full-auto, quietly breaking the read-only promise.
    //
    // Spread FIRST so a built-in always wins a name clash. Names are `mcp__<server>__<tool>`
    // (mcpManager's PREFIX), so a clash should be impossible — this is belt-and-braces, not a
    // known case. Nothing else is special-cased: an MCP tool is not in READ_ONLY_TOOLS, so the
    // normal approval chain asks before running it, which is the right default for a tool whose
    // code lives outside this repo.
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
