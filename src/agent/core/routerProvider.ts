// The AI SDK seam: a LanguageModelV4 over the picker. Owns the candidate loop, API-key lookup,
// V4-part ↔ OpenAI-wire translation, and two failover rules reported to the picker's cooldown:
// availability (429/5xx/401/network/timeout) and quality (nothing usable came back).

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
  LanguageModelV4StreamPart,
  LanguageModelV4FunctionTool,
  LanguageModelV4FilePart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import type { ChatMessage, ChatToolChoice, ChatToolDefinition, ReasoningEffort, Platform } from '../../shared/types';
import { resolveProvider } from '../../providers';
import { ProviderHttpError } from '../../providers/base';
import { selectModel, setModelSources, getApiKeysFor, recordOutcome, recordRequest, noteModelFailure, rationaleForServed, type ModelSources, type SelectionRationale } from '../../router/picker';
import { ThinkStripper, stripThinkTags, reasoningFromDelta } from '../../util/thinkTags';
import { diagLog } from '../../util/diag';

/** Post-headers STALL bound: a stream that has produced no chunk at all is abandoned after this
 *  (headers then no body — no header timeout can fire). Tracks FAILOVER_CONNECT_TIMEOUT_MS; the
 *  old 8s hedge made the 60s tolerance unreachable (kilo, 10.4s to headers). 0 for pinned
 *  models and custom/local endpoints, whose cold load may run minutes. */
function ttftGateMsFor(platform: Platform, pinned: boolean): number {
  if (pinned || platform === 'custom') return 0;
  return FAILOVER_CONNECT_TIMEOUT_MS;
}

export { setModelSources };
export type { ModelSources };

export interface RouterProviderOptions {
  effort?: ReasoningEffort;
  taskKind?: string;
  pinnedModel?: string;
  sessionId?: string;
  excludeModels?: string[];
  /** The caller offers tools — selection must skip catalog models marked supportsTools=false
   *  (they cannot call anything and deflect instead). */
  requireTools?: boolean;
  onFailover?: (from: string, reason: string) => void;
  onModelSelected?: (platform: string, model: string, runtimeName?: string) => void;
  onUsage?: (info: { inputTokens: number; outputTokens: number; model: string }) => void;
  /** "Why this model?" report from selection — forwarded to the host so the footer's
   *  (?)/⇄ button has data (v3 selection never produced one; the old scoring Router did). */
  onSelectionRationale?: (info: import('../../router/picker').SelectionRationale) => void;
}

/** Retryable candidate failure: rate limit, auth, quota/credit (402/403 — free gateways
 *  answer "out of credit" that way), server error, network abort/timeout, 400/413 ("context
 *  length exceeded" is per-model; the next model can succeed) and 404 (the model is gone from
 *  this provider). 401 counts so the key loop can rotate a single dead key first. */
export function isFailoverWorthy(e: unknown): boolean {
  if (e instanceof ProviderHttpError) {
    return e.status === 400 || e.status === 401 || e.status === 402 || e.status === 403
      || e.status === 404 || e.status === 408 || e.status === 413 || e.status === 429
      || (e.status !== undefined && e.status >= 500);
  }
  return e instanceof Error && /network|fetch failed|timed out|ECONN/i.test(e.message);
}

/** Per-candidate ceiling on TIME TO HEADERS while failing over — never on generation length; the
 *  registry's single-shot timeouts would let one dead provider hold a turn. 25s → 60s on
 *  2026-09-04 (65k prefill on poolside/laguna-s-2.1). Not applied to custom/local endpoints. */
const FAILOVER_CONNECT_TIMEOUT_MS = 60_000;

/** Stop STARTING new candidates once the chain has burned this long. Never interrupts a
 *  candidate already streaming — it only declines to open another one. Bounds the pathological
 *  case (every candidate unresponsive) at roughly this plus one connect timeout, instead of
 *  candidates × timeout. */
const CHAIN_DEADLINE_MS = 120_000;

/** Every way an OpenAI-compatible provider spells "ran out of output budget". Only the exact
 *  string 'length' used to map to the SDK's finishReason 'length', so a truncated reply from
 *  any other spelling shipped as 'stop' — complete-looking, no continuation (2026-08-31,
 *  Opencode / Kilo / OrcaRouter). google.ts normalizes its own MAX_TOKENS. */
