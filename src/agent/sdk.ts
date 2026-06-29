// Agent engine boundary — the only file chatViewProvider calls. OpenCode (OC) is the
// SOLE agent engine: every run is driven over OC's HTTP/SSE API, which in turn routes
// model calls through the TierMux router proxy. No AI SDK, no built-in agent loop.
//
// Contract preserved (AgentOpts / AgentResult / the four public functions) so
// chatViewProvider is unchanged. When OC isn't connected, runs surface a clear error
// rather than silently falling back to a second engine.
import type { Router } from '../router/router';
import type { ChatMessage, TodoItem, ReasoningEffort } from '../shared/types';
import type { OcConnection } from '../backend/ocLauncher';
import { OcClient } from '../backend/ocClient';

// ---- Trace toggle — when true, raw OC SSE frames are logged via the supplied sink. ----
let traceOcEvents = false;
let traceSink: ((raw: string) => void) | undefined;
/** Setter exposed for `extension.ts` (wires to the `tiermux.engine.traceOcEvents` config). */
export function setOcTrace(on: boolean, sink?: (raw: string) => void): void {
  traceOcEvents = on;
  if (sink) traceSink = sink;
}

// ---- Public types (frozen — chatViewProvider depends on these) ----

export interface ToolEvent {
  toolCallId: string;
  name: string;
  args?: unknown;
  state: 'queued' | 'running' | 'done' | 'error';
  detail?: string;
}

export interface AgentResult {
  text: string;
  reasoning?: string;
  platform?: string;
  model?: string;
  runtimeName?: string;
  taskKind?: string;
  workMessages?: ChatMessage[];
  paused?: boolean;
}

export interface AgentOpts {
  messages: ChatMessage[];
  mode: 'chat' | 'agent' | 'plan';
  effort: ReasoningEffort;
  abortSignal?: AbortSignal;
  pinnedModel?: string;
  taskKind?: string;
  /** TierMux chat session id — keys the long-lived OC session (OC holds history). */
  sessionId?: string;
  // Streaming callbacks → webview postMessage
  onChunk: (text: string) => void;
  onTool: (e: ToolEvent) => void;
  onReasoning: (text: string) => void;
  onModel: (platform: string, model: string, runtimeName?: string) => void;
  onFailover: (from: string, reason: string) => void;
  onKeyRotated?: (info: { platform: string; keyIndex: number; keyTotal: number }) => void;
  onStep: (phase: string, label: string) => void;
  onTodos: (todos: TodoItem[]) => void;
  onAskUser: (question: string, options?: string[]) => Promise<string>;
  onError: (message: string) => void;
}

export type ToolSet = Record<string, any>;

// ---- OpenCode engine state ----

let ocClient: OcClient | undefined;
/** TierMux session id → OC session id (OC accumulates conversation history server-side). */
const ocSessions = new Map<string, string>();

/** Called by extension.ts once the OC backend is up (or undefined when it's gone). */
export function setOcEngine(conn: OcConnection | undefined): void {
  ocClient = conn ? new OcClient(conn) : undefined;
  if (!ocClient) ocSessions.clear();
}

/** Routing profile (virtual model the router proxy exposes) per TierMux mode. */
function profileFor(mode: 'chat' | 'agent' | 'plan'): string {
  return mode === 'chat' ? 'fast' : 'smart';
}

/**
 * Drive one agent run through OC: ensure an OC session for this TierMux session, send the
 * latest user message (OC holds prior turns), relay the global SSE events into the
 * AgentOpts callbacks, and resolve on session.idle.
 *
 * Robust to multiple OC event shapes (both `message.part.delta` for streaming and
 * `message.part.updated` for full content). On `session.idle` with no accumulated text,
 * fetches the session messages as a fallback so we always return *something* when OC did
 * produce output.
 */
