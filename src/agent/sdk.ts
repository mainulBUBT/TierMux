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
import { getLastRoutedModel } from '../backend/routerProxy';

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
/** TierMux session id → model id the OC session was created with (to detect model changes). */
const ocSessionModels = new Map<string, string>();

/** Called by extension.ts once the OC backend is up (or undefined when it's gone). */
export function setOcEngine(conn: OcConnection | undefined): void {
  ocClient = conn ? new OcClient(conn) : undefined;
  if (!ocClient) { ocSessions.clear(); ocSessionModels.clear(); }
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
async function runViaOc(opts: AgentOpts, _retryCount = 0, escalate = false): Promise<AgentResult> {
  if (!ocClient) {
    opts.onError('TierMux engine is not running. Run "npm run fetch:binaries" (or set OPENCODE_BIN), then reload the window.');
    return { text: '' };
  }
  const client = ocClient;

  const key = opts.sessionId ?? '__default__';
  // `planx` is our custom read-only planner (returns the plan as text). NOT OC's built-in `plan`,
  // which writes a plan file and plan_exit-hands-off to build — wrong for TierMux's planProposed card.
  const agent = opts.mode === 'chat' ? 'chat' : opts.mode === 'plan' ? 'planx' : 'build';
  // Honor the user's explicitly-selected model; fall back to the routing profile only when on auto.
  // `escalate` (set by the empty-result takeover below) forces the `smart` profile so a retried run
  // lands on a stronger, intelligence-first model instead of re-picking the weak free one that just
  // produced no answer. We do NOT override an explicit user pin — only the auto/profile path.
  const profile = escalate ? 'smart' : profileFor(opts.mode);
  const modelID = opts.pinnedModel && opts.pinnedModel !== 'auto' ? opts.pinnedModel : profile;

  let ocId = ocSessions.get(key);
  // If the user changed the model since the last run, the existing OC session was created
  // with the old model. OC doesn't switch models mid-session, so we start a fresh one.
  if (ocId && ocSessionModels.get(key) !== modelID) {
    console.log(`[tiermux] model changed (${ocSessionModels.get(key)} → ${modelID}), resetting OC session`);
    ocSessions.delete(key);
    ocSessionModels.delete(key);
    ocId = undefined;
  }
  // OC rejects model IDs containing special chars like '::', ':', '/' (500s on session create/prompt).
  // Base64url-encode any non-virtual model ID so OC sees only safe alphanum chars.
  // routerProxy decodes the 'tm_' prefix back to the real model before routing.
  const VIRTUAL = new Set(['auto', 'fast', 'smart']);
  const ocModelID = VIRTUAL.has(modelID)
    ? modelID
    : 'tm_' + Buffer.from(modelID).toString('base64url');
  if (!ocId) {
    try {
      // OC's createSession schema wants `model.id` (NOT `model.modelID`, which the
      // prompt endpoint uses). Sending modelID here 400s and the agent never starts.
      const info = await client.createSession({ agent, model: { providerID: 'tiermux', id: ocModelID } });
      // Defensive: handle response shapes where the id field is named differently
      // or the entire body IS the id.
      const id = (info as any)?.id ?? (info as any)?.sessionID ?? (info as any)?.sessionId ?? (info as any)?.ID;
      if (typeof id === 'string' && id.length > 0) {
        ocId = id;
      } else if (typeof info === 'string' && (info as string).length > 0) {
        ocId = info as string;
      } else {
        console.error(`[tiermux] OC createSession returned no id. raw=`, JSON.stringify(info));
        opts.onError(`TierMux engine could not start a session. Raw response logged to DevTools console.`);
        return { text: '' };
      }
      ocSessions.set(key, ocId);
      ocSessionModels.set(key, modelID);
      console.log(`[tiermux] OC session created id=${ocId} agent=${agent} model=tiermux/${modelID}`);
    } catch (err) {
      console.error(`[tiermux] OC createSession failed:`, err);
      opts.onError(`TierMux engine failed to start a session: ${err instanceof Error ? err.message : err}`);
      return { text: '' };
    }
  } else {
    console.log(`[tiermux] reusing OC session id=${ocId} model=${modelID}`);
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
      clearTimeout(watchdog);
      unsub();
      // Replace the virtual profile ("fast"/"smart") with the concrete provider+model
      // the Router actually resolved this run onto, so the UI shows the real pick (e.g.
      // "chutes / stepfun/step-3.7-flash:free") instead of the generic "tiermux".
      const routed = getLastRoutedModel();
      if (routed && routed.model && routed.model !== model) {
        const realPlatform = routed.runtimeName ?? routed.platform;
        opts.onModel(realPlatform, routed.model, routed.runtimeName);
        resolve({ ...r, platform: realPlatform, model: routed.model, runtimeName: routed.runtimeName });
        return;
      }
      resolve(r);
    };

    // Empty-result takeover: if a run ends with NO usable text (model gave up, tool loop
    // died empty, OC errored mid-run), retry ONCE on the `smart` profile so a stronger
    // model takes over — mirrors the 5xx retry in the prompt().catch() below. Bounded by
    // `_retryCount` so a genuinely unanswerable turn still terminates. Returns true when a
    // retry was kicked off; the caller MUST then skip finish() (the retry resolves later).
    // Only invoked asynchronously (from event handlers / watchdog), by which point
    // `unsub`/`watchdog` below are initialized.
    const tryEscalate = (): boolean => {
      if (out.trim() || _retryCount) return false;
      console.log(`[tiermux] OC run produced no answer — escalating to smart profile, retrying once`);
      opts.onFailover(`tiermux/${profile}`, 'no_answer → escalating to smart');
      ocSessions.delete(key);
      ocSessionModels.delete(key);
      unsub();
      clearTimeout(watchdog);
      void runViaOc(opts, 1, true).then(finish);
      return true;
    };

    // Track the latest text we saw per part id, so `message.part.updated` (which carries
    // the full text) can be diffed against the previous value to emit deltas.
    const lastTextByPart = new Map<string, string>();
    // Track the latest reasoning per part id (for the reasoning channel).
    const lastReasoningByPart = new Map<string, string>();
    // Track which part ids are "text" vs "reasoning" vs other.
    const partKind = new Map<string, 'text' | 'reasoning' | 'other'>();
    // Track message-id → role (from `message.updated`). OC fires part events for the
    // USER message too; without this we'd stream the user's own text back as the answer.
    const messageRole = new Map<string, string>();
    const roleOfPart = (part: any, p: any): string | undefined => {
      if (part?.role) return part.role;
      const mid = part?.messageID ?? part?.messageId ?? p?.messageID ?? p?.messageId;
      return mid ? messageRole.get(mid) : undefined;
    };
    // OC emits BOTH `message.part.delta` (incremental) and `message.part.updated`
    // (cumulative) for the same text on some builds. Processing both doubles every
    // token. Lock onto whichever text channel speaks first and ignore the other.
    let textChannel: 'delta' | 'updated' | undefined;

    const onRaw = traceOcEvents && traceSink
      ? (raw: string) => { try { traceSink!(raw); } catch { /* swallow */ } }
      : undefined;

    // Inactivity watchdog — NOT a total-run timeout. `session.idle` is the normal
    // resolver; this only fires if OC goes completely silent (no SSE events at all)
    // for the window below, which means the engine died or the event name drifted.
    // Every event resets it (see resetWatchdog() in the subscribe callback), so an
    // actively-streaming run — however long — is never cut short. User cancel resolves
    // immediately via the abort path. On fire we still try to salvage the last message.
    const INACTIVITY_MS = 3 * 60_000;
    let watchdog: ReturnType<typeof setTimeout>;
    const resetWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        void (async () => {
          try {
            const msgs = await client.messages(ocId!);
            const text = extractLastAssistantText(msgs);
            if (text && !out) { out = text; opts.onChunk(text); }
          } catch { /* ignore */ }
          if (tryEscalate()) return;
          finish({ text: out, platform, model, taskKind: opts.taskKind });
        })();
      }, INACTIVITY_MS);
    };
    resetWatchdog();

    const unsub = client.subscribe((ev) => {
      resetWatchdog(); // any event = OC is alive; keep the run going

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
        // Skip deltas from the user message part (echo guard).
        if (roleOfPart(p.part ?? p, p) === 'user') return;
        if (field === 'reasoning' || p.partID && partKind.get(p.partID) === 'reasoning') {
          opts.onReasoning(delta);
        } else {
          if (textChannel === 'updated') return; // updated channel owns text — avoid double emit
          textChannel = 'delta';
          out += delta;
          opts.onChunk(delta);
        }
        return;
      }

      // ---- Message metadata (carries the role; also where OC may report the model) ----
      if (t === 'message.updated' || t === 'message') {
        const info = p.info ?? p.message ?? p;
        const mid = info?.id ?? info?.messageID ?? info?.messageId;
        if (mid && info?.role) messageRole.set(mid, info.role);
        return;
      }

      // ---- Full part update (OC's primary text-carrier) ----
      if (t === 'message.part.updated' || t === 'part.updated') {
        // Two shapes seen in OC: { part: { type, text, id, ... } } or the part at the top level.
        const part = p.part ?? (p.type ? p : null);
        if (!part) return;
        // Ignore parts that belong to the USER message — otherwise we echo the prompt back.
        if (roleOfPart(part, p) === 'user') return;
        const partId: string = part.id ?? part.partID ?? p.partID ?? '';
        if (partId) {
          if (part.type === 'reasoning') partKind.set(partId, 'reasoning');
          else if (part.type === 'text') partKind.set(partId, 'text');
          else if (part.type === 'tool' || part.tool) {
            partKind.set(partId, 'other');
            // OC 1.x tool part: { type:'tool', tool, state:{ status, input, output, title } }.
            // `state` is an OBJECT (not a string) — passing it through verbatim renders as
            // "[object Object]" and loses the input/output. Unpack it here.
            const st = part.state;
            const stObj = st && typeof st === 'object' ? st : null;
            const status = stObj?.status ?? (typeof st === 'string' ? st : 'running');
            opts.onTool({
              toolCallId: partId,
              name: normalizeToolName(part.tool ?? part.name ?? 'tool'),
              args: stObj?.input ?? part.input ?? part.args,
              state: mapToolStatus(status),
              detail: stObj?.output ?? stObj?.title ?? part.output ?? undefined,
            });
            return;
          } else {
            partKind.set(partId, 'other');
          }
        }
        // Reasoning parts carry their text in `part.text` (not `part.reasoning`); route it
        // to the reasoning channel so it shows as a Thinking block, not as the answer.
        if (partKind.get(partId) === 'reasoning' && typeof part.text === 'string') {
          const prev = lastReasoningByPart.get(partId) ?? '';
          if (part.text.length > prev.length && part.text.startsWith(prev)) {
            opts.onReasoning(part.text.slice(prev.length));
          }
          lastReasoningByPart.set(partId, part.text);
          return;
        }
        // Extract text and/or reasoning from the part and emit only the diff.
        // Skip when the delta channel already owns text emission (avoid double emit).
        if (typeof part.text === 'string' && textChannel !== 'delta') {
          textChannel = 'updated';
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
        const st = p.state;
        const stObj = st && typeof st === 'object' ? st : null;
        const status = stObj?.status ?? (typeof st === 'string' ? st : 'running');
        opts.onTool({
          toolCallId: p.id ?? p.callID ?? '',
          name: normalizeToolName(p.name ?? p.tool ?? 'tool'),
          args: stObj?.input ?? p.input ?? p.args,
          state: mapToolStatus(status),
          detail: stObj?.output ?? p.detail,
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
        // Resolve the run NOW — otherwise the promise hangs until the 90s hard timeout,
        // leaving "Working…" and any in-flight todos stuck on screen after a failure.
        // If we got no text, first try to take over on a stronger model (once). Escalate
        // BEFORE surfacing the error: otherwise a run that recovers (or fails and retries)
        // shows a redundant red error — the failover notice already explains the takeover.
        if (tryEscalate()) return;
        opts.onError(errMsg);
        finish({ text: out, platform, model, taskKind: opts.taskKind });
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
          // Still no answer after the fallback fetch — let a stronger model take over (once).
          if (tryEscalate()) return;
          finish({ text: out, platform, model, taskKind: opts.taskKind });
        })();
        return;
      }
    }, opts.abortSignal, onRaw);

    void client.prompt(ocId, { parts: [{ type: 'text', text: userText }], agent, model: { providerID: 'tiermux', modelID: ocModelID } }, opts.abortSignal)
      .catch((e: unknown) => {
        // User-cancel aborts the POST too — that's expected, not an error to surface.
        if (opts.abortSignal?.aborted) { finish({ text: out, platform, model }); return; }
        const msg = e instanceof Error ? e.message : String(e);
        // 5xx means the OC session is broken (server-side crash, stale session after restart, etc.).
        // Drop it from the cache so the next attempt gets a fresh session, then retry once automatically.
        const is5xx = /→\s*5\d\d/.test(msg);
        if (is5xx && _retryCount === 0) {
          console.log(`[tiermux] OC prompt() 5xx — dropping session ${ocId}, retrying with a fresh session`);
          ocSessions.delete(key);
          ocSessionModels.delete(key);
          unsub();
          clearTimeout(watchdog);
          // Retry the full run (will create a new OC session on the way in).
          void runViaOc(opts, 1).then(finish);
          return;
        }
        opts.onError(msg);
        finish({ text: out, platform, model });
      });

    opts.abortSignal?.addEventListener('abort', () => { void client.abort(ocId!); finish({ text: out, platform, model }); }, { once: true });
  });
}