const TRUNCATION_FINISH_REASONS = new Set([
  'length',              // OpenAI, Mistral, llama.cpp, most compat servers
  'max_tokens',          // Anthropic-style, and aggregators that proxy it verbatim
  'max_output_tokens',
  'model_length',
  'token_limit',
  'length_limit',
  'output_limit',
]);

/** True when the provider says the reply was cut at its output budget, whatever it calls it.
 *  Anything unrecognized is traced, because that is precisely the case that maps to 'stop' and
 *  silently skips the continuation — the set above can only grow from spellings we've seen. */
function isTruncationFinish(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const norm = raw.trim().toLowerCase();
  if (TRUNCATION_FINISH_REASONS.has(norm)) return true;
  if (norm !== 'stop' && norm !== 'tool_calls' && norm !== 'function_call' && norm !== 'content_filter') {
    diagLog('routerProvider.finishReason', `unrecognized finish_reason "${raw}" — treated as 'stop'`);
  }
  return false;
}

/** The connect cap for one candidate, or undefined to leave the provider's own timeout alone
 *  (custom/local endpoints, which declare no timeout on purpose). */
function connectTimeoutFor(platform: Platform): number | undefined {
  return platform === 'custom' ? undefined : FAILOVER_CONNECT_TIMEOUT_MS;
}

/** 401/402/403 are ACCOUNT-level (dead key, unpaid bill), so the platform's other models cannot
 *  succeed either (ollama/cerebras 402, 2026-08-30). 429 and 5xx are per-model and not here. */
/** The turn-killing error, naming every candidate and its outcome so failover is visible — a
 *  bare "Cerebras API error 402" read as no failover (2026-08-30). */
function chainExhaustedError(
  candidates: Candidate[],
  attempts: string[],
  lastError: unknown,
): Error {
  if (candidates.length <= 1) {
    return lastError instanceof Error
      ? lastError
      : new Error('TierMux: the only model candidate failed');
  }
  const detail = attempts.length ? ` — ${attempts.join('; ')}` : '';
  return new Error(`TierMux: all ${candidates.length} model candidates failed${detail}`);
}

function isAccountLevel(e: unknown): boolean {
  return e instanceof ProviderHttpError
    && (e.status === 401 || e.status === 402 || e.status === 403);
}

function toV4Usage(promptTokens?: number, completionTokens?: number): LanguageModelV4Usage {
  return {
    inputTokens: { total: promptTokens, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: completionTokens, text: undefined, reasoning: undefined },
  };
}

/** Splits a streamed content/reasoning pair into chat text + reasoning. Some gateways send the
 *  SAME thinking as a native reasoning field AND as `<think>` markup in content: the first
 *  channel to produce output wins and the other is suppressed for the stream. Exported for e2e. */
export function createStreamTextSplitter() {
  const think = new ThinkStripper();
  let source: 'native' | 'think' | null = null;
  return {
    feed(contentDelta: string | undefined, nativeReasoning: string): { text: string; reasoning: string } {
      const out = { text: '', reasoning: '' };
      if (nativeReasoning) {
        if (source === null) source = 'native';
        if (source === 'native') out.reasoning += nativeReasoning;
      }
      const parts = think.feedParts(contentDelta ?? '');
      if (parts.reasoning) {
        if (source === null) source = 'think';
        if (source === 'think') out.reasoning += parts.reasoning;
      }
      out.text = parts.text;
      return out;
    },
    flush(): { text: string; reasoning: string } {
      const f = think.flushParts();
      return { text: f.text, reasoning: source === 'think' ? f.reasoning : '' };
    },
  };
}

function filePartToDataUrl(part: LanguageModelV4FilePart): string | undefined {
  const mediaType = part.mediaType || 'application/octet-stream';
  const d = part.data as { type?: string; data?: unknown; url?: unknown } | undefined;
  if (!d || typeof d !== 'object') return undefined;
  if (d.type === 'data') {
    if (typeof d.data === 'string') {
      return d.data.startsWith('data:') ? d.data : `data:${mediaType};base64,${d.data}`;
    }
    if (d.data instanceof Uint8Array) {
      return `data:${mediaType};base64,${Buffer.from(d.data).toString('base64')}`;
    }
  } else if (d.type === 'url' && d.url != null) {
    return String(d.url);
  }
  return undefined;
}

