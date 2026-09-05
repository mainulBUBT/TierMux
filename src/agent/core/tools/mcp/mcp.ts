

import { tool, jsonSchema, type ToolSet } from 'ai';
import type { McpManager } from '../../../../mcp/mcpManager';

/** Every connected MCP tool as an ordinary AI SDK tool — no "if MCP" branch anywhere. Re-queries
 *  listToolSpecs() each call so reconnected servers show up. Agent mode only (wired 2026-09-05;
 *  it had shipped with no caller). */
export function createMcpTools(mcp: McpManager | undefined): ToolSet {
  if (!mcp) return {};
  const out: ToolSet = {};
  for (const spec of mcp.listToolSpecs()) {
    const name = spec.function.name;
    out[name] = tool({
      description: spec.function.description,
      inputSchema: jsonSchema(spec.function.parameters ?? { type: 'object', properties: {} }),
      execute: async (args: unknown) => mcp.callTool(name, JSON.stringify(args ?? {})),
    });
  }
  return out;
}
