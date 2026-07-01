// Router Proxy — a dumb HTTP bridge that exposes TierMux's Router as an
// OpenAI-compatible `/v1` endpoint. The keystone of the OpenCode integration:
// OpenCode (the bundled agent engine) is pointed at this URL as a custom
// `@ai-sdk/openai-compatible` provider, so every model call OC makes is routed
// across TierMux's 22+ free providers with automatic failover.
//
// Implements only protocol translation. No session state, no retry logic (the
// Router owns failover), no streaming-state machine — those are OC's job on the
// other side of this wire. See ARCHITECTURE.md → "Router Proxy".
//
//   GET  /v1/models            → catalog models + virtual routing profiles
//   POST /v1/chat/completions  → Router.route(), streamed or buffered
import * as http from 'http';
import type { Router } from '../router/router';
import type { RouteOptions } from '../router/router';
import type {
  ChatMessage,
  ChatToolDefinition,
  ChatToolChoice,
  ReasoningEffort,
} from '../shared/types';
import { AllModelsFailedError } from '../router/router';
import { classifyTask, type TaskKind } from '../agent/routing';

/** Virtual models OC can request to select a routing profile (vs. a real model). */
const PROFILE_FAST = 'tiermux/fast';
const PROFILE_SMART = 'tiermux/smart';
const PROFILE_AUTO = 'tiermux/auto';

// The concrete provider+model the Router last resolved a turn onto (e.g. platform
// "chutes", model "stepfun/step-3.7-flash:free"), as opposed to the virtual profile OC
// requested ("tiermux/auto"). The agent driver (sdk.ts) reads this to show the *actual*
// picked model in the UI instead of the "tiermux" placeholder. Safe because runs are
// serialized — there is only ever one active run, so "last" == "current".
export interface RoutedModel { platform: string; model: string; runtimeName?: string }
let lastRouted: RoutedModel | undefined;
export function getLastRoutedModel(): RoutedModel | undefined {
  return lastRouted;
}

/**
 * The non-virtual model the current run wants forced (e.g. "custom::c_abc123::gpt-4o").
 * Set by sdk.ts before prompting OC; cleared when the run resolves. Safe as a singleton
 * because runs are serialized — only one active OC run exists at any moment. When set,
 * mapProfile returns this model regardless of what OC sent in the `model` field, so
 * OC sessions can always use a virtual profile (no static registry requirement) while
 * the router still forces the real pinned model on every completion call.
 */
let forcedModelForRun: string | undefined;
export function setForcedModel(m: string | undefined): void { forcedModelForRun = m; }
export function getForcedModel(): string | undefined { return forcedModelForRun; }

export interface RouterProxyServer {
  port: number;
  baseURL: string;
  close(): void;
}

/**
 * Start the OpenAI-compatible router proxy on a random localhost port.
 * The caller (OC launcher) writes this `baseURL` into the opencode provider config.
 */