/** Flatten the SDK's tool-result output union to the plain text the OpenAI wire expects.
 *  Shipping the `{"type":"text","value":…}` envelope made models read JSON soup as their
 *  observation and return empty synthesis steps (gpt-oss-120b, nemotron-3-ultra-free). */
function toolResultToText(output: unknown): string {
  if (output && typeof output === 'object') {
    const o = output as { type?: string; value?: unknown; reason?: string };
    if (o.type === 'execution-denied') return o.reason ? `Tool execution denied by the user: ${o.reason}` : 'Tool execution denied by the user.';
    if (typeof o.value === 'string') return o.value; // 'text' | 'error-text'
    if (o.value !== undefined) return JSON.stringify(o.value); // 'json' | 'error-json'
  }
  return typeof output === 'string' ? output : JSON.stringify(output ?? '');
}

function toRouterMessages(prompt: LanguageModelV4CallOptions['prompt']): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (const msg of prompt) {
    if (msg.role === 'system') {
      msgs.push({ role: 'system', content: msg.content });
    } else if (msg.role === 'user') {
      const text = msg.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('');
      const fileParts = msg.content.filter((p): p is LanguageModelV4FilePart => p.type === 'file');
      if (fileParts.length === 0) {
        msgs.push({ role: 'user', content: text || '' });
      } else {
        const blocks: Array<{ type: string; [key: string]: unknown }> = [];
        if (text) blocks.push({ type: 'text', text });
        for (const p of fileParts) {
          const url = filePartToDataUrl(p);
          if (!url) continue;
          const mime = p.mediaType || 'application/octet-stream';
          if (mime.startsWith('image/')) {
            blocks.push({ type: 'image_url', image_url: { url, mime, filename: p.filename } });
          } else {
            blocks.push({ type: 'file', file: { filename: p.filename, file_data: url, mime } });
          }
        }
        msgs.push({ role: 'user', content: blocks.length ? blocks : (text || '') });
      }
    } else if (msg.role === 'assistant') {
      const textParts = msg.content.filter((p): p is { type: 'text'; text: string } => p.type === 'text');
      const toolParts = msg.content.filter((p): p is { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown } => p.type === 'tool-call');
      msgs.push({
        role: 'assistant',
        content: textParts.map((p) => p.text).join('') || null,
        tool_calls: toolParts.length > 0
          ? toolParts.map((p) => ({ id: p.toolCallId, type: 'function' as const, function: { name: p.toolName, arguments: JSON.stringify(p.input) } }))
          : undefined,
      });
    } else if (msg.role === 'tool') {
      for (const part of msg.content) {
        if (part.type === 'tool-result') {
          msgs.push({ role: 'tool', content: toolResultToText(part.output), tool_call_id: part.toolCallId });
        }
      }
    }
  }
  return msgs;
}

function toRouterTools(tools?: LanguageModelV4CallOptions['tools']): ChatToolDefinition[] | undefined {
  if (!tools?.length) return undefined;
  return tools
    .filter((t): t is LanguageModelV4FunctionTool => t.type === 'function')
    .map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.inputSchema as Record<string, unknown> } }));
}

/** `toolChoice` → the wire's `tool_choice`. Until 2026-09-01 nothing populated it, so every
 *  toolChoice the engine set was dropped and the plan-gap "forced" step was never forced. */
export function toRouterToolChoice(choice?: LanguageModelV4CallOptions['toolChoice']): ChatToolChoice | undefined {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto': return 'auto';
    case 'none': return 'none';
    case 'required': return 'required';
    case 'tool': return { type: 'function', function: { name: choice.toolName } };
    default: return undefined;
  }
}

interface Candidate {
  platform: Platform;
  modelId: string;
  /** Every stored key for the platform ([''] when keyless) — tried in order within the
   *  candidate before the candidate itself is abandoned. */
  apiKeys: string[];
}

/** Resolve the candidate chain (first choice + fallbacks) into live provider instances.
 *  Keyed platforms with no stored key are SKIPPED — an unauthenticated request is a
 *  guaranteed 401, so selection falls through to a platform the user can actually use. */
