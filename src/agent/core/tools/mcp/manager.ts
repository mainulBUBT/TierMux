

import type { McpManager } from '../../../../mcp/mcpManager';

let mcpManager: McpManager | undefined;

/** Set once at activation — the SAME McpManager instance extension.ts constructs and keeps
 *  connected. */
export function setMcpManager(mcp: McpManager): void {
  mcpManager = mcp;
}

export function getMcpManager(): McpManager | undefined {
  return mcpManager;
}