async function runViaOc(opts: AgentOpts): Promise<AgentResult> {
  if (!ocClient) {
    opts.onError('OpenCode engine is not running. Run "npm run fetch:binaries" (or set OPENCODE_BIN), then reload the window.');
    return { text: '' };
  }
  const client = ocClient;

  const key = opts.sessionId ?? '__default__';
  const agent = opts.mode === 'plan' ? 'plan' : 'build';
  const modelID = profileFor(opts.mode);

  let ocId = ocSessions.get(key);
  if (!ocId) {
    try {
      const info = await client.createSession({ agent, model: { providerID: 'tiermux', modelID } });
      // Defensive: handle response shapes where the id field is named differently
      // or the entire body IS the id.
      const id = (info as any)?.id ?? (info as any)?.sessionID ?? (info as any)?.sessionId ?? (info as any)?.ID;
      if (typeof id === 'string' && id.length > 0) {
        ocId = id;
      } else if (typeof info === 'string' && (info as string).length > 0) {
        ocId = info as string;
      } else {
        console.error(`[tiermux] OC createSession returned no id. raw=`, JSON.stringify(info));
        opts.onError(`OC createSession returned no id. Raw response logged to DevTools console.`);
        return { text: '' };
      }
      ocSessions.set(key, ocId);
      console.log(`[tiermux] OC session created id=${ocId} agent=${agent} model=tiermux/${modelID}`);
    } catch (err) {
      console.error(`[tiermux] OC createSession failed:`, err);
      opts.onError(`Failed to create OC session: ${err instanceof Error ? err.message : err}`);
      return { text: '' };
    }
  } else {
    console.log(`[tiermux] reusing OC session id=${ocId}`);
  }

  // Send only the latest user message — OC maintains the conversation server-side.
  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
  const userText = typeof lastUser?.content === 'string'
    ? lastUser.content
    : lastUser?.content == null ? '' : JSON.stringify(lastUser.content);

  let out = '';
  const platform = 'tiermux';
  const model = modelID;
  opts.onModel(platform, model);
  opts.onStep('thinking', 'Working…');

  return new Promise<AgentResult>((resolve) => {
    let done = false;
    const finish = (r: AgentResult) => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      unsub();
      resolve(r);
    };

    // Track the latest text we saw per part id, so `message.part.updated` (which carries
    // the full text) can be diffed against the previous value to emit deltas.
    const lastTextByPart = new Map<string, string>();
    // Track the latest reasoning per part id (for the reasoning channel).
    const lastReasoningByPart = new Map<string, string>();
    // Track which part ids are "text" vs "reasoning" vs other.
    const partKind = new Map<string, 'text' | 'reasoning' | 'other'>();

    const onRaw = traceOcEvents && traceSink
      ? (raw: string) => { try { traceSink!(raw); } catch { /* swallow */ } }
      : undefined;

    // Safety net: if OC never sends `session.idle` (or the event name drifted),
    // fall back to a hard timeout so the chat can't hang forever. The fallback
    // also fetches session messages and extracts the last assistant text so the
    // user still gets *something* even when we never observed the idle event.
    const hardTimeoutMs = 90_000;
    const hardTimer = setTimeout(() => {
      void (async () => {
        try {
          const msgs = await client.messages(ocId!);
          const text = extractLastAssistantText(msgs);
          if (text && !out) { out = text; opts.onChunk(text); }
        } catch { /* ignore */ }
        finish({ text: out, platform, model, taskKind: opts.taskKind });
      })();
    }, hardTimeoutMs);

    const unsub = client.subscribe((ev) => {
      // OC wraps the event envelope inside a top-level `payload` field:
      //   { payload: { type: "session.idle", properties: { ... } } }
      // Older OC builds sent { type, properties } directly. Handle both.
      const payload = (ev as any).payload ?? ev;
      const p = (payload as any).properties ?? {};
      // sessionID filter: only handle events for our session
      const evSession = p.sessionID ?? p.sessionId;
      if (evSession && ocId && evSession !== ocId) return;

      const t = (payload as any).type ?? (ev as any).type ?? '';

      // Verbose event log when the trace toggle is on — captures the FULL
      // payload (not just the recognized types) so we can see what OC actually sends
      // and patch the event-mapping switch accordingly.
      if (traceOcEvents && traceSink) {
        try { traceSink(`type=${t} sessionID=${p.sessionID ?? p.sessionId ?? '-'} keys=${Object.keys(p).join(',')}`); } catch { /* swallow */ }
      }

      // ---- Streaming text deltas (some OC builds emit these) ----
      if (t === 'message.part.delta' || t === 'part.delta') {
        const delta = p.delta ?? p.text ?? '';
        const field = p.field;
        if (!delta) return;
        if (field === 'reasoning' || p.partID && partKind.get(p.partID) === 'reasoning') {
          opts.onReasoning(delta);
        } else {
          out += delta;
          opts.onChunk(delta);
        }
        return;
      }

      // ---- Full part update (OC's primary text-carrier) ----
      if (t === 'message.part.updated' || t === 'part.updated' || t === 'message.updated') {
        // Two shapes seen in OC: { part: { type, text, id, ... } } or the part at the top level.
        const part = p.part ?? (p.type ? p : null);
        if (!part) return;
        const partId: string = part.id ?? part.partID ?? p.partID ?? '';
        if (partId) {
          if (part.type === 'reasoning') partKind.set(partId, 'reasoning');
          else if (part.type === 'text') partKind.set(partId, 'text');
          else if (part.type === 'tool' || part.tool) {
            partKind.set(partId, 'other');
            opts.onTool({
              toolCallId: partId,
              name: part.tool ?? part.name ?? 'tool',
              args: part.input ?? part.args,
              state: part.state ?? 'running',
            });
            return;
          } else {
            partKind.set(partId, 'other');
          }
        }
        // Extract text and/or reasoning from the part and emit only the diff.
        if (typeof part.text === 'string') {
          const prev = lastTextByPart.get(partId) ?? '';
          if (part.text.length > prev.length && part.text.startsWith(prev)) {
            const delta = part.text.slice(prev.length);
            out += delta;
            opts.onChunk(delta);
          }
          lastTextByPart.set(partId, part.text);
        }
        if (typeof part.reasoning === 'string') {
          const prev = lastReasoningByPart.get(partId) ?? '';
          if (part.reasoning.length > prev.length && part.reasoning.startsWith(prev)) {
            const delta = part.reasoning.slice(prev.length);
            opts.onReasoning(delta);
          }
          lastReasoningByPart.set(partId, part.reasoning);
        }
        return;
      }

      // ---- Tool updates (alternate shape) ----
      if (t === 'tool.updated' || t === 'tool') {
        opts.onTool({
          toolCallId: p.id ?? p.callID ?? '',
          name: p.name ?? p.tool ?? 'tool',
          args: p.input ?? p.args,
          state: p.state ?? 'running',
          detail: p.detail,
        });
        return;
      }

      // ---- Todo list ----
      if (t === 'todo.updated' || t === 'todo') {
        try {
          const todos = p.todos ?? (Array.isArray(p) ? p : null);
          if (Array.isArray(todos)) opts.onTodos(todos as TodoItem[]);
        } catch { /* ignore */ }
        return;
      }

      // ---- Status updates ----
      if (t === 'session.status' || t === 'status') {
        opts.onStep('working', p?.status?.message ?? p?.message ?? 'Working…');
        return;
      }

      // ---- Errors ----
      if (t === 'session.error' || t === 'error') {
        const errMsg = typeof p.error === 'string'
          ? p.error
          : p.error?.message ?? p.message ?? 'OC session error';
        opts.onError(errMsg);
        return;
      }

      // ---- Session idle: resolve. If we never saw streaming deltas, fetch messages as a fallback. ----
      if (t === 'session.idle' || t === 'idle' || t === 'session.complete' || t === 'session.done' || t === 'session.completed') {
        if (out.trim()) {
          finish({ text: out, platform, model, taskKind: opts.taskKind });
          return;
        }
        // No accumulated text — fetch the session messages and pull the last assistant text.
        void (async () => {
          try {
            const msgs = await client.messages(ocId!);
            const text = extractLastAssistantText(msgs);
            if (text) {
              out = text;
              opts.onChunk(text);
            }
          } catch { /* ignore — keep whatever we have */ }
          finish({ text: out, platform, model, taskKind: opts.taskKind });
        })();
        return;
      }
    }, opts.abortSignal, onRaw);

    void client.prompt(ocId, { parts: [{ type: 'text', text: userText }], agent, model: { providerID: 'tiermux', modelID } })
      .catch((e: unknown) => { opts.onError(e instanceof Error ? e.message : String(e)); finish({ text: out, platform, model }); });

    opts.abortSignal?.addEventListener('abort', () => { void client.abort(ocId!); finish({ text: out, platform, model }); }, { once: true });
  });
}

