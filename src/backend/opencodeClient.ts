import type { OpenCodeManager } from './opencodeManager';

// OpenCode 1.17.11 message API schema:
//   parts: [{ type: 'text', text: '...', id: 'prt<uuid>' }]  (id must start with "prt"; note: `text`, not `content`)
//   model: { providerID: 'tiermux', modelID: 'tiermux-{effort}' }  (object, not string; suffix encodes reasoning effort)
//   agent: 'build'  (string, default agent name)
//   reasoning_effort: 'low'|'medium'|'high'  (forwarded to the AI SDK provider request if OC supports it)
const DEFAULT_MODEL = { providerID: 'tiermux', modelID: 'tiermux-auto' };
const DEFAULT_AGENT = 'build';

export interface OCSession {
  id: string;
  slug: string;
  title: string;
  directory: string;
  time: { created: number; updated: number };
}

export interface OCMessage {
  info: {
    id: string;
    role: string;
    content: string;
    time: { created: number };
  };
  parts: Array<{ id: string; type: string; content: string }>;
}

export interface OCEvent {
  type: string;
  payload: Record<string, unknown>;
}

export type SSEEventHandler = (event: OCEvent) => void;

export class OpenCodeClient {
  private abortControllers = new Map<string, AbortController>();

  constructor(private manager: OpenCodeManager) {}

  async createSession(title?: string): Promise<OCSession> {
    const { baseUrl, password } = await this.manager.getServer();
    const res = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeader(password) },
      body: JSON.stringify({ title: title || 'TierMux Session' }),
    });
    if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
    return res.json() as Promise<OCSession>;
  }

  async listSessions(): Promise<OCSession[]> {
    const { baseUrl, password } = await this.manager.getServer();
    const res = await fetch(`${baseUrl}/session`, {
      headers: { ...this.authHeader(password) },
    });
    if (!res.ok) throw new Error(`Failed to list sessions: ${res.status}`);
    return res.json() as Promise<OCSession[]>;
  }

  async getSession(id: string): Promise<OCSession> {
    const { baseUrl, password } = await this.manager.getServer();
    const res = await fetch(`${baseUrl}/session/${encodeURIComponent(id)}`, {
      headers: { ...this.authHeader(password) },
    });
    if (!res.ok) throw new Error(`Failed to get session: ${res.status}`);
    return res.json() as Promise<OCSession>;
  }

  async deleteSession(id: string): Promise<boolean> {
    const { baseUrl, password } = await this.manager.getServer();
    const res = await fetch(`${baseUrl}/session/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { ...this.authHeader(password) },
    });
    return res.ok;
  }

  async listMessages(sessionId: string, limit?: number): Promise<OCMessage[]> {
    const { baseUrl, password } = await this.manager.getServer();
    const params = limit ? `?limit=${limit}` : '';
    const res = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/message${params}`, {
      headers: { ...this.authHeader(password) },
    });
    if (!res.ok) throw new Error(`Failed to list messages: ${res.status}`);
    return res.json() as Promise<OCMessage[]>;
  }

  async sendMessageAndWait(
    sessionId: string,
    message: string,
    opts?: { model?: { providerID: string; modelID: string }; agent?: string; reasoning_effort?: string },
  ): Promise<OCMessage> {
    const { baseUrl, password } = await this.manager.getServer();
    const body: Record<string, unknown> = {
      parts: [{ type: 'text', text: message, id: `prt${crypto.randomUUID()}` }],
      model: opts?.model ?? DEFAULT_MODEL,
      agent: opts?.agent ?? DEFAULT_AGENT,
    };
    if (opts?.reasoning_effort) { body['reasoning_effort'] = opts.reasoning_effort; }
    const res = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeader(password) },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Failed to send message: ${res.status} ${errBody}`);
    }
    return res.json() as Promise<OCMessage>;
  }

  async sendMessageAsync(
    sessionId: string,
    message: string,
    opts?: { model?: { providerID: string; modelID: string }; agent?: string },
  ): Promise<void> {
    const { baseUrl, password } = await this.manager.getServer();
    const res = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeader(password) },
      body: JSON.stringify({
        parts: [{ type: 'text', text: message, id: `prt${crypto.randomUUID()}` }],
        model: opts?.model ?? DEFAULT_MODEL,
        agent: opts?.agent ?? DEFAULT_AGENT,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Failed to send async message: ${res.status} ${errBody}`);
    }
  }

  async abortSession(sessionId: string): Promise<void> {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }
    try {
      const { baseUrl, password } = await this.manager.getServer();
      await fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/abort`, {
        method: 'POST',
        headers: { ...this.authHeader(password) },
      });
    } catch {
      // Ignore errors on abort
    }
  }

  async health(): Promise<boolean> {
    try {
      const { baseUrl, password } = await this.manager.getServer();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${baseUrl}/global/health`, {
        signal: controller.signal,
        headers: { ...this.authHeader(password) },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  subscribeToEvents(handler: SSEEventHandler): () => void {
    let aborted = false;

    const connect = async () => {
      if (aborted) return;
      try {
        const { baseUrl, password } = await this.manager.getServer();
        const res = await fetch(`${baseUrl}/global/event`, {
          headers: { ...this.authHeader(password) },
        });
        if (!res.ok || !res.body) { throw new Error(`SSE connect failed: ${res.status}`); }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                handler({
                  type: data.type || data.payload?.type || 'unknown',
                  payload: data.payload || data,
                });
              } catch {
                // Skip malformed SSE data
              }
            }
          }
        }
      } catch (err) {
        if (!aborted) {
          setTimeout(connect, 2000);
        }
      }
    };

    connect();

    return () => { aborted = true; };
  }

  private authHeader(password: string): Record<string, string> {
    const encoded = Buffer.from(`opencode:${password}`).toString('base64');
    return { Authorization: `Basic ${encoded}` };
  }
}
