
import * as http from 'http';
import type { Router } from '../router/router';
import type { RouteOptions } from '../router/router';
import type {
  ChatContentBlock,
  ChatMessage,
  ChatToolDefinition,
  ChatToolChoice,
  ReasoningEffort,
  Platform,
} from '../shared/types';
import { AllModelsFailedError, NoVisionModelError } from '../router/router';
import { classifyTask, attachmentKindsFromContent, type TaskKind } from '../agent/routing';
import { normalizeAttachmentBlocks } from '../agent/content';

/** Virtual models OC can request to select a routing profile (vs. a real model). */
const PROFILE_FAST = 'tiermux/fast';
const PROFILE_SMART = 'tiermux/smart';
const PROFILE_AUTO = 'tiermux/auto';

export interface RoutedModel { platform: string; model: string; runtimeName?: string }
let lastRouted: RoutedModel | undefined;
export function getLastRoutedModel(): RoutedModel | undefined {
  return lastRouted;
}

/** The Router serving this proxy, for whole-turn outcome recording (set in startRouterProxy). */
let activeRouter: Router | undefined;
/** Record a whole-turn outcome against the model that actually served it (the last routed
 *  model of the run). Used by the agent layer when a turn HTTP-succeeded but produced no
 *  usable answer, which the per-completion metrics can't see. No-op if nothing routed yet. */
export function noteTurnOutcome(taskKind: TaskKind, ok: boolean, totalMs: number): void {
  if (activeRouter && lastRouted?.model) {
    activeRouter.noteTurnOutcome(lastRouted.platform as Platform, lastRouted.model, taskKind, ok, totalMs);
  }
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

/**
 * Forces the Router's task-kind classification for every completion call in the
 * current OC run. Why this exists: agent-mode routing happens per-call inside
 * mapProfile, which redetects vision from the request's last-user content. But
 * OC doesn't always forward image/file blocks in its completion requests, so the
 * redetection can miss a visual attachment and hand the turn to a text-only model
 * ("I can't read this PDF"). sdk.ts has the REAL user content and computes the
 * true taskKind up front (sdk.ts:259); it pushes 'vision' through here so the
 * whole agent run uses a vision-capable model regardless of what OC forwards.
 * Cleared at every run exit, alongside setForcedModel. Single global — safe only
 * because agent runs are serialized (same reason setForcedModel is).
 */
let forcedTaskKindForRun: TaskKind | undefined;
export function setForcedTaskKind(k: TaskKind | undefined): void { forcedTaskKindForRun = k; }
export function getForcedTaskKind(): TaskKind | undefined { return forcedTaskKindForRun; }

/**
 * The real `image_url`/`file` content blocks from the run's true user turn, captured
 * directly by sdk.ts (same source as setForcedTaskKind — sdk.ts:259). Why this exists:
 * OC doesn't reliably forward attachment blocks when it re-serializes a turn into the
 * completion request it POSTs back here (see setForcedTaskKind's comment) — so a vision
 * model gets correctly picked but then receives a request with the image/PDF silently
 * missing, and answers from empty context with no visible error. handleChatCompletion
 * splices these back into the last user message whenever OC's own request arrived
 * without any attachment block. Cleared at every run exit, alongside setForcedTaskKind.
 */
let forcedAttachmentsForRun: ChatContentBlock[] | undefined;
export function setForcedAttachments(blocks: ChatContentBlock[] | undefined): void {
  forcedAttachmentsForRun = blocks?.length ? blocks : undefined;
}
export function getForcedAttachments(): ChatContentBlock[] | undefined { return forcedAttachmentsForRun; }

/**
 * The user's composer-selected reasoning effort for the current OC run. Same channel as
 * setForcedTaskKind/setForcedAttachments and for the same reason: OC's own re-serialized
 * completion request has no way to carry it (it's a TierMux composer setting, not part of
 * OC's PromptBody or its static ocConfig.ts model registry), so without this the effort
 * picker had zero effect on the actual request. Cleared at every run exit, alongside the
 * other forced-* channels.
 */
/**
 * Run-scoped listener for router-level failover events (model skipped, rate-limit
 * wait, escalation). Same lifecycle as the other forced-* channels: set by sdk.ts
 * before prompting OC, cleared at run exit. Without this bridge, router failovers
 * during OC-driven completions are invisible — the UI just shows an idle spinner
 * while the router silently waits out cooldowns or walks the fallback chain.
 */
let routeFailoverListenerForRun: ((from: string, reason: string) => void) | undefined;
export function setRouteFailoverListener(fn: ((from: string, reason: string) => void) | undefined): void {
  routeFailoverListenerForRun = fn;
}

/** Flattened Smart Auto scoring rationale for a single route() — the "why this model?" surface. */
export interface RouteRationaleInfo {
  taskKind: string;
  /** `${platform}::${modelId}` of the winner, if any. */
  picked?: string;
  entries: Array<{
    model: string; // `${platform}::${modelId}`
    selected: boolean;
    score: number;
    capability: number;
    runtime: number;
    preference: number;
    confidence: number;
    reason: string;
    skip?: string;
  }>;
}

let routeRationaleListenerForRun: ((info: RouteRationaleInfo) => void) | undefined;
export function setRouteRationaleListener(fn: ((info: RouteRationaleInfo) => void) | undefined): void {
  routeRationaleListenerForRun = fn;
}

let forcedReasoningEffortForRun: ReasoningEffort | undefined;
export function setForcedReasoningEffort(e: ReasoningEffort | undefined): void {
  forcedReasoningEffortForRun = e && e !== 'off' ? e : undefined;
}
export function getForcedReasoningEffort(): ReasoningEffort | undefined { return forcedReasoningEffortForRun; }

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
  activeRouter = router;
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

async function handle(req: http.IncomingMessage, res: http.ServerResponse, router: Router): Promise<void> {

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

    if (req.method === 'GET' && (url === '/' || url === '/v1' || url === '/models')) {
      await handleModels(router, res);
      return;
    }
    sendError(res, 404, `Not found: ${req.method} ${url}`);
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : String(err));
  }
}

