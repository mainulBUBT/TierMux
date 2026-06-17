// Minimal MCP stdio client: spawns a server process and speaks newline-delimited
// JSON-RPC 2.0 (the MCP stdio transport). No external dependency.
import { spawn, type ChildProcess } from 'child_process';

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
  /** Remote (streamable-HTTP) server. */
  url?: string;
  headers?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Common surface for stdio and HTTP MCP clients. */
export interface McpClient {
  readonly name: string;
  tools: McpTool[];
  start(timeoutMs?: number): Promise<void>;
  callTool(tool: string, args: unknown): Promise<string>;
  dispose(): void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

const PROTOCOL_VERSION = '2024-11-05';

export class McpStdioClient {
  private proc?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private alive = false;
  tools: McpTool[] = [];

  constructor(readonly name: string, private readonly cfg: McpServerConfig) {}

  async start(timeoutMs = 20000): Promise<void> {
    this.proc = spawn(this.cfg.command ?? '', this.cfg.args ?? [], {
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      cwd: this.cfg.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // resolve .cmd shims (npx) on Windows
    });
    this.alive = true;
    this.proc.stdout?.setEncoding('utf8');
    this.proc.stdout?.on('data', (d: string) => this.onData(d));
    this.proc.stderr?.on('data', () => { /* server logs — ignore */ });
    this.proc.on('exit', () => { this.alive = false; this.failAll(new Error(`${this.name} exited`)); });
    this.proc.on('error', (e) => { this.alive = false; this.failAll(e instanceof Error ? e : new Error(String(e))); });

    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'tiermux', version: '0.1.0' },
    }, timeoutMs);
    this.notify('notifications/initialized', {});

    const res = (await this.request('tools/list', {}, timeoutMs)) as { tools?: McpTool[] };
    this.tools = res?.tools ?? [];
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try { msg = JSON.parse(line); } catch { continue; }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error'));
        else p.resolve(msg.result);
      }
      // server-initiated requests/notifications are ignored (no sampling support)
    }
  }

  private send(obj: unknown): void {
    this.proc?.stdin?.write(JSON.stringify(obj) + '\n');
  }
  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }
  private request(method: string, params: unknown, timeoutMs = 30000): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error(`${this.name} is not running`));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${this.name}: ${method} timed out`)); }
      }, timeoutMs);
    });
  }
  private failAll(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  /** Call a tool and flatten the result content to a string observation. */
  async callTool(tool: string, args: unknown): Promise<string> {
    const res = (await this.request('tools/call', { name: tool, arguments: args ?? {} })) as
      { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | undefined;
    const text = (res?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    if (res?.isError) return JSON.stringify({ error: text || 'tool error' });
    return text || JSON.stringify(res ?? {});
  }

  dispose(): void {
    this.alive = false;
    try { this.proc?.kill(); } catch { /* already gone */ }
  }
}

/** Remote MCP client over the streamable-HTTP transport (JSON-RPC via POST). */
export class McpHttpClient implements McpClient {
  private sessionId?: string;
  private nextId = 1;
  tools: McpTool[] = [];

  constructor(readonly name: string, private readonly cfg: { url: string; headers?: Record<string, string> }) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.cfg.headers ?? {}),
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
    };
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const res = await fetch(this.cfg.url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!res.ok) throw new Error(`${this.name}: ${method} HTTP ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/event-stream')) return this.readSse(res, id);
    if (ct.includes('application/json')) {
      const data = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (data.error) throw new Error(data.error.message ?? 'MCP error');
      return data.result;
    }
    return undefined;
  }

  private async readSse(res: Response, id: number): Promise<unknown> {
    const reader = res.body?.getReader();
    if (!reader) return undefined;
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const d = t.slice(5).trim();
        if (!d || d === '[DONE]') continue;
        let msg: { id?: number; result?: unknown; error?: { message?: string } };
        try { msg = JSON.parse(d); } catch { continue; }
        if (msg.id === id) {
          reader.cancel().catch(() => { /* gone */ });
          if (msg.error) throw new Error(msg.error.message ?? 'MCP error');
          return msg.result;
        }
      }
    }
    return undefined;
  }

  async start(): Promise<void> {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tiermux', version: '0.1.0' } });
    // initialized notification (no id, fire-and-forget)
    await fetch(this.cfg.url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }).catch(() => { /* ignore */ });
    const res = (await this.rpc('tools/list', {})) as { tools?: McpTool[] };
    this.tools = res?.tools ?? [];
  }

  async callTool(tool: string, args: unknown): Promise<string> {
    const res = (await this.rpc('tools/call', { name: tool, arguments: args ?? {} })) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | undefined;
    const text = (res?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    if (res?.isError) return JSON.stringify({ error: text || 'tool error' });
    return text || JSON.stringify(res ?? {});
  }

  dispose(): void { /* stateless between calls */ }
}