export async function resolveCandidates(
  opts: RouterProviderOptions,
  /** Out-param: receives the selection report so the caller can re-point it at whichever
   *  candidate actually served (see `rationaleForServed`). Optional — the e2e gates call
   *  this for the chain alone and have no popover to feed. */
  out?: { rationale?: SelectionRationale },
): Promise<Candidate[]> {
  const selectT0 = Date.now();
  const selection = await selectModel([], {
    pinnedModel: opts.pinnedModel,
    excludeModels: opts.excludeModels,
    taskKind: opts.taskKind,
    sessionId: opts.sessionId,
    requireTools: opts.requireTools,
  });
  // Emitted up front so the popover still has data when every candidate fails. It names
  // chain[0] — only correct when chain[0] actually serves, which is why the caller re-emits
  // through `rationaleForServed` as soon as a candidate succeeds.
  if (selection.rationale) opts.onSelectionRationale?.(selection.rationale);
  if (out) out.rationale = selection.rationale;

  // A bounded chain needs PLATFORM DIVERSITY: ollama alone ships five rank-1 models, and one
  // provider-wide 402 burned a single-platform chain (2026-08-30). MAX_PER_PLATFORM first, then
  // top up from the overflow. Never rotate the platform order here — that made the rationale
  // popover name a model that never ran (removed 413ecb5).
  const MAX_CANDIDATES = 20;
  /** Cap on how deep one platform's bucket goes — only reachable when few platforms are
   *  usable, which is exactly when repeating a platform is the best option left. */
  const MAX_PER_PLATFORM = MAX_CANDIDATES;
  /** Chain entries examined before giving up the scan. The picker's tail is every enabled
   *  model, which can run to hundreds; the buckets need only enough to fill the rounds. */
  const MAX_SCAN = 200;

  // Memoized so one secret lookup per platform covers every model of that platform.
  const keyCache = new Map<string, string[]>();
  const keysFor = async (platform: string): Promise<string[]> => {
    let keys = keyCache.get(platform);
    if (!keys) { keys = await getApiKeysFor(platform); keyCache.set(platform, keys); }
    return keys;
  };

  const buckets = new Map<string, Candidate[]>();
  const platformOrder: string[] = [];
  let scanned = 0;
  for (const key of [selection.model, ...selection.fallbackChain]) {
    if (scanned++ >= MAX_SCAN) break;
    const [platform, ...rest] = key.split('::');
    const modelId = rest.join('::');
    if (!modelId || modelId === 'auto') continue;
    if (!resolveProvider(platform as Platform, modelId)) continue;
    const apiKeys = await keysFor(platform);
    if (apiKeys.length === 0) continue;
    let bucket = buckets.get(platform);
    if (!bucket) { bucket = []; buckets.set(platform, bucket); platformOrder.push(platform); }
    if (bucket.length < MAX_PER_PLATFORM) {
      bucket.push({ platform: platform as Platform, modelId, apiKeys });
    }
  }

  // Interleave: round 0 is every platform's first choice (in the picker's platform order),
  // round 1 every platform's second, and so on until the bound.
  const chain: Candidate[] = [];
  for (let round = 0; chain.length < MAX_CANDIDATES; round++) {
    let addedThisRound = false;
    for (const platform of platformOrder) {
      const bucket = buckets.get(platform)!;
      if (round >= bucket.length) continue;
      chain.push(bucket[round]);
      addedThisRound = true;
      if (chain.length >= MAX_CANDIDATES) break;
    }
    if (!addedThisRound) break; // every bucket is spent
  }

  // The resolved chain answers "was there anything to fail over TO?"; the elapsed is the real
  // routing cost (selection + key lookups + interleave), not generation time.
  diagLog('rp.chain', `${Date.now() - selectT0}ms to resolve — `
    + (chain.length
      ? `${platformOrder.length} platform(s): ${chain.map((c) => `${c.platform}::${c.modelId}`).join(' \u2192 ')}`
      : '<empty \u2014 no usable candidate>'));
  // A pinned model runs ALONE (2026-08-31, user direction): a pin with no runnable candidate
  // fails the turn with its reason instead of falling back. 'auto' means "no pin".
  if (chain.length === 0 && opts.pinnedModel && opts.pinnedModel !== 'auto'
    && !opts.excludeModels?.includes(opts.pinnedModel)) {
    const skipEntry = selection.rationale?.entries.find((e) => e.model === opts.pinnedModel);
    const why = skipEntry?.skip ?? 'no usable provider/key for it right now';
    throw new Error(`Pinned model ${opts.pinnedModel} could not run: ${why}.`);
  }
  return chain;
}

