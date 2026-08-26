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

import type { Mode } from '../../../../shared/types';
import { createReadFileTool } from './readFile';
import { createEditFileTool } from './editFile';
import { createWriteFileTool, createDeleteFileTool } from './filesystemOps';
import { createListDirTool, createGlobTool, createGrepTool } from './search';
import { createRunCommandTool } from './runCommand';
import { createWebSearchTool } from '../network/webSearch';
import { createFetchUrlTool } from '../network/fetchUrl';

/** Tools that never mutate anything — the permission policy auto-approves these (plan §3). */
export const READ_ONLY_TOOLS = new Set([
  'readFile', 'listDir', 'glob', 'grep', 'getDiagnostics', 'getSymbolGraph',
  'getDependencyTree', 'webSearch', 'fetchUrl', 'showTodo', 'askUser', 'recallNotes', 'checkPlan',
]);

export interface ToolsetBindings {
  abortSignal?: AbortSignal;
  sessionId?: string;
  requestId?: string;
}

/** Build the mode-filtered v3 ToolSet.
 *  `plan` (§12): read/search offered freely; `runCommand` IS offered but the policy gates
 *  every call through an ask; mutating file tools are absent AND policy-denied.
 *  `ask`: strictly read-only. `agent`: the full set. */
export function buildV3ToolSet(mode: Mode, bindings: ToolsetBindings = {}) {
  const readFile = createReadFileTool();
  const listDir = createListDirTool();
  const glob = createGlobTool();
  const grep = createGrepTool(bindings.abortSignal);
  // Web tools are read-only and keyless (TierMux's own engine: Yahoo/DDG/Marginalia + a
  // static-fetch reader) — offered in EVERY mode so "today's weather" style questions are
  // answerable instead of deflected. Restored from the v2 toolset after live deflections.
  const webSearch = createWebSearchTool();
  const fetchUrl = createFetchUrlTool();

  if (mode === 'plan') {
    return {
      readFile,
      listDir,
      glob,
      grep,
      webSearch,
      fetchUrl,
      runCommand: createRunCommandTool(bindings),
    };
  }
  if (mode === 'ask') {
    return { readFile, listDir, glob, grep, webSearch, fetchUrl };
  }

  return {
    readFile,
    listDir,
    glob,
    grep,
    webSearch,
    fetchUrl,
    editFile: createEditFileTool(),
    writeFile: createWriteFileTool(),
    deleteFile: createDeleteFileTool(),
    runCommand: createRunCommandTool(bindings),
  };
}
