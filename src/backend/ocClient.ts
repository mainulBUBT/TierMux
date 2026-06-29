// OpenCode HTTP/SSE client — drives the bundled `opencode serve` engine from TierMux's
// sdk.ts seam. Raw fetch (no @opencode-ai/sdk dependency) over loopback with Basic auth.
//
// NOTE on paths: OC serves its REST API at the ROOT in headless `serve` mode
// (e.g. POST /session/{id}/prompt, GET /global/event). These match the source route
// mounting and the webgui's /global/event usage. If a path differs in your OC build,
// run "TierMux: Test OC Bridge" — it probes these endpoints and reports which are live —
// then adjust the constants below. All paths are centralized here for that reason.
import type { OcConnection } from './ocLauncher';

// ---- Centralized route paths (single place to fix after the bridge diagnostic) ----
const PATHS = {
  sessionList: '/session',
  sessionCreate: '/session',
  // OC 1.x: prompt endpoint is `POST /session/{id}/message` (NOT `/prompt`).
  // `/prompt` returns the webgui HTML — that's how we discovered the rename.
  sessionPrompt: (id: string) => `/session/${id}/message`,
  sessionCommand: (id: string) => `/session/${id}/command`,
  sessionAbort: (id: string) => `/session/${id}/abort`,
  sessionMessages: (id: string) => `/session/${id}/messages`,
  agents: '/app/agents',
  models: '/config/providers',
  events: '/global/event',
};

/** A user-message part OC understands ({ type: 'text', text }). */
export interface TextPart { type: 'text'; text: string }
export interface PromptBody {
  parts: TextPart[];
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
}

export interface OcSessionInfo { id: string; [k: string]: unknown }

/** OC ServerEvent shape (subset we act on). `properties` is event-specific. */
export interface OcEvent { type: string; properties: any }

export class OcClient {
  private readonly base: string;
  private readonly auth: string;

  constructor(conn: OcConnection) {
    this.base = conn.baseURL.replace(/\/$/, '');
    this.auth = `Basic ${Buffer.from(`opencode:${conn.password}`).toString('base64')}`;
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = { Authorization: this.auth };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  private async request<T>(path: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, { ...init, signal: ctrl.signal });
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        console.error(`[tiermux] OC ${init?.method ?? 'GET'} ${path} → ${res.status}: body=${text.slice(0, 500)}`);
        throw new Error(`OC ${init?.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
      }
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch (parseErr) {
        console.error(`[tiermux] OC ${init?.method ?? 'GET'} ${path} returned non-JSON body: ${text.slice(0, 500)}`);
        throw parseErr;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** List available agents (build, plan, …). Used to pick the plan companion agent id. */
  async listAgents(): Promise<any[]> {
    try {
      const data = await this.request<any>(PATHS.agents);
      return Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
    } catch {
      return [];
    }
  }

  /** Create a new session. Optionally pin agent + model up front. */
  async createSession(opts?: { agent?: string; model?: PromptBody['model']; title?: string }): Promise<OcSessionInfo> {
    const body = JSON.stringify(opts ?? {});
    console.log(`[tiermux] OC POST ${PATHS.sessionCreate} body=${body}`);
    const result = await this.request<OcSessionInfo>(PATHS.sessionCreate, {
      method: 'POST',
      headers: this.headers(true),
      body,
    });
    console.log(`[tiermux] OC createSession returned:`, JSON.stringify(result));
    return result;
  }

  /** Send a prompt to a session. The agent run streams over the global SSE event bus. */
  async prompt(sessionId: string, body: PromptBody): Promise<void> {
    const bodyStr = JSON.stringify(body);
    console.log(`[tiermux] OC POST ${PATHS.sessionPrompt(sessionId)} body=${bodyStr}`);
    try {
      await this.request(PATHS.sessionPrompt(sessionId), {
        method: 'POST',
        headers: this.headers(true),
        body: bodyStr,
      }, 60_000);
      console.log(`[tiermux] OC prompt() returned 2xx`);
    } catch (err) {
      console.error(`[tiermux] OC prompt() failed:`, err);
      throw err;
    }
  }

  /** Abort the running prompt for a session. */
  async abort(sessionId: string): Promise<void> {
    try {
      await this.request(PATHS.sessionAbort(sessionId), { method: 'POST', headers: this.headers(true), body: '{}' });
    } catch { /* abort is best-effort */ }
  }

  /** Fetch the assembled messages of a session (for persistence/fallback). */
  async messages(sessionId: string): Promise<any[]> {
    try {
      const data = await this.request<any>(PATHS.sessionMessages(sessionId));
      return Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
    } catch {
      return [];
    }
  }

  /**
   * Subscribe to the global SSE event stream. Calls `onEvent` for each parsed ServerEvent.
   * Returns an unsubscribe that closes the connection. Reconnects on transient errors.
   *
   * Optional `onRaw` receives the raw JSON string before parsing — used by the trace toggle
   * to dump every frame to the TierMux Engine output channel.
   *
   * In Node, fetch + ReadableStream gives us the raw SSE body; we split on `\n\n` frames
   * and parse `data:` lines (ignoring keepalive `:` comments).
   */
  subscribe(onEvent: (e: OcEvent) => void, signal?: AbortSignal, onRaw?: (raw: string) => void): () => void {
    let stopped = false;
    let controller: AbortController | undefined;

    const loop = async () => {
      while (!stopped) {
        controller = new AbortController();
        const onAbort = () => controller?.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          console.log(`[tiermux] OC SSE connecting to ${this.base}${PATHS.events}`);
          const res = await fetch(`${this.base}${PATHS.events}`, {
            headers: { Authorization: this.auth, Accept: 'text/event-stream' },
            signal: controller.signal,
          });
          console.log(`[tiermux] OC SSE connected: status=${res.status} content-type=${res.headers.get('content-type')}`);
          if (!res.ok || !res.body) throw new Error(`OC events → ${res.status}`);
          await this.readSSE(res.body, onEvent, onRaw);
          console.log(`[tiermux] OC SSE stream ended (done)`);
        } catch (err) {
          if (stopped || signal?.aborted) break;
          console.warn(`[tiermux] OC SSE error, reconnecting in 1.5s:`, err instanceof Error ? err.message : err);
          // transient — backoff and reconnect
          await new Promise((r) => setTimeout(r, 1500));
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
      }
    };
    void loop();
    return () => { stopped = true; controller?.abort(); };
  }

  private async readSSE(body: ReadableStream<Uint8Array>, onEvent: (e: OcEvent) => void, onRaw?: (raw: string) => void): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          onRaw?.(payload);
          try { onEvent(JSON.parse(payload) as OcEvent); } catch { /* skip malformed */ }
        }
      }
    }
  }
}
