// The tool registry. Each tool is tool()-form with a Zod schema, an exception-safe execute
// (expected failures return { error }), and NO embedded approval — the streamText
// `toolApproval` policy (src/permissions/policy.ts) decides IF a mutating tool runs.

export { createReadFileTool } from './readFile';
export { createEditFileTool } from './editFile';
export { createWriteFileTool, createDeleteFileTool } from './filesystemOps';
export { createListDirTool, createGlobTool, createGrepTool } from './search';
export { createRunCommandTool } from './runCommand';
export { createTaskOutputTool } from './taskOutput';
export { createTodoWriteTool } from './todoWrite';
export { createGetDiagnosticsTool } from './getDiagnostics';
export { createAskUserTool } from './askUser';
export { createDelegateTaskTool } from './delegateTask';
export { createExitPlanModeTool } from './exitPlanMode';
export { createSkillTool } from './skill';
export { createOutlineTool, createFindSymbolTool, createReferencesTool, createDefinitionTool, createHoverTool } from './codeIntel';

import type { ToolSet } from 'ai';
import type { Mode } from '../../../../shared/types';
import type { TodoItem, ProposedPlan, AskQuestion, AskResult } from '../../../../shared/types';
import { createReadFileTool } from './readFile';
import { createEditFileTool } from './editFile';
import { createWriteFileTool, createDeleteFileTool } from './filesystemOps';
import { createListDirTool, createGlobTool, createGrepTool } from './search';
import { createRunCommandTool } from './runCommand';
import { createTaskOutputTool } from './taskOutput';
import { createTodoWriteTool } from './todoWrite';
import { createGetDiagnosticsTool } from './getDiagnostics';
import { createAskUserTool } from './askUser';
import { createDelegateTaskTool } from './delegateTask';
import { createExitPlanModeTool } from './exitPlanMode';
import { createSkillTool } from './skill';
import type { Skill } from '../../../../context/skills';
import { checkPlanPaths } from './planPathCheck';
import { createOutlineTool, createFindSymbolTool, createReferencesTool, createDefinitionTool, createHoverTool } from './codeIntel';
import { createWebSearchTool } from '../network/webSearch';
import { createFetchUrlTool } from '../network/fetchUrl';
import { createBrowserVerifyTool } from '../network/browserVerify';
import { createMcpTools } from '../mcp/mcp';
import { getMcpManager } from '../mcp/manager';

/** Tools that never mutate anything — the permission policy auto-approves these (plan §3).
 *  `showTodo` is a legacy name kept for the set's historical shape; the live tool is `todoWrite`. */
export const READ_ONLY_TOOLS = new Set([
  'readFile', 'listDir', 'glob', 'grep', 'getDiagnostics', 'outline', 'findSymbol', 'references', 'definition', 'hover',
  'webSearch', 'delegateTask', 'fetchUrl', 'showTodo', 'todoWrite', 'askUser',
  // exitPlanMode writes nothing — it hands a structured plan to the host and ends the turn.
  // Approval of the PLAN happens on the card afterwards, so gating the tool itself would just
  // put an "Allow exitPlanMode?" prompt in front of the real approval UI.
  'exitPlanMode',
  // Returns instructions text; anything the skill then asks for goes through its own tool's gate.
  'skill',
  // Observes/stops background tasks the agent itself started — the spawn already went through
  // runCommand's approval; stopping only removes a process, it never starts anything.
  'taskOutput',
  // Drives the user's own headless Chrome against a URL the agent names and reports verdicts —
  // observe-only (subresources are policy-gated inside the tool), so every mode could auto-run
  // it; offered in agent mode only because a verification pass has no point mid-plan/question.
  'browserVerify',
]);

export interface ToolsetBindings {
  abortSignal?: AbortSignal;
  sessionId?: string;
  requestId?: string;
  /** Call-time probe: does the CURRENTLY routed model accept images? browserVerify gates its
   *  screenshot on this at execute() time — routing can switch models mid-session, so a
   *  session-start snapshot would go stale on failover. */
  visionCapable?: () => boolean;
  onTodos?: (todos: TodoItem[]) => void;
  currentTodos?: () => TodoItem[] | undefined;
  /** Mid-turn clarifying-question channel — the toolset binds it as the `askUser` tool.
   *  The host implementation renders an in-chat card and resolves with the user's answer
   *  ('' when dismissed). Unset (e2e/sub-agent contexts) → the tool degrades to `{ error }`. */
  onAskUser?: (questions: AskQuestion[]) => Promise<AskResult>;
  /** Checkpoint baseline — fires INSIDE a write tool, after the pre-write content is read but
   *  BEFORE the mutation (`before` null = create). Capturing it from onStepEnd instead ran
   *  after the write, so Undo restored post-edit content (2026-08-28). */
  onBeforeWrite?: (uri: import('vscode').Uri, before: string | null) => void;
  /** Plan-mode boundary — fires when the model calls `exitPlanMode` with its finished plan.
   *  The engine captures it into AgentResult.plan and stops the turn; the host renders the
   *  plan card from this STRUCTURE instead of re-deriving it from the reply text. */
  onPlanProposed?: (plan: ProposedPlan) => void;
  /** Installed skills; offered as the `skill` tool in every mode when any exist. */
  skills?: Skill[];
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
  const todoWrite = createTodoWriteTool(bindings.onTodos, bindings.currentTodos);
  // Web tools are read-only and keyless (TierMux's own engine: Yahoo/DDG/Marginalia + a
  // static-fetch reader) — offered in EVERY mode so "today's weather" style questions are
  // answerable instead of deflected. Restored from the v2 toolset after live deflections.
  const webSearch = createWebSearchTool();
  const fetchUrl = createFetchUrlTool();
  const getDiagnostics = createGetDiagnosticsTool();
  // Language-server navigation — read-only, so every mode gets it (ask and plan need it most).
  const codeIntel = {
    outline: createOutlineTool(),
    findSymbol: createFindSymbolTool(),
    references: createReferencesTool(),
    definition: createDefinitionTool(),
    hover: createHoverTool(),
  };
  const skill: ToolSet = bindings.skills?.length ? { skill: createSkillTool(bindings.skills) } : {};

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
      ...codeIntel,
      ...skill,
      askUser: createAskUserTool(bindings.onAskUser, mode),
      delegateTask: createDelegateTaskTool(bindings),
      runCommand: createRunCommandTool(bindings),
      exitPlanMode: createExitPlanModeTool(bindings.onPlanProposed, checkPlanPaths),
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
      ...codeIntel,
      ...skill,
      askUser: createAskUserTool(bindings.onAskUser, mode),
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
    ...codeIntel,
    ...skill,
    askUser: createAskUserTool(bindings.onAskUser, mode),
    delegateTask: createDelegateTaskTool(bindings),
    editFile: createEditFileTool(bindings),
    writeFile: createWriteFileTool(bindings),
    deleteFile: createDeleteFileTool(bindings),
    // `background: true` (and the taskOutput tool that reads/stops those tasks) is agent-mode
    // only: plan/ask have no approval-free way to babysit a server, and sub-agents' read-only
    // runCommand refuses it outright. The policy path is unchanged — it reads the command from
    // the input, so a background dev server costs the same approval as a synchronous one.
    runCommand: createRunCommandTool({ ...bindings, allowBackground: true }),
    taskOutput: createTaskOutputTool(bindings),
    browserVerify: createBrowserVerifyTool(bindings),
  };
}
