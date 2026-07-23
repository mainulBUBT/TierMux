

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
import type { ToolSet } from 'ai';
import type { AgentOpts } from '../../agent';
import type { McpManager } from '../../../mcp/mcpManager';
import type { Router } from '../../../router/router';
import { MUTATING_TOOLS } from '../policies/permission';
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

export function createToolSet(opts: AgentOpts, mcp: McpManager | undefined, router: Router): ToolSet {
  // Ask mode: no tools at all, not even read-only ones. Two reasons, not one:
  // 1. Router.route()'s `wantsStream` gate (router.ts) only streams when `tools` is empty —
  //    with Ask mode carrying tools like agent/plan did, it always took the buffered path,
  //    which is also why it needed the usage-estimate fallback recently added there.
  // 2. Ask mode is meant to be pure conversational Q&A — see ASK_MODE_TAIL in
  //    promptBuilder.ts, which no longer claims file-grounding capability either.
  // Agent/plan keep their existing tool sets unchanged below.
  if (opts.mode === 'ask') return {};

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
    explore: createExploreTool(router, opts.abortSignal),
    todowrite: createTodoWriteTool(opts.onTodos),
    question: createQuestionTool(opts.onAskUser),
    ...createMcpTools(mcp),
  };

  if (opts.mode === 'agent') return all;

  // plan mode: the model never even sees a mutating tool's schema, rather than showing it
  // and denying execution at call time (defense-in-depth mirrored in policies/permission.ts).
  const filtered: ToolSet = {};
  for (const [name, t] of Object.entries(all)) {
    if (MUTATING_TOOLS.has(name)) continue;
    filtered[name] = t;
  }
  return filtered;
}