/** Walk OC's session messages and return the last assistant text we can find. */
function extractLastAssistantText(msgs: unknown): string {
  const arr = Array.isArray(msgs) ? msgs : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const m: any = arr[i];
    if (!m || m.role !== 'assistant') continue;
    // Direct content.
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const texts: string[] = [];
      for (const p of m.content) {
        if (typeof p === 'string') { texts.push(p); continue; }
        if (p && typeof p === 'object') {
          if (typeof p.text === 'string') texts.push(p.text);
          else if (typeof p.content === 'string') texts.push(p.content);
        }
      }
      const joined = texts.join('');
      if (joined) return joined;
    }
    // Parts array (OC's shape).
    if (Array.isArray(m.parts)) {
      const texts: string[] = [];
      for (const p of m.parts) {
        if (!p || typeof p !== 'object') continue;
        if (p.type === 'text' && typeof p.text === 'string') texts.push(p.text);
        else if (typeof p.text === 'string') texts.push(p.text);
      }
      const joined = texts.join('');
      if (joined) return joined;
    }
  }
  return '';
}

// ---- Public API — what chatViewProvider calls ----

/** Chat mode: single-turn Q&A over `tiermux/fast`. */
export async function runChatStream(_router: Router, opts: AgentOpts): Promise<AgentResult> {
  return runViaOc({ ...opts, mode: 'chat' });
}

/** Agent mode: full tool loop via OC `build` over `tiermux/smart`. */
export async function runAgentStream(_router: Router, opts: AgentOpts, _tools: ToolSet): Promise<AgentResult> {
  return runViaOc({ ...opts, mode: 'agent' });
}

/** Plan mode: read-only OC `plan` agent over `tiermux/smart`. */
export async function runPlanStream(_router: Router, opts: AgentOpts, _tools: ToolSet): Promise<AgentResult> {
  return runViaOc({ ...opts, mode: 'plan' });
}

/** Session title: one-shot completion straight through the Router (no agent loop). */
export async function generateSessionTitle(router: Router, firstMessage: string): Promise<string> {
  try {
    const result = await router.route(
      [{ role: 'user', content: `Generate a 2-5 word title for a chat that starts with: "${firstMessage.slice(0, 200)}"\nReply with ONLY the title, no punctuation, no quotes.` }],
      { max_tokens: 16, temperature: 0.2 },
    );
    const text = result.response.choices?.[0]?.message?.content;
    return (typeof text === 'string' ? text : '').trim().slice(0, 60) || '';
  } catch {
    return '';
  }
}