/** Wraps the picker as an AI-SDK LanguageModelV4 with bounded failover. */
export function createRouterProvider(providerOpts: RouterProviderOptions = {}): LanguageModelV4 {
  return createPickerProvider(providerOpts);
}

/** Degenerate stream end: reasoning present, NO text, NO tool calls. ONE continuation is
 *  warranted before folding the reasoning into the reply. Exported for e2e. */
export function needsFinalNudge(textStarted: boolean, toolCallCount: number, reasoning: string): boolean {
  return !textStarted && toolCallCount === 0 && reasoning.trim().length > 0;
}

/** Empty-final fold: no text, no tool calls, but reasoning ⇒ the reasoning IS the reply
 *  (gpt-oss/Groq shape). Last resort, after a nudge also came back empty. Exported for e2e. */
export function foldEmptyFinal(textStarted: boolean, toolCallCount: number, reasoning: string): string {
  if (!textStarted && toolCallCount === 0 && reasoning.trim()) return reasoning.trim();
  return '';
}

function createPickerProvider(providerOpts: RouterProviderOptions): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'tiermux',
    modelId: providerOpts.pinnedModel ?? `auto-${providerOpts.effort ?? 'medium'}`,
    supportedUrls: {},

    async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      const messages = toRouterMessages(options.prompt);
      const tools = toRouterTools(options.tools);
      const sel: { rationale?: SelectionRationale } = {};
      const candidates = await resolveCandidates(providerOpts, sel);
      /** Report the model that really served — and fix the rationale to name it, so the
       *  "Why this model?" popover can't credit a candidate that failed over. */
      const reportServed = (platform: string, modelId: string, runtimeName?: string): void => {
        providerOpts.onModelSelected?.(platform, modelId, runtimeName);
        if (sel.rationale) providerOpts.onSelectionRationale?.(rationaleForServed(sel.rationale, platform, modelId));
      };
      if (candidates.length === 0) throw new Error('TierMux: no model candidate resolved');

      let lastError: unknown;
      const deadPlatforms = new Set<string>();
      const attempts: string[] = [];
      const startedAt = Date.now();
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const provider = resolveProvider(c.platform, c.modelId);
        if (!provider) continue;
        if (Date.now() - startedAt > CHAIN_DEADLINE_MS) {
          attempts.push(`${c.platform}::${c.modelId} not started (chain deadline reached)`);
          break;
        }
        if (deadPlatforms.has(c.platform)) {
          attempts.push(`${c.platform}::${c.modelId} skipped (platform auth/billing already failed)`);
          continue;
        }
        let candidateError: unknown;
        // Try every stored key within the candidate (rotation on dead/quota'd keys) before
        // abandoning it for the next candidate.
        for (const apiKey of c.apiKeys) {
          try {
          const data = await provider.chatCompletion(apiKey, messages, c.modelId, {
            temperature: options.temperature,
            max_tokens: options.maxOutputTokens,
            tools,
            reasoningEffort: providerOpts.effort,
            abortSignal: options.abortSignal,
            timeoutMs: connectTimeoutFor(c.platform),
          });
          recordRequest(c.platform, c.modelId);
          reportServed(c.platform, c.modelId, provider.runtimeName);
          if (data.usage) {
            providerOpts.onUsage?.({ inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens, model: `${c.platform}::${c.modelId}` });
          }
          const msg = data.choices?.[0]?.message;
          const content: LanguageModelV4GenerateResult['content'] = [];
          if (msg?.content) {
            const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            const clean = stripThinkTags(raw);
            if (clean) content.push({ type: 'text', text: clean });
          }
          for (const tc of msg?.tool_calls ?? []) {
            content.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, input: tc.function.arguments ?? '{}', providerExecuted: false });
          }
          const hasCalls = !!msg?.tool_calls?.length;
          const rawFR = data.choices?.[0]?.finish_reason;
          // Quality failover: a generate that produced neither text nor a tool call is useless —
          // advance to the next candidate instead of returning an empty result.
          if (content.length === 0 && !hasCalls) {
            recordOutcome(c.platform, c.modelId, false);
            continue;
          }
          recordOutcome(c.platform, c.modelId, true);
          return {
            content,
            finishReason: { unified: hasCalls ? 'tool-calls' : (isTruncationFinish(rawFR) ? 'length' : 'stop'), raw: hasCalls ? 'tool_calls' : (rawFR ?? 'stop') },
            usage: toV4Usage(data.usage?.prompt_tokens, data.usage?.completion_tokens),
            warnings: [],
          };
          } catch (e) {
            lastError = e;
            candidateError = e;
            recordOutcome(c.platform, c.modelId, false);
            noteModelFailure(c.platform, c.modelId, e instanceof ProviderHttpError ? e.status : undefined, !!tools?.length);
            if (isFailoverWorthy(e)) {
              providerOpts.onFailover?.(`${c.platform}::${c.modelId}`, e instanceof Error ? e.message : String(e));
              continue; // next key; when keys run out, the candidate loop advances
            }
            throw e;
          }
        }
        if (candidateError) {
          attempts.push(`${c.platform}::${c.modelId} ${candidateError instanceof Error ? candidateError.message : String(candidateError)}`);
          if (isAccountLevel(candidateError)) deadPlatforms.add(c.platform);
        }
      }
      throw chainExhaustedError(candidates, attempts, lastError);
    },

    async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
      const messages = toRouterMessages(options.prompt);
      const tools = toRouterTools(options.tools);
      const sel: { rationale?: SelectionRationale } = {};
      const candidates = await resolveCandidates(providerOpts, sel);
      /** Report the model that really served — and fix the rationale to name it, so the
       *  "Why this model?" popover can't credit a candidate that failed over. */
      const reportServed = (platform: string, modelId: string, runtimeName?: string): void => {
        providerOpts.onModelSelected?.(platform, modelId, runtimeName);
        if (sel.rationale) providerOpts.onSelectionRationale?.(rationaleForServed(sel.rationale, platform, modelId));
      };
      if (candidates.length === 0) throw new Error('TierMux: no model candidate resolved');
      // Wire visibility: on a tool step the LAST message is the observation the model must
      // read — if it ever renders as JSON-envelope soup again, this line shows it instantly.
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'tool') {
        diagLog('rp.toolResult', `msgs=${messages.length} head="${String(lastMsg.content).slice(0, 140).replace(/\n/g, '⏎')}"`);
      }

      let controller!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
      const stream = new ReadableStream<LanguageModelV4StreamPart>({ start(c) { controller = c; } });
      controller.enqueue({ type: 'stream-start', warnings: [] });

      void (async () => {
        let lastError: unknown;
        // Platforms that answered 401/402/403 — their remaining models are skipped, and the
        // attempt log below reports WHY so an exhausted chain is legible instead of surfacing
        // one provider's raw error as if no failover had run.
        const deadPlatforms = new Set<string>();
        const attempts: string[] = [];
        const startedAt = Date.now();
        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i];
          const provider = resolveProvider(c.platform, c.modelId);
          if (!provider) continue;
          if (Date.now() - startedAt > CHAIN_DEADLINE_MS) {
            attempts.push(`${c.platform}::${c.modelId} not started (chain deadline reached)`);
            break;
          }
          if (deadPlatforms.has(c.platform)) {
            attempts.push(`${c.platform}::${c.modelId} skipped (platform auth/billing already failed)`);
            continue;
          }
          let candidateError: unknown;
          // Every stored key gets a turn within the candidate before it is abandoned — a
          // dead or quota'd key must not cost the whole platform.
          for (const apiKey of c.apiKeys) {
          try {
            const textId = 'text-0';
            let textStarted = false;
            const reasoningId = 'reasoning-0';
            let reasoningStarted = false;
            // Everything the reasoning channel carried — feeds the nudge decision and the
            // last-resort fold below.
            let reasoningAccum = '';
            // Accumulated tool calls, merged by index across chunks (OpenAI wire behavior).
            const acc = new Map<number, { id: string; name: string; args: string }>();
            let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
            let finish: string | null = null;
            // ONE mechanical continuation: a stream that ends with reasoning but no text
            // and no tool calls gets a "final answer now" nudge before anything is folded.
            let nudged = false;

            while (true) {
              // Fresh splitter per attempt — attempt 1 was fully flushed before the nudge.
              const splitter = createStreamTextSplitter();
              const attemptMessages = nudged
                ? [...messages, { role: 'user' as const, content: 'You produced reasoning but no final answer and called no tool. Reply now with your final answer to the user — concise, no meta-commentary, no tool calls.' }]
                : messages;

              // Stall failover: headers arrived, then no chunk at all within ttftGateMsFor ⇒
              // abandon this candidate. Any first chunk clears the timer; never a cap on length.
              const ttftMs = ttftGateMsFor(c.platform, !!providerOpts.pinnedModel);
              const ttftController = new AbortController();
              const ttftTimer = ttftMs > 0
                ? setTimeout(() => {
                    ttftController.abort(new ProviderHttpError(
                      `${provider.name} produced no first token within ${ttftMs}ms — failing over`, 408));
                  }, ttftMs)
                : undefined;
              // The SDK's own abort (Stop button / sub-agent timeout) must still kill the
              // request — combine both signals rather than replacing the caller's.
              const ttftSignal = options.abortSignal
                ? AbortSignal.any([options.abortSignal, ttftController.signal])
                : ttftController.signal;

              // Time-to-first-chunk is NOT measured here any more (2026-09-05). It existed to
              // feed a learned slow-model demotion in the picker; that is gone, and the engine
              // already logs the same number for diagnostics (engine.ttft, off turn start).
              try {
                for await (const chunk of provider.streamChatCompletion(apiKey, attemptMessages, c.modelId, {
                  temperature: options.temperature,
                  max_tokens: options.maxOutputTokens,
                  tools,
                  reasoningEffort: providerOpts.effort,
                  abortSignal: ttftSignal,
                  timeoutMs: connectTimeoutFor(c.platform),
                })) {
                  if (ttftTimer) clearTimeout(ttftTimer);
                  if (chunk.usage) usage = chunk.usage;
                  const choice = chunk.choices?.[0];
                  if (!choice) continue;
                  if (choice.finish_reason) finish = choice.finish_reason;
                  const delta = choice.delta ?? {};
                  // Thinking arrives as native reasoning fields or `<think>` markup in content;
                  // the splitter routes both to the reasoning channel without doubling.
                  const split = splitter.feed(delta.content, reasoningFromDelta(delta as unknown as Record<string, unknown>));
                  if (split.reasoning) {
                    reasoningAccum += split.reasoning;
                    if (!reasoningStarted) { reasoningStarted = true; controller.enqueue({ type: 'reasoning-start', id: reasoningId }); }
                    controller.enqueue({ type: 'reasoning-delta', id: reasoningId, delta: split.reasoning });
                  }
                  if (split.text) {
                    if (!textStarted) { textStarted = true; controller.enqueue({ type: 'text-start', id: textId }); }
                    controller.enqueue({ type: 'text-delta', id: textId, delta: split.text });
                  }
                  for (const tc of delta.tool_calls ?? []) {
                    const idx = tc.index ?? 0;
                    const slot = acc.get(idx) ?? { id: tc.id ?? `call-${idx}`, name: '', args: '' };
                    if (tc.id) slot.id = tc.id;
                    if (tc.function?.name) slot.name += tc.function.name;
                    if (tc.function?.arguments) slot.args += tc.function.arguments;
                    acc.set(idx, slot);
                  }
                }
              } finally {
                // ALWAYS clear, including the throw-before-first-chunk path. A candidate
                // that fails to connect (the common 429/5xx) skipped the old post-loop
                // clear entirely, leaving an armed timer for the whole gate window that
                // later fired into an AbortController nobody was listening to any more.
                if (ttftTimer) clearTimeout(ttftTimer);
              }

              const flushed = splitter.flush();
              if (flushed.reasoning) {
                reasoningAccum += flushed.reasoning;
                if (!reasoningStarted) { reasoningStarted = true; controller.enqueue({ type: 'reasoning-start', id: reasoningId }); }
                controller.enqueue({ type: 'reasoning-delta', id: reasoningId, delta: flushed.reasoning });
              }
              if (flushed.text) {
                if (!textStarted) { textStarted = true; controller.enqueue({ type: 'text-start', id: textId }); }
                controller.enqueue({ type: 'text-delta', id: textId, delta: flushed.text });
              }

              // Degenerate end → ONE "final answer now" nudge, then give up on nudging.
              if (needsFinalNudge(textStarted, acc.size, reasoningAccum) && !nudged) {
                nudged = true;
                continue;
              }
              break;
            }

            // Empty-final fold — see foldEmptyFinal. LAST RESORT for a candidate that already
            // streamed reasoning: promote whatever the reasoning channel carried rather than
            // switch mid-stream (that would corrupt the output with a half-shown model).
            const folded = foldEmptyFinal(textStarted, acc.size, reasoningAccum);
            if (folded) {
              textStarted = true;
              controller.enqueue({ type: 'text-start', id: textId });
              controller.enqueue({ type: 'text-delta', id: textId, delta: folded });
            }
            const hasOutput = textStarted || acc.size > 0;
            if (!hasOutput) {
              // Truly silent candidate (no text, no tools, and no foldable reasoning): treat as
              // a quality failure and fail over to the next candidate instead of ending the turn
              // empty. Only safe when nothing was already streamed to the user — if this candidate
              // showed reasoning, the nudge/fold above keeps the turn alive instead of switching.
              if (!reasoningStarted && acc.size === 0) {
                recordOutcome(c.platform, c.modelId, false);
                continue; // → Model B / C / D
              }
            }

            recordRequest(c.platform, c.modelId);
          reportServed(c.platform, c.modelId, provider.runtimeName);
            // A FOLDED turn (reasoning only, no content, no tool call) is not a success: reporting
            // it healthy kept Auto re-picking nemotron-3-ultra-free every turn (×3, 2026-08-28).
            // The answer still ships; the cooldown steers the NEXT turn elsewhere.
            recordOutcome(c.platform, c.modelId, !folded);
            if (usage) {
              providerOpts.onUsage?.({ inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0, model: `${c.platform}::${c.modelId}` });
            }
            if (reasoningStarted) controller.enqueue({ type: 'reasoning-end', id: reasoningId });
            if (textStarted) controller.enqueue({ type: 'text-end', id: textId });
            const hasCalls = acc.size > 0;
            for (const [idx, tc] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
              controller.enqueue({ type: 'tool-input-start', id: tc.id, toolName: tc.name });
              controller.enqueue({ type: 'tool-input-delta', id: tc.id, delta: tc.args });
              controller.enqueue({ type: 'tool-input-end', id: tc.id });
              controller.enqueue({ type: 'tool-call', toolCallId: tc.id, toolName: tc.name, input: tc.args });
              void idx;
            }
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: hasCalls ? 'tool-calls' : (isTruncationFinish(finish) ? 'length' : 'stop'), raw: hasCalls ? 'tool_calls' : (finish ?? 'stop') },
              usage: toV4Usage(usage?.prompt_tokens, usage?.completion_tokens),
            });
            controller.close();
            return;
          } catch (e) {
            lastError = e;
            candidateError = e;
            recordOutcome(c.platform, c.modelId, false);
            noteModelFailure(c.platform, c.modelId, e instanceof ProviderHttpError ? e.status : undefined, !!tools?.length);
            if (isFailoverWorthy(e)) {
              providerOpts.onFailover?.(`${c.platform}::${c.modelId}`, e instanceof Error ? e.message : String(e));
              continue; // next key; when keys run out, the candidate loop advances
            }
            controller.error(e);
            return;
          }
          }
          // Every key for this candidate is spent. An account-level refusal condemns the whole
          // platform, not just this model.
          if (candidateError) {
            attempts.push(`${c.platform}::${c.modelId} ${candidateError instanceof Error ? candidateError.message : String(candidateError)}`);
            if (isAccountLevel(candidateError)) deadPlatforms.add(c.platform);
          }
        }
        controller.error(chainExhaustedError(candidates, attempts, lastError));
      })();

      return { stream };
    },
  };
}
