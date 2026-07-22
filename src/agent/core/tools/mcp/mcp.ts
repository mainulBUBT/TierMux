

import { tool, jsonSchema, type ToolSet } from 'ai';
import type { McpManager } from '../../../../mcp/mcpManager';

/** Registers every connected MCP tool as an ordinary AI SDK tool — indistinguishable from a
 *  built-in one to the loop/tool-set builder, no "if MCP" branch anywhere. Re-queries
 *  listToolSpecs() each call so newly (re)connected servers show up. */
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
