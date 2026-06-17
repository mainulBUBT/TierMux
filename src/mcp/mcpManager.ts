// Connects the configured MCP stdio servers, aggregates their tools into the
// agent's tool space (namespaced `mcp__<server>__<tool>`), and routes calls.
import * as vscode from 'vscode';
import type { ChatToolDefinition } from '../shared/types';
import type { McpServerInfo } from '../messages';
import { McpStdioClient, McpHttpClient, type McpClient, type McpServerConfig } from './mcpClient';

const PREFIX = 'mcp__';
const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_');

export class McpManager {
  private clients = new Map<string, McpClient>();
  private toolMap = new Map<string, { server: string; tool: string }>(); // fq name -> ref
  private infos: McpServerInfo[] = [];
  private starting?: Promise<void>;

  private readConfig(): Record<string, McpServerConfig> {
    return vscode.workspace.getConfiguration('tiermux').get<Record<string, McpServerConfig>>('mcpServers', {}) ?? {};
  }

  hasServers(): boolean {
    return Object.keys(this.readConfig()).length > 0;
  }

  /** Connect all configured servers once (idempotent). */
  async ensureStarted(): Promise<void> {
    if (!this.starting) this.starting = this.connectAll();
    await this.starting;
  }

  async reconnect(): Promise<void> {
    this.dispose();
    this.starting = undefined;
    await this.ensureStarted();
  }

  private async connectAll(): Promise<void> {
    const cfg = this.readConfig();
    this.toolMap.clear();
    this.infos = [];
    const wsCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    await Promise.all(Object.entries(cfg).map(async ([name, sc]) => {
      if (sc.disabled) { this.infos.push({ name, status: 'disabled', toolCount: 0, tools: [] }); return; }
      const client: McpClient = sc.url
        ? new McpHttpClient(name, { url: sc.url, headers: sc.headers })
        : new McpStdioClient(name, { command: sc.command ?? '', args: sc.args, env: sc.env, cwd: sc.cwd ?? wsCwd });
      try {
        await client.start();
        this.clients.set(name, client);
        const toolNames: string[] = [];
        for (const t of client.tools) {
          this.toolMap.set(`${PREFIX}${sanitize(name)}__${sanitize(t.name)}`, { server: name, tool: t.name });
          toolNames.push(t.name);
        }
        this.infos.push({ name, status: 'connected', toolCount: client.tools.length, tools: toolNames });
      } catch (e) {
        client.dispose();
        this.infos.push({ name, status: 'error', toolCount: 0, tools: [], error: e instanceof Error ? e.message : String(e) });
      }
    }));
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