/** Map OC tool names onto the names the webview's tool-label table recognizes. */
const OC_TOOL_NAMES: Record<string, string> = {
  bash: 'runCommand',
  read: 'readFile',
  write: 'writeFile',
  edit: 'editFile',
  list: 'listDir',
  glob: 'glob',
  grep: 'grep',
  webfetch: 'webFetch',
  web_fetch: 'webFetch',
  websearch: 'webSearch',
  web_search: 'webSearch',
  task: 'skill',
};
function normalizeToolName(name: string): string {
  return OC_TOOL_NAMES[name?.toLowerCase?.()] ?? name;
}

/** Map OC's tool-part status onto the webview's running/done/error state. */
function mapToolStatus(status: string): 'running' | 'done' | 'error' {
  switch (status) {
    case 'completed':
    case 'done':
    case 'success': return 'done';
    case 'error':
    case 'failed': return 'error';
    default: return 'running';
  }
}

/** Walk OC's session messages and return the last assistant text we can find. */
function extractLastAssistantText(msgs: unknown): string {
  const arr = Array.isArray(msgs) ? msgs : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const m: any = arr[i];
    // OC wraps each message as { info: { role, ... }, parts: [...] }; older/flat
    // shapes put role at the top. Check both so we never return the user's message.
    const role = m?.info?.role ?? m?.role;
    if (!m || role !== 'assistant') continue;
    // Direct content.
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const texts: string[] = [];
      for (const p of m.content) {
        if (typeof p === 'string') { texts.push(p); continue; }
        if (p && typeof p === 'object') {
          // Never surface reasoning (chain-of-thought) or tool parts as the answer —
          // reasoning is where models ramble identity text ("As Claude Code, I…"), which
          // otherwise leaks in as "random words" when a run ends via this fallback.
          if (p.type === 'reasoning' || p.type === 'tool' || p.type === 'tool_call') continue;
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
        if (p.type === 'reasoning' || p.type === 'tool') continue;
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

/**
 * Chat mode: a question answered with **read-only tool access**. Runs through OC's custom
 * `chat` agent (defined in ocConfig.ts) over `tiermux/fast` — the agent may inspect the
 * project (read/list/glob/grep) and fetch current info (web_fetch/web_search), but cannot
 * edit/write files or run commands. The OC session is keyed by TierMux session id so prior
 * turns are retained server-side, just like agent/plan mode.
 *
 * (Previously this streamed straight through the Router with no tools — fast, but the model
 * could neither see the project nor reach the web. Routed through OC now so chat can answer
 * codebase and realtime questions; the lean tool set keeps trivial questions to ~one round-trip.)
 */
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
