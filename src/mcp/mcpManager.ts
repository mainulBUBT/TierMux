// MCP servers from `tiermux.mcpServers`, run by Cline's MCP manager and client factory. This
// class only maps the panel's config onto Cline registrations and reports status back to it.

import * as vscode from 'vscode';
import { createHash } from 'crypto';
import type { AgentTool } from '@cline/shared';
import type { McpServerInfo } from '../messages';
import { normalizeMcpServerConfig, type McpServerConfig } from './config';
import { loadClineCore } from '../agent/core/cline/clineRuntime';

type ClineMcpManager = InstanceType<ReturnType<typeof loadClineCore>['InMemoryMcpManager']>;
type Registration = Parameters<ClineMcpManager['registerServer']>[0];

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

function toRegistration(name: string, sc: McpServerConfig, wsCwd: string | undefined): Registration {
  const timeoutSeconds = sc.timeout ? Math.ceil(sc.timeout / 1000) : undefined;
  if (sc.type === 'remote') {
    return {
      name,
      disabled: sc.enabled === false,
      transport: { type: 'streamableHttp', url: sc.url, headers: sc.headers },
      timeoutSeconds,
      ...(sc.oauth && sc.oauth.clientId ? { oauthClient: { clientId: sc.oauth.clientId, clientSecret: sc.oauth.clientSecret } } : {}),
    };
  }
  const [command, ...args] = sc.command;
  return {
    name,
    disabled: sc.enabled === false,
    transport: { type: 'stdio', command, args, cwd: sc.cwd ?? wsCwd, env: sc.environment },
    timeoutSeconds,
  };
}

export class McpManager {
  private cline?: ClineMcpManager;
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

  /** Tear down and rebuild every connection, serialized after any in-flight (re)connect. */
  async reconnect(): Promise<void> {
    const run = (this.starting ?? Promise.resolve())
      .catch(() => { /* ignore a prior failure; we rebuild from scratch anyway */ })
      .then(() => this.connectAll());
    this.starting = run;
    await run;
  }

  /** Drop one server, leaving the rest running, so the panel reflects a removal immediately. */
  disconnect(name: string): void {
    void this.cline?.unregisterServer(name).catch(() => undefined);
    this.infos = this.infos.filter((i) => i.name !== name);
  }

  private async connectAll(): Promise<void> {
    const core = loadClineCore();
    const cfg = this.readConfig();
    const wsCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const manager = new core.InMemoryMcpManager({ clientFactory: core.createDefaultMcpServerClientFactory({ clientName: 'tiermux' }) });
    const infos: McpServerInfo[] = [];
    await Promise.all(Object.entries(cfg).map(async ([name, sc]) => {
      try {
        await manager.registerServer(toRegistration(name, sc, wsCwd));
        if (sc.enabled === false) { infos.push({ name, status: 'disabled', toolCount: 0, tools: [] }); return; }
        await manager.connectServer(name);
        const tools = (await manager.listTools(name)).map((t) => t.name);
        infos.push({ name, status: 'connected', toolCount: tools.length, tools });
      } catch (e) {
        infos.push({ name, status: 'error', toolCount: 0, tools: [], error: e instanceof Error ? e.message : String(e) });
      }
    }));
    const old = this.cline;
    this.cline = manager;
    this.infos = infos;
    void old?.dispose().catch(() => undefined);
  }

  /** Every connected server's tools as Cline AgentTools, for the agent's tool offer. */
  async agentTools(): Promise<AgentTool[]> {
    const manager = this.cline;
    if (!manager) return [];
    const core = loadClineCore();
    const out: AgentTool[] = [];
    for (const info of this.infos) {
      if (info.status !== 'connected') continue;
      try {
        out.push(...await core.createMcpTools({
          serverName: info.name,
          provider: manager,
          nameTransform: ({ serverName, toolName }) => mcpToolName(serverName, toolName),
        }));
      } catch { /* a server that dropped since connect contributes nothing this turn */ }
    }
    return out;
  }

  servers(): McpServerInfo[] {
    return this.infos;
  }

  dispose(): void {
    void this.cline?.dispose().catch(() => undefined);
    this.cline = undefined;
  }
}

let active: McpManager | undefined;

/** Set once at activation — the SAME instance extension.ts constructs and keeps connected. */
export function setMcpManager(mcp: McpManager): void {
  active = mcp;
}

export function getMcpManager(): McpManager | undefined {
  return active;
}