export function startRouterProxy(router: Router): Promise<RouterProxyServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => handle(req, res, router));
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Router proxy failed to bind'));
        return;
      }
      const port = addr.port;
      resolve({
        port,
        baseURL: `http://127.0.0.1:${port}/v1`,
        close: () => server.close(),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

async function handle(req: http.IncomingMessage, res: http.ServerResponse, router: Router): Promise<void> {
  // Same-origin / CORS: OC's SDK may run inside a webview; the random port is
  // the only thing exposed and it's bound to loopback, so permissive CORS is fine.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-opencode-directory');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url ?? '';
  try {
    if (req.method === 'GET' && url === '/v1/models') {
      await handleModels(router, res);
      return;
    }
    if (req.method === 'POST' && url === '/v1/chat/completions') {
      await handleChatCompletion(req, res, router);
      return;
    }
    // OpenAI-compatible servers are sometimes probed at /v1 or /models by health checks.
    if (req.method === 'GET' && (url === '/' || url === '/v1' || url === '/models')) {
      await handleModels(router, res);
      return;
    }
    sendError(res, 404, `Not found: ${req.method} ${url}`);
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

async function handleModels(router: Router, res: http.ServerResponse): Promise<void> {
  // Expose virtual routing profiles first (these are what OC's model picker should show),
  // then every enabled catalog model so an OC user can also pin a real provider.
  const data: Array<{ id: string; object: 'model'; created: number; owned_by: string }> = [
    { id: PROFILE_AUTO, object: 'model', created: 0, owned_by: 'tiermux' },
    { id: PROFILE_FAST, object: 'model', created: 0, owned_by: 'tiermux' },
    { id: PROFILE_SMART, object: 'model', created: 0, owned_by: 'tiermux' },
  ];
  for (const m of listEnabledModels(router)) {
    // Expose the tm_-encoded ID (not the raw platform::modelId) so OC accepts it at session
    // creation. Raw IDs contain '::', '/', ':' which OC rejects. sdk.ts sends the same
    // encoding; mapProfile decodes it back before routing.
    const rawId = `${m.platform}::${m.modelId}`;
    const encodedId = 'tm_' + Buffer.from(rawId).toString('base64url');
    data.push({ id: encodedId, object: 'model', created: 0, owned_by: m.platform });
  }
  sendJSON(res, 200, { object: 'list', data });
}

/** All enabled models (catalog + custom endpoints) in the fallback chain. */
function listEnabledModels(router: Router): Array<{ platform: string; modelId: string }> {
  // Include ALL enabled entries — catalog models AND custom endpoint models.
  // Previously this filtered through catalog.find(), which silently dropped custom
  // endpoint models (they have no catalog entry), causing OC to 500 when asked to
  // use them (the encoded model ID never appeared in /v1/models so OC rejected it).
  return (router as unknown as {
    settings: { enabledByPriority(): Array<{ platform: string; modelId: string }> };
  }).settings.enabledByPriority();
}

// ---------------------------------------------------------------------------
// POST /v1/chat/completions
// ---------------------------------------------------------------------------

interface IncomingRequest {
  model?: string;
  messages?: unknown[];
  stream?: boolean;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  parallel_tool_calls?: boolean;
  // OpenAI passes reasoning effort under several keys depending on SDK version.
  reasoning_effort?: ReasoningEffort;
  reasoning?: { effort?: ReasoningEffort };
}

async function handleChatCompletion(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  router: Router,
): Promise<void> {
  const body = await readJSON<IncomingRequest>(req);
  if (!body.messages || !Array.isArray(body.messages)) {
    sendError(res, 400, 'Missing or invalid "messages"');
    return;
  }

  const messages = body.messages.map(toTierMuxMessage);
  const stream = body.stream === true;
  const lastUserText = extractLastUserText(body.messages);
  console.log(`[tiermux][DBG] completion-request: model=${body.model ?? '-'} max_tokens=${body.max_tokens ?? 'UNSET'} stream=${stream} msgs=${messages.length} tools=${(body.tools ?? []).length}`);

  const routeOpts: RouteOptions = {
    ...mapProfile(body.model, lastUserText),
    tools: body.tools,
    tool_choice: body.tool_choice,
    parallel_tool_calls: body.parallel_tool_calls,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    top_p: body.top_p,
    reasoningEffort: body.reasoning_effort ?? body.reasoning?.effort,
    // Agent turns (tools present) must land on tool-capable models; OC always
    // sends tools for plan/build, so this keeps routing honest.
    requireTools: !!(body.tools && body.tools.length),
  };

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // The Router streams text deltas through onChunk only on tool-free turns.
    // Tool-call turns return a single buffered response; in that case we emit the
    // whole thing as one chunk so OC still sees a well-formed stream.
    let buffered = '';
    const chunks: string[] = [];
    routeOpts.onChunk = (delta) => {
      chunks.push(delta);
      sendSSE(res, makeChunk(body.model ?? 'tiermux', { content: delta }));
    };

    try {
      const result = await router.route(messages, routeOpts);
      lastRouted = { platform: result.platform, model: result.model, runtimeName: result.runtimeName };
      buffered = chunks.join('');
      const choice = result.response.choices?.[0];
      // Tool-call turns (OC sends tools for chat/build/plan) don't stream via
      // onChunk — the Router buffers and returns a single response. Nothing was
      // streamed, so emit the final message (text + tool_calls) as one chunk;
      // otherwise OC receives an empty assistant message → blank reply.
      if (!chunks.length) {
        const msg = choice?.message;
        const content = typeof msg?.content === 'string' ? msg.content : '';
        if (content || msg?.tool_calls?.length) {
          sendSSE(res, makeChunk(body.model ?? 'tiermux', {
            ...(content ? { content } : {}),
            ...(msg?.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
          }));
        }
      }
      // Final chunk: finish_reason MUST match what the turn actually was. A tool-call
      // turn ends with 'tool_calls' (NOT 'stop') — OC's agent loop keys off this to
      // execute the requested tools and feed their results back for another step.
      // Sending 'stop' on a tool-call turn makes OC run the tool ONCE then end the run
      // with no follow-up answer (the "tool runs, then it stops" symptom). Honor the
      // upstream finish_reason (the Router passes the provider's value through), and
      // force 'tool_calls' when tool_calls are present as a safety net.
      const toolMsg = choice?.message;
      const hasTools = !!toolMsg?.tool_calls?.length;
      const upstreamReason = choice?.finish_reason;
      const finishReason: string = hasTools
        ? 'tool_calls'
        : (upstreamReason && upstreamReason !== 'tool_calls' ? upstreamReason : 'stop');
      const usage = result.response.usage;
      sendSSE(res, makeChunk(body.model ?? 'tiermux', { content: '' }, finishReason, result.response.model, usage));
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      // If we already streamed partial text, we can't change the HTTP status —
      // emit the error inline as an OpenAI-style error chunk and close. OC surfaces it.
      if (buffered) {
        sendSSE(res, makeErrorChunk(err));
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(statusFor(err), { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(openAIError(err)));
      }
    }
    return;
  }

  // Non-streaming: the Router already returns an OpenAI-shaped ChatCompletionResponse.
  try {
    const result = await router.route(messages, routeOpts);
    lastRouted = { platform: result.platform, model: result.model, runtimeName: result.runtimeName };
    sendJSON(res, 200, result.response);
  } catch (err) {
    res.writeHead(statusFor(err), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(openAIError(err)));
  }
}

/**
 * Extract the text of the last user-role message from an OC messages array.
 * Used to classify the task kind for smart routing. Finds the last user turn
 * even when the messages array ends with tool results (multi-step agent runs).
 */
function extractLastUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown>;
    if (m.role !== 'user') continue;
    const content = m.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((p: unknown) => {
          const part = p as Record<string, unknown>;
          return part.type === 'text' ? String(part.text ?? '') : '';
        })
        .join(' ')
        .trim();
    }
  }
  return '';
}

/**
 * Map an OC-requested model id onto Router routing knobs.
 * - Virtual profiles (tiermux/fast|smart|auto) select a routing profile.
 * - Real ids (platform::modelId) are passed through to pin a specific model.
 */
function mapProfile(model: string | undefined, lastUserText?: string): { model?: string; taskKind?: TaskKind } {
  // If sdk.ts set a forced model for this run, use it unconditionally — OC's session
  // was created with a virtual profile (so OC accepts it without a registry entry),
  // but the router must still force the real pinned model on every completion call.
  const forced = getForcedModel();
  if (forced) return { model: forced };

  // OC's @ai-sdk/openai-compatible adapter sends the BARE model id ("auto"/"fast"/
  // "smart"), not the provider-prefixed "tiermux/auto" we declare it under. Accept
  // both the bare id and the "tiermux/"-prefixed form so routing works either way.
  const bare = (p: string) => p.replace(/^tiermux\//, '');
  // Decode base64url-encoded model IDs (sdk.ts encodes any non-virtual model with 'tm_' prefix
  // because OC rejects special chars like '::', ':', '/' in model IDs and returns 500).
  const decode = (p: string) => p.startsWith('tm_') ? Buffer.from(p.slice(3), 'base64url').toString('utf8') : p;
  const id = decode(bare(model ?? PROFILE_AUTO));
  if (id === bare(PROFILE_AUTO)) {
    return { model: 'auto' };
  }
  if (id === bare(PROFILE_FAST)) {
    // Speed-first ordering — chat mode is always read-only Q&A, so fast wins.
    return { model: 'auto', taskKind: 'chat' };
  }
  if (id === bare(PROFILE_SMART)) {
    // Classify the actual user message so the right model comparator fires:
    // debug → reasoning models, coding → coder-tagged, trivial → speed-first, etc.
    // Falls back to 'agent' when there's no user text (e.g. health-check probes).
    const kind: TaskKind = lastUserText ? classifyTask(lastUserText) : 'agent';
    return { model: 'auto', taskKind: kind };
  }
  // A real tm_-encoded platform::modelId — pass the decoded id.
  return { model: id };
}

// ---------------------------------------------------------------------------
// Message mapping (OpenAI → TierMux). The shapes are already near-identical;
// we normalize the bits that differ (array content, tool role).
// ---------------------------------------------------------------------------

function toTierMuxMessage(raw: unknown): ChatMessage {
  const m = raw as Record<string, unknown>;
  const role = (m.role as ChatMessage['role']) ?? 'user';
  let content = m.content as ChatMessage['content'];
  if (Array.isArray(content)) {
    // Collapse OpenAI content parts (text / image_url) into TierMux blocks.
    content = content
      .map((part) => {
        if (typeof part === 'string') return part;
        const p = part as { type?: string; text?: string };
        if (p.type === 'text' || (p.text !== undefined && p.type === undefined)) return p.text ?? '';
        // Non-text parts (images) are passed through as blocks; the provider adapters handle them.
        return part;
      });
  }
  const out: ChatMessage = { role, content };
  if (m.name) out.name = m.name as string;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id as string;
  if (m.tool_calls) out.tool_calls = m.tool_calls as ChatMessage['tool_calls'];
  if (m.reasoning_content) out.reasoning_content = m.reasoning_content as string;
  return out;
}

// ---------------------------------------------------------------------------
// OpenAI SSE framing helpers
// ---------------------------------------------------------------------------

function makeChunk(
  model: string,
  delta: { content?: string; tool_calls?: ChatMessage['tool_calls'] },
  finish_reason: string | null = null,
  routedModel?: string,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
) {
  return {
    id: `chatcmpl-tiermux-${Math.random().toString(36).slice(2)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    // Surface the model the router actually picked so OC's UI shows it.
    model: routedModel ?? model,
    choices: [{ index: 0, delta, finish_reason }],
    ...(usage ? { usage } : {}),
  };
}

function makeErrorChunk(err: unknown) {
  return { error: { message: describeError(err), type: 'server_error' } };
}

function sendSSE(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// ---------------------------------------------------------------------------
// Body reading + error shaping
// ---------------------------------------------------------------------------

function readJSON<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJSON(res, status, openAIError(new Error(message)));
}

function openAIError(err: unknown): { error: { message: string; type: string } } {
  return { error: { message: describeError(err), type: 'server_error' } };
}

function describeError(err: unknown): string {
  if (err instanceof AllModelsFailedError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function statusFor(err: unknown): number {
  // All models failed = no upstream available → 503. Anything else = 500.
  if (err instanceof AllModelsFailedError) return 503;
  return 500;
}
