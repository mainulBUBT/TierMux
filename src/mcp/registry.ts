

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { McpRegistryItem } from '../messages';

/* Loose shapes for the official MCP registry (schema 2025-12-11). Items are
 * wrapped as { server: {...}, _meta: {...} }; fields are camelCase. */
interface RegArg { type?: string; value?: string; default?: string }
interface RegEnv { name?: string; description?: string; isSecret?: boolean; is_secret?: boolean }
interface RegPackage {
  registryType?: string; registry_type?: string; registry_name?: string;
  identifier?: string; name?: string; runtimeHint?: string;
  transport?: { type?: string };
  runtimeArguments?: RegArg[]; packageArguments?: RegArg[]; package_arguments?: RegArg[];
  environmentVariables?: RegEnv[]; environment_variables?: RegEnv[];
}
interface RegRemote { type?: string; url?: string; headers?: Array<{ name?: string; value?: string; isSecret?: boolean }> }
interface RegServer {
  name?: string; description?: string;
  repository?: { url?: string };
  packages?: RegPackage[];
  remotes?: RegRemote[];
}

/** Live search against the official MCP registry (or a configured base). */
export async function searchRemoteMcp(query: string): Promise<McpRegistryItem[]> {
  const base = vscode.workspace
    .getConfiguration('tiermux')
    .get<string>('mcpRegistrySearchUrl', 'https://registry.modelcontextprotocol.io')
    .replace(/\/+$/, '');
  if (!base) return [];
  const url = `${base}/v0/servers?limit=40${query ? `&search=${encodeURIComponent(query)}` : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MCP registry ${res.status}`);
  const data = (await res.json()) as { servers?: Array<{ server?: RegServer } & RegServer> };
  const items: McpRegistryItem[] = [];
  const seen = new Set<string>();
  for (const entry of data.servers ?? []) {
    const item = mapRegServer(entry.server ?? entry);
    if (item && !seen.has(item.id)) { seen.add(item.id); items.push(item); }
  }
  return items;
}

function posArgs(args?: RegArg[]): string[] {
  return (args ?? []).filter((a) => a.type !== 'named' && (a.value ?? a.default)).map((a) => String(a.value ?? a.default));
}

/** Map a registry server to an installable entry: stdio package if present, else remote (HTTP). */
function mapRegServer(s: RegServer): McpRegistryItem | null {
  const name = s.name;
  if (!name) return null;
  const id = (name.split('/').pop() ?? name).replace(/[^a-zA-Z0-9_-]/g, '-');
  const base = { id, name, description: s.description ?? '', homepage: s.repository?.url };

  const pkgs = s.packages ?? [];
  const pkg = pkgs.find((p) => (p.transport?.type ?? 'stdio') === 'stdio') ?? pkgs[0];
  const ident = pkg && (pkg.identifier ?? pkg.name);
  if (pkg && ident) {
    const kind = pkg.registryType ?? pkg.registry_type ?? pkg.registry_name ?? 'npm';
    const command = pkg.runtimeHint ?? (kind === 'pypi' ? 'uvx' : kind === 'oci' ? 'docker' : 'npx');
    const args = [...posArgs(pkg.runtimeArguments), ident, ...posArgs(pkg.packageArguments ?? pkg.package_arguments)];
    const env = (pkg.environmentVariables ?? pkg.environment_variables ?? [])
      .filter((v) => v.name)
      .map((v) => ({ key: v.name as string, label: v.description || (v.name as string), password: !!(v.isSecret ?? v.is_secret) }));
    return { ...base, command, args, env, transport: 'stdio' };
  }

  const remote = (s.remotes ?? []).find((r) => r.type === 'streamable-http') ?? (s.remotes ?? [])[0];
  if (remote?.url) {
    const headers = (remote.headers ?? []).filter((h) => h.name).map((h) => ({ name: h.name as string, value: h.value ?? '', secret: !!h.isSecret }));
    return { ...base, command: '', args: [], transport: 'http', url: remote.url, headers };
  }
  return null;
}

export async function loadMcpRegistry(extensionPath: string): Promise<McpRegistryItem[]> {
  let items: McpRegistryItem[] = [];
  try {
    const raw = fs.readFileSync(path.join(extensionPath, 'media', 'mcp-registry.json'), 'utf8');
    items = (JSON.parse(raw) as { servers?: McpRegistryItem[] }).servers ?? [];
  } catch { /* ignore */ }

  const url = vscode.workspace.getConfiguration('tiermux').get<string>('mcpRegistryUrl', '');
  if (url) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const remote = (await res.json()) as McpRegistryItem[] | { servers?: McpRegistryItem[] };
        const list = Array.isArray(remote) ? remote : remote.servers;
        if (Array.isArray(list) && list.length) items = list;
      }
    } catch { /* keep bundled */ }
  }
  return items;
}
