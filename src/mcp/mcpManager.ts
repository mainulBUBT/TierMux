

import * as vscode from 'vscode';
import { createHash } from 'crypto';
import type { ChatToolDefinition } from '../shared/types';
import type { McpServerInfo } from '../messages';
import { McpStdioClient, McpHttpClient, normalizeMcpServerConfig, type McpClient, type McpServerConfig } from './mcpClient';

const PREFIX = 'mcp__';
const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_');
/** OpenAI's function-name limit; Anthropic allows 128. Cap at the lower bound — our wire is
 *  OpenAI-shaped for ~18 providers, and an over-long name is rejected with a 400 that kills the
 *  WHOLE request, not just that tool. */
const MAX_TOOL_NAME = 64;

/** `mcp__<server>__<tool>`, sanitized, and shortened with a content hash when it would not fit.
 *  Deterministic, so a name stays stable across reconnects. */
export function mcpToolName(server: string, tool: string): string {
  const full = `${PREFIX}${sanitize(server)}__${sanitize(tool)}`;
  if (full.length <= MAX_TOOL_NAME) return full;
  const hash = createHash('sha1').update(`${server}__${tool}`).digest('hex').slice(0, 8);
  return `${full.slice(0, MAX_TOOL_NAME - 9)}_${hash}`;
}

export class McpManager {
  private clients = new Map<string, McpClient>();
  private toolMap = new Map<string, { server: string; tool: string }>(); // fq name -> ref
  private infos: McpServerInfo[] = [];
  private starting?: Promise<void>;

  private readConfig(): Record<string, McpServerConfig> {
    const raw = vscode.workspace.getConfiguration('tiermux').get<Record<string, unknown>>('mcpServers', {}) ?? {};
    const out: Record<string, McpServerConfig> = {};
    for (const [name, entry] of Object.entries(raw)) {
      const normalized = normalizeMcpServerConfig(entry);
      if (normalized) out[name] = normalized;
    }
    return out;
  }

  hasServers(): boolean {
    return Object.keys(this.readConfig()).length > 0;
  }

  /** Connect all configured servers once (idempotent). */
  async ensureStarted(): Promise<void> {
    if (!this.starting) this.starting = this.connectAll();
    await this.starting;
  }

  /** Tear down and rebuild every connection. Serialized: each call chains after
   *  any in-flight (re)connect instead of racing it — the config-change watcher
   *  and an explicit caller used to run concurrently and append to the shared
   *  `infos`, which double-listed every server. */
  async reconnect(): Promise<void> {
    const run = (this.starting ?? Promise.resolve())
      .catch(() => { /* ignore a prior failure; we rebuild from scratch anyway */ })
      .then(() => this.connectAll());
    this.starting = run;
    await run;
  }

  /** Drop one server's connection and tools, leaving the rest running. Removing
   *  a server doesn't require restarting the others, and this lets the panel
   *  reflect the removal immediately instead of after a full reconnect. */
  disconnect(name: string): void {
    const client = this.clients.get(name);
    if (client) { client.dispose(); this.clients.delete(name); }
    for (const [fq, ref] of this.toolMap) if (ref.server === name) this.toolMap.delete(fq);
    this.infos = this.infos.filter((i) => i.name !== name);
  }

  private async connectAll(): Promise<void> {
    const cfg = this.readConfig();
    const wsCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const clients = new Map<string, McpClient>();
    const toolMap = new Map<string, { server: string; tool: string }>();
    const infos: McpServerInfo[] = [];
    await Promise.all(Object.entries(cfg).map(async ([name, sc]) => {
      if (sc.enabled === false) { infos.push({ name, status: 'disabled', toolCount: 0, tools: [] }); return; }
      const client: McpClient = sc.type === 'remote'
        ? new McpHttpClient(name, { url: sc.url, headers: sc.headers })
        : new McpStdioClient(name, { ...sc, cwd: sc.cwd ?? wsCwd });
      try {
        await client.start();
        clients.set(name, client);
        const toolNames: string[] = [];
        for (const t of client.tools) {
          toolMap.set(mcpToolName(name, t.name), { server: name, tool: t.name });
          toolNames.push(t.name);
        }
        infos.push({ name, status: 'connected', toolCount: client.tools.length, tools: toolNames });
      } catch (e) {
        client.dispose();
        infos.push({ name, status: 'error', toolCount: 0, tools: [], error: e instanceof Error ? e.message : String(e) });
      }
    }));

    const old = this.clients;
    this.clients = clients;
    this.toolMap = toolMap;
    this.infos = infos;
    for (const c of old.values()) c.dispose();
  }

  /** OpenAI-style tool specs for every connected MCP tool. */
  listToolSpecs(): ChatToolDefinition[] {
    const specs: ChatToolDefinition[] = [];
    for (const [fq, ref] of this.toolMap) {
      const t = this.clients.get(ref.server)?.tools.find((x) => x.name === ref.tool);
      specs.push({
        type: 'function',
        function: {
          name: fq,
          description: `[MCP:${ref.server}] ${t?.description ?? ref.tool}`,
          parameters: (t?.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        },
      });
    }
    return specs;
  }

  /** Every connected server's own `instructions`, for the prompt's <mcp_instructions> block.
   *  A server that ships none contributes nothing. */
  instructions(): string {
    const parts: string[] = [];
    for (const [name, c] of this.clients) {
      if (c.instructions) parts.push(`## ${name}\n${c.instructions}`);
    }
    return parts.join('\n\n');
  }

  isMcpTool(name: string): boolean {
    return this.toolMap.has(name);
  }

  async callTool(fqName: string, argsJson: string): Promise<string> {
    const ref = this.toolMap.get(fqName);
    if (!ref) return JSON.stringify({ error: `Unknown MCP tool ${fqName}` });
    const client = this.clients.get(ref.server);
    if (!client) return JSON.stringify({ error: `MCP server ${ref.server} not connected` });
    let args: unknown = {};
    try { args = argsJson ? JSON.parse(argsJson) : {}; } catch { /* pass empty */ }
    try { return await client.callTool(ref.tool, args); } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  servers(): McpServerInfo[] {
    return this.infos;
  }

  dispose(): void {
    for (const c of this.clients.values()) c.dispose();
    this.clients.clear();
    this.toolMap.clear();
  }
}
