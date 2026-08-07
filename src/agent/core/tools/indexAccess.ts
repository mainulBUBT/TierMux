

// Module-scoped singleton holder for the WorkspaceIndex — mirrors setGates (gates.ts) and
// setMcpManager (mcp/manager.ts): extension.ts constructs one index at activation, hands it
// here via setWorkspaceIndex, and the symbol/dependency tools read it back via getWorkspaceIndex.
// Tools close over this at createToolSet time, so a single workspace-wide instance is shared
// across every agent session and kept fresh by the index's own FileSystemWatcher.
import type { WorkspaceIndex } from '../../../indexer/WorkspaceIndex';

let index: WorkspaceIndex | undefined;

export function setWorkspaceIndex(i: WorkspaceIndex): void { index = i; }

export function getWorkspaceIndex(): WorkspaceIndex {
  if (!index) throw new Error('WorkspaceIndex not initialized.');
  return index;
}
