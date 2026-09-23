// `tiermux.mcpServers` config shapes — the MCP panel's persisted format (OpenCode wire format).

export interface McpLocalServerConfig {
  type: 'local';
  /** Full argv: [executable, ...args] — exact OpenCode wire format. */
  command: string[];
  environment?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  enabled?: boolean;
}

/** Matches OpenCode's McpOAuthConfig exactly. */
export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  scope?: string;
  callbackPort?: number;
}

export interface McpRemoteServerConfig {
  type: 'remote';
  url: string;
  headers?: Record<string, string>;
  /** `false` disables OpenCode's OAuth auto-detection for this server. */
  oauth?: McpOAuthConfig | false;
  timeout?: number;
  enabled?: boolean;
}

export type McpServerConfig = McpLocalServerConfig | McpRemoteServerConfig;

/** Upgrade a legacy `tiermux.mcpServers` entry (no `type`, bare `command`, `env`/`disabled`) to
 *  the current schema. Current entries pass through; undefined when neither `command` nor `url`. */
export function normalizeMcpServerConfig(raw: unknown): McpServerConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.type === 'local' || r.type === 'remote') return r as unknown as McpServerConfig;
  if (typeof r.url === 'string') {
    return {
      type: 'remote',
      url: r.url,
      headers: r.headers as Record<string, string> | undefined,
      enabled: !r.disabled,
    };
  }
  if (typeof r.command === 'string' || Array.isArray(r.command)) {
    const command = Array.isArray(r.command) ? r.command as string[] : [r.command as string, ...((r.args as string[] | undefined) ?? [])];
    return {
      type: 'local',
      command,
      environment: (r.environment ?? r.env) as Record<string, string> | undefined,
      cwd: r.cwd as string | undefined,
      enabled: !r.disabled,
    };
  }
  return undefined;
}