async function handleModels(router: Router, res: http.ServerResponse): Promise<void> {

  const data: Array<{ id: string; object: 'model'; created: number; owned_by: string }> = [
    { id: PROFILE_AUTO, object: 'model', created: 0, owned_by: 'tiermux' },
    { id: PROFILE_FAST, object: 'model', created: 0, owned_by: 'tiermux' },
    { id: PROFILE_SMART, object: 'model', created: 0, owned_by: 'tiermux' },
  ];
  for (const m of listEnabledModels(router)) {

    const rawId = `${m.platform}::${m.modelId}`;
    const encodedId = 'tm_' + Buffer.from(rawId).toString('base64url');
    data.push({ id: encodedId, object: 'model', created: 0, owned_by: m.platform });
  }
  sendJSON(res, 200, { object: 'list', data });
}

/** All enabled models (catalog + custom endpoints) in the fallback chain. */
function listEnabledModels(router: Router): Array<{ platform: string; modelId: string }> {

  return (router as unknown as {
    settings: { enabledByPriority(): Array<{ platform: string; modelId: string }> };
  }).settings.enabledByPriority();
}

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
  if (forcedTaskKindForRun === 'vision' && forcedAttachmentsForRun) {
    reinjectMissingAttachments(messages, forcedAttachmentsForRun);
  }

  // NOTE: webfetch / websearch are OC's native built-in tool ids (no underscore —
  // verified against OC's own tool registry) provided natively by OC (permission:
  // 'allow' in ocConfig.ts), so OC sends them in body.tools and executes them itself
  // in its agent loop. We must NOT inject or intercept webfetch here — doing so
  // hijacks OC's tool_call (OC never sees it) and replaces its fetch with a worse one.
  //
  // The "NEVER make more than 2 webfetch calls in one turn" rule in ocConfig.ts is
  // a prompt instruction, which models don't reliably obey. Enforce it deterministically:
  // once the model has already made 2 webfetch calls since the last user turn, drop
  // webfetch from the tools list so it's no longer callable for the rest of this turn.
  const tools = capWebFetchAfterLimit(messages, body.tools, 2);

  const stream = body.stream === true;
  const lastUserText = extractLastUserText(body.messages);

  const lastUserContent = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  const hasRawPdfPart = Array.isArray(lastUserContent) && lastUserContent.some((b) => {
    if (!b || typeof b !== 'object') return false;
    return (b as { type?: string }).type === 'file';
  });
  const toolNames = (body.tools ?? []).map((t: ChatToolDefinition) => t.function?.name).filter(Boolean).join(',');
  const attInfo = normalizeAttachmentBlocks(lastUserContent)
    .map((a) => `${a.mime}@${a.url.startsWith('data:') ? 'data' : a.url.split(':')[0]}`)
    .join(',');
  console.log(`[tiermux][DBG] completion-request: model=${body.model ?? '-'} stream=${stream} msgs=${messages.length} tools=[${toolNames}] att=[${attInfo}] forcedKind=${forcedTaskKindForRun ?? '-'}`);

  const routeOpts: RouteOptions = {
    ...mapProfile(body.model, lastUserText, lastUserContent),
    tools,
    tool_choice: body.tool_choice,
    parallel_tool_calls: body.parallel_tool_calls,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    top_p: body.top_p,
    reasoningEffort: forcedReasoningEffortForRun ?? body.reasoning_effort ?? body.reasoning?.effort,

    requireTools: !!(body.tools && body.tools.length),
    hasRawPdfPart,
    onFailover: (info) => routeFailoverListenerForRun?.(`${info.from.platform}::${info.from.modelId}`, info.reason),
    onSelectionRationale: (info) => routeRationaleListenerForRun?.({
      taskKind: info.taskKind,
      picked: info.picked ? `${info.picked.platform}::${info.picked.modelId}` : undefined,
      entries: info.rationale.map((r) => ({
        model: `${r.platform}::${r.modelId}`,
        selected: r.selected,
        score: r.score,
        capability: r.capability,
        runtime: r.runtimeMultiplier,
        preference: r.userPreference,
        confidence: r.confidence,
        reason: r.reason,
        skip: r.skip,
      })),
    }),
  };

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const chunks: string[] = [];
    routeOpts.onChunk = (delta) => {
      chunks.push(delta);
      sendSSE(res, makeChunk(body.model ?? 'tiermux', { content: delta }));
    };

    try {
      const result = await router.route(messages, routeOpts);
      lastRouted = { platform: result.platform, model: result.model, runtimeName: result.runtimeName };
      const choice = result.response.choices?.[0];
      const msg = choice?.message;

      // If the upstream provider didn't stream (onChunk never fired), emit its
      // non-streamed content/tool_calls now so OC sees them. Tool calls (including
      // OC's native webfetch/websearch) pass straight through to OC — OC executes
      // them in its own agent loop and sends the next request.
      if (!chunks.length) {
        const content = typeof msg?.content === 'string' ? msg.content : '';
        if (content || msg?.tool_calls?.length) {
          sendSSE(res, makeChunk(body.model ?? 'tiermux', {
            ...(content ? { content } : {}),
            ...(msg?.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
          }));
        }
      }

      const hasTools = !!msg?.tool_calls?.length;
      const upstreamReason = choice?.finish_reason;
      const finishReason: string = hasTools
        ? 'tool_calls'
        : (upstreamReason && upstreamReason !== 'tool_calls' ? upstreamReason : 'stop');
      const usage = result.response.usage;
      sendSSE(res, makeChunk(body.model ?? 'tiermux', { content: '' }, finishReason, result.response.model, usage));
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      // Headers were already sent by writeHead(200) above (streaming started), so an HTTP
      // error status can't be set now — emit the failure as an SSE error event and close the
      // stream cleanly. The old guard keyed off `buffered`: when route() threw BEFORE any chunk
      // streamed (e.g. AllModelsFailedError), buffered was empty and the code called
      // res.writeHead() a second time, throwing "Cannot write headers after they are sent to the
      // client" — which crashed the request and surfaced to the user as an empty answer.
      if (res.headersSent) {
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
 * Deterministically enforces the "at most N webfetch calls per turn" budget from
 * ocConfig.ts's system prompt, which the model can't be trusted to obey on its own.
 * Counts webfetch tool_calls in the messages since the last user turn; once that
 * count reaches `limit`, strips the webfetch definition from the tools list sent
 * upstream so the model has no way to call it again until the next user turn.
 */
function capWebFetchAfterLimit(
  messages: ChatMessage[],
  tools: ChatToolDefinition[] | undefined,
  limit: number,
): ChatToolDefinition[] | undefined {
  if (!tools?.some((t) => t.function?.name === 'webfetch')) return tools;

  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') break;
    for (const call of messages[i].tool_calls ?? []) {
      if (call.function?.name === 'webfetch') count++;
    }
  }
  if (count < limit) return tools;
  return tools.filter((t) => t.function?.name !== 'webfetch');
}

/**
 * Map an OC-requested model id onto Router routing knobs.
 * - Virtual profiles (tiermux/fast|smart|auto) select a routing profile.
 * - Real ids (platform::modelId) are passed through to pin a specific model.
 */
function mapProfile(model: string | undefined, lastUserText?: string, lastUserContent?: ChatMessage['content']): { model?: string; taskKind?: TaskKind } {

  const bare = (p: string) => p.replace(/^tiermux\//, '');

  const decode = (p: string) => p.startsWith('tm_') ? Buffer.from(p.slice(3), 'base64url').toString('utf8') : p;

  const forced = getForcedModel();
  if (forced && forced.trim()) return { model: decode(bare(forced)) };
  const id = decode(bare(model ?? PROFILE_AUTO));
  if (id === bare(PROFILE_AUTO)) {
    return { model: 'auto' };
  }
  if (id === bare(PROFILE_FAST)) {

    const classified: TaskKind = lastUserText
      ? classifyTask(lastUserText, { attachmentKinds: attachmentKindsFromContent(lastUserContent ?? '') })
      : 'chat';
    return { model: 'auto', taskKind: forcedTaskKindForRun ?? classified };
  }
  if (id === bare(PROFILE_SMART)) {

    const classified: TaskKind = lastUserText
      ? classifyTask(lastUserText, { attachmentKinds: attachmentKindsFromContent(lastUserContent ?? '') })
      : 'agent';
    return { model: 'auto', taskKind: forcedTaskKindForRun ?? classified };
  }

  return { model: id };
}

/** A payload a provider can actually consume — a `data:` URI (decoded locally) or an
 *  http(s) URL (fetched). OC sometimes re-serializes a FilePart with its own rewritten
 *  URL (a local path / file://), which providers silently drop. */
function isUsableAttachmentUrl(url: string): boolean {
  return /^(data:|https?:\/\/)/i.test(url);
}

/**
 * Splices the run's real attachment blocks (see setForcedAttachments — the whole
 * session's, not just this turn's) into the last user message. OC's re-serialization
 * of history doesn't reliably carry image/file blocks through (it may omit them, or
 * forward them with a rewritten non-data URL no provider can fetch), so: keep any
 * usable attachment OC did forward, strip unusable ones, and append every forced
 * block whose payload URL isn't already present. Only touches the LAST user message
 * so the same attachment isn't re-injected into every earlier turn on each hop.
 */
function reinjectMissingAttachments(messages: ChatMessage[], blocks: ChatContentBlock[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    const existing = messages[i].content;
    const presentUrls = new Set(
      normalizeAttachmentBlocks(existing).filter((a) => isUsableAttachmentUrl(a.url)).map((a) => a.url),
    );
    const missing = blocks.filter((b) => {
      const [norm] = normalizeAttachmentBlocks([b]);
      return norm && !presentUrls.has(norm.url);
    });
    if (missing.length === 0) return;
    const kept: ChatContentBlock[] = typeof existing === 'string'
      ? (existing ? [{ type: 'text', text: existing }] : [])
      : (existing ?? []).filter((b) => {
        if (!b || typeof b !== 'object') return true;
        const type = (b as { type?: string }).type;
        if (type !== 'image_url' && type !== 'file') return true;
        const [norm] = normalizeAttachmentBlocks([b as ChatContentBlock]);
        return !!norm && isUsableAttachmentUrl(norm.url); // drop OC-rewritten unusable blocks
      });
    messages[i].content = [...kept, ...missing];
    console.log(`[tiermux][DBG] reinjected ${missing.length}/${blocks.length} session attachment block(s) into last user message`);
    return;
  }
}

function toTierMuxMessage(raw: unknown): ChatMessage {
  const m = raw as Record<string, unknown>;
  const role = (m.role as ChatMessage['role']) ?? 'user';
  let content = m.content as ChatMessage['content'];
  if (Array.isArray(content)) {

    content = content
      .map((part) => {
        if (typeof part === 'string') return part;
        const p = part as { type?: string; text?: string };
        if (p.type === 'text' || (p.text !== undefined && p.type === undefined)) return p.text ?? '';

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

function makeChunk(
  model: string,
  delta: { content?: string; tool_calls?: ChatMessage['tool_calls'] },
  finish_reason: string | null = null,
  routedModel?: string,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; reasoning_tokens?: number },
) {
  return {
    id: `chatcmpl-tiermux-${Math.random().toString(36).slice(2)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),

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

  if (err instanceof AllModelsFailedError) return 503;

  if (err instanceof NoVisionModelError) return 422;
  return 500;
}
