// The AI SDK seam: a LanguageModelV4 over the picker. Owns the candidate loop (model +
// fallbackChain), API-key lookup, translation between the V4 part protocol and the OpenAI wire
// the providers speak, and two failover rules, both reported to the picker's cooldown via
// recordOutcome: (1) availability — 429/5xx/401/network/timeout → next candidate; (2) quality —
// nothing usable (no text, no tool call, no foldable reasoning) → next candidate.

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
import { selectModel, setModelSources, getApiKeysFor, recordOutcome, recordRequest, rationaleForServed, type ModelSources, type SelectionRationale } from '../../router/picker';
import { ThinkStripper, stripThinkTags, reasoningFromDelta } from '../../util/thinkTags';
import { diagLog } from '../../util/diag';

/** Post-headers STALL bound: how long a stream that has produced no chunk at all may hang
 *  before the candidate is abandoned — a provider that answers with headers and then never
 *  sends a body, which no header timeout can fire on. Tracks FAILOVER_CONNECT_TIMEOUT_MS
 *  rather than the old 8s hedge trigger, which fired before any header timeout could and made
 *  the 60s tolerance unreachable (kilo, 10.4s to headers + keepalives).
 *
 *  Disabled (0) for pinned models (nothing to fail over to) and custom/local endpoints, whose
 *  cold load may legally run minutes — the Stop button is the brake there, as elsewhere. */
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

/** Retryable candidate failure: rate limit, auth failure, quota/credit exhaustion, server
 *  error, or network-level abort/timeout. 401 counts: with multiple stored keys it may be ONE
 *  dead key, so the key loop inside each candidate gets a chance to rotate before the
 *  candidate is abandoned. 402/403 count too — free gateways answer "out of credit" with 402
 *  (pollinations) and "$0 credit on a paid-only model" with 403 (new-api/TokenRouter), and
 *  those used to throw straight through the candidate loop: no rotation, instant dead turn
 *  (live repro: 1:18 AM turn, "auto rotate not works"). 400 counts: "context length
 *  exceeded" / model-specific schema rejections are per-model — the next model can succeed. */
export function isFailoverWorthy(e: unknown): boolean {
  if (e instanceof ProviderHttpError) {
    return e.status === 400 || e.status === 401 || e.status === 402 || e.status === 403
      || e.status === 408 || e.status === 429 || (e.status !== undefined && e.status >= 500);
  }
  return e instanceof Error && /network|fetch failed|timed out|ECONN/i.test(e.message);
}

/** Per-candidate ceiling on TIME TO RESPONSE HEADERS while failing over.
 *
 *  BaseProvider.fetchWithTimeout clears its timer in a `finally` the moment `fetch` resolves
 *  — i.e. as soon as the response headers land — so this bounds only how long a candidate may
 *  take to ANSWER, never how long its generation may run. A long stream is untouched.
 *
 *  It exists because the registry's declared timeouts are written for a single-shot call, not
 *  for a failover chain: eight platforms declare 600_000 (ten minutes) and the median is the
 *  same. One unresponsive provider could therefore hold a turn hostage for ten minutes before
 *  the chain even reached the next candidate, and widening the chain (above) would have
 *  multiplied that.
 *
 *  25s → 60s (2026-09-04, deliberate: slow-tolerant, zero new machinery): agent turns now carry
 *  65k+ token transcripts (live repro the same day: poolside/laguna-s-2.1 catalogued a workspace
 *  at 65.1k cumulative input), and a prefill that size on a slow provider can legitimately take
 *  longer than 25s BEFORE its first byte — the old cap aborted models that were about to answer
 *  and burned the chain on them. 60s matches the header-wait KeiRouter ships for the same reason.
 *  Long agent tasks (10–15 min) stay legal: this caps only time-to-HEADERS; once a stream starts,
 *  nothing in TierMux cuts it mid-flight.
 *
 *  NOT applied when the provider declares <= 0 (custom/local endpoints): a local model on the
 *  user's own hardware may legally take minutes to cold-load, and there is no failover pool
 *  that could serve it faster — see BaseProvider.fetchWithTimeout's own note. */
const FAILOVER_CONNECT_TIMEOUT_MS = 60_000;

/** Stop STARTING new candidates once the chain has burned this long. Never interrupts a
 *  candidate already streaming — it only declines to open another one. Bounds the pathological
 *  case (every candidate unresponsive) at roughly this plus one connect timeout, instead of
 *  candidates × timeout. */
const CHAIN_DEADLINE_MS = 120_000;

/** Wire-level truncation aliases from OpenAI-compatible providers.
 *
 *  engine.ts fires its ONE length-cut continuation on the SDK's unified `finishReason:
 *  'length'`, and the mappings below used to reach it only on the exact lowercase string
 *  `'length'`. Every other way a provider spells "I ran out of output budget" fell through to
 *  `'stop'`, so a TRUNCATED reply shipped as if the turn had completed — no continuation, plan
 *  left unfinished, and the user typing "continue" by hand (2026-08-31 repro, one task across
 *  Opencode / Kilo / OrcaRouter free tiers).
 *
 *  `google.ts` already normalizes its own MAX_TOKENS (toGeminiFinishReason); the generic
 *  openai-compat path every aggregator platform uses does not — `base.ts` passes
 *  `finish_reason` through verbatim.
 *
 *  This is a wire signal, never answer quality (SIMPLE_CORE_RESET): it reports what the
 *  provider said about ITS output budget, and changes no behavior beyond which of the two
 *  existing finish reasons is reported. */
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

/** 401/402/403 are ACCOUNT-level, not model-level: a dead key, an unpaid bill, or a plan that
 *  excludes paid models applies to every model on that platform at once. Retrying the
 *  platform's OTHER models after one of these is guaranteed waste — it burns the bounded
 *  chain on failures that cannot succeed, and the turn dies with candidates never tried.
 *  Live repro: ollama 402 "requires a subscription" (2026-08-30 1:30 PM, again 2:31 PM) and
 *  cerebras 402 "Payment required… visit your billing tab" (3:23 PM), each of which ended the
 *  turn. 429 and 5xx are deliberately NOT here: those are per-model/transient, and the next
 *  model of the same platform genuinely can serve.
 *
 *  Checked only AFTER a candidate's key rotation is exhausted — with several stored keys a
 *  401 may be one dead key rather than a dead account. */
/** The turn-killing error, written so the USER can tell that failover ran.
 *
 *  Previously this rethrew `lastError` verbatim, so a chain that tried four candidates and
 *  lost surfaced as a bare "Cerebras API error 402: Payment required" — indistinguishable
 *  from no failover happening at all, which is exactly what it was reported as
 *  ("if cerebras 402 then next handle will do? but failed", 2026-08-30 3:23 PM). Naming every
 *  candidate and its outcome answers that question in the message itself. A single-candidate
 *  chain keeps the provider's own wording: there was no failover to report. */
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

/** Splits a streamed content/reasoning pair into chat text + reasoning, with a
 *  duplicate-reasoning guard: some gateways send the SAME thinking twice — once as a native
 *  reasoning field (`reasoning_content`/`reasoning`/`reasoning_details`) AND again as
 *  `<think>` markup inside `content`. The FIRST channel to produce output wins; the other is
 *  suppressed for the rest of the stream, so reasoning never doubles. `<think>` content is
 *  routed to the reasoning channel (not discarded, not shown as chat). Exported for direct
 *  e2e (split tags, duplicates, unclosed blocks) without a live provider. */
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
 *  The old `JSON.stringify(part.output)` shipped models the ENVELOPE —
 *  `{"type":"text","value":"<?php\n…"}` with every newline JSON-escaped, error results
 *  double-encoded — because LanguageModelV4ToolResultOutput is always an object, never a
 *  string. Models read that soup as their observation and returned empty synthesis steps
 *  (live repro: gpt-oss-120b, nemotron-3-ultra-free — tools ran, final answer empty). */
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

/** `toolChoice` → the router's `tool_choice`. This mapping did not exist until 2026-09-01, so
 *  every `toolChoice` the engine set was silently DROPPED at this boundary: `RouteOptions`
 *  carries `tool_choice` and openai-compat.ts puts it straight on the wire, but nothing ever
 *  populated it from the SDK's call options.
 *
 *  What that cost: the plan-gap continuation's whole point is a wire-level guarantee that the
 *  turn closes — "Providers that ignore toolChoice fall back to the prose nudge" (see
 *  PLAN_MODE_TOOL_BOUNDARY_2026-08-31.md) assumed the field reached the provider at all. It did
 *  not, for any provider, ever. Live repro 2026-09-01 5:27 PM (Kilo/stepfun/step-3.7-flash:free,
 *  "hide products whose category or status is off in the vendor order edit grid"): 9 tool uses,
 *  then "Let me search for the Item model and its scopes…" and no plan card — the forced step
 *  was never actually forced. */
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

  // Bounded chain — 4 candidates is plenty without scoring — but bounded chains need
  // PLATFORM DIVERSITY or the bound defeats the failover it exists to feed. The picker's
  // tail is sorted by the catalog's intelligenceRank, which is a coarse 1..5 clamp: ollama
  // alone ships FIVE rank-1 models, more than the whole bound, so a rank-sorted tail can
  // hand back four candidates that are all the same provider. Every provider-wide failure
  // then burns the entire chain in one shot — live repro 2026-08-30 1:30 PM and again at
  // 2:31 PM: Auto died on `Ollama API error 402: this model requires a subscription`, four
  // ollama candidates 402'ing in ~4s with groq/cerebras/opencode never reached. Allow at
  // most MAX_PER_PLATFORM of the bound to a single platform on the first pass, then top the
  // chain back up from the overflow so a user who genuinely enabled only one provider still
  // gets a full chain.
  // Quota spreading is picker.ts's job, not this function's (2026-09-05): its equal-rank
  // rotation varies WHICH model wins each seat, and it runs upstream of the selection
  // rationale so the "Why this model?" report stays true. A second rotation here — of the
  // platform order, AFTER the rationale was already emitted — spread the same quota twice
  // and made the popover name a model that never ran.
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

  // The resolved chain is the first thing to check when a turn dies on a provider error —
  // "was there anything to fail over TO?" is not answerable from the error alone. The elapsed
  // is the REAL routing cost (selection + key lookups + platform interleave): engine.ts's old
  // "engine.select" number was taken from reportServed, which on the streaming path fires at
  // response settle and therefore reported the whole generation as "model selection"
  // (live repro: 18.2s "selection" on a turn whose TTFT was 17.3s).
  diagLog('rp.chain', `${Date.now() - selectT0}ms to resolve — `
    + (chain.length
      ? `${platformOrder.length} platform(s): ${chain.map((c) => `${c.platform}::${c.modelId}`).join(' \u2192 ')}`
      : '<empty \u2014 no usable candidate>'));
  // A pin that resolved to NO runnable candidate must fail the turn with its reason, not fall
  // back to other models — a set model runs alone (2026-08-31, user direction). Without this,
  // the generic "no model candidate resolved" fired and the pin's WHY stayed in the popover
  // only. The excludeModels escape hatch mirrors selectModel's: a deliberate retry may move
  // past the pin.
  // 'auto' (the webview default, meaning "no pin") must fall through to the generic
  // empty-chain error, not read as a pin that "could not run".
  if (chain.length === 0 && opts.pinnedModel && opts.pinnedModel !== 'auto'
    && !opts.excludeModels?.includes(opts.pinnedModel)) {
    const skipEntry = selection.rationale?.entries.find((e) => e.model === opts.pinnedModel);
    const why = skipEntry?.skip ?? 'no usable provider/key for it right now';
    throw new Error(`Pinned model ${opts.pinnedModel} could not run: ${why}.`);
  }
  return chain;
}

/** Wraps the v3 picker (or, for utility callers that still hold a Router, the Router itself)
 *  as an AI-SDK-shaped LanguageModelV4. The SDK calls doGenerate/doStream; this translates
 *  with a bounded failover on 429/5xx.
 *
 *  Two forms:
 *   - `createRouterProvider(providerOpts)` — v3 engine path: selection via router/picker.ts.
 *   - `createRouterProvider(router, providerOpts)` — utility path (plan structuring, condense,
 *     titles): the Router's own routing/failover serves the call. v3.1 migrates these callers. */
export function createRouterProvider(providerOpts: RouterProviderOptions = {}): LanguageModelV4 {
  return createPickerProvider(providerOpts);
}

/** Degenerate stream end: reasoning present, but NO text and NO tool calls. The model
 *  thought (often meta-deliberation like "the query is weird, let me read X") and exited
 *  without acting or answering. ONE mechanical continuation is warranted before any
 *  fold — promoting deliberation to the reply directly shows the user the model's
 *  internal monologue. Exported for direct e2e. */
export function needsFinalNudge(textStarted: boolean, toolCallCount: number, reasoning: string): boolean {
  return !textStarted && toolCallCount === 0 && reasoning.trim().length > 0;
}

/** Empty-final fold decision: when a stream produced NO text and NO tool calls but DID
 *  carry reasoning, that reasoning IS the reply (gpt-oss/Groq shape — everything in
 *  delta.reasoning, final channel empty). Streaming twin of openai-compat normalizeChoices'
 *  reasoning_content→content fold. LAST RESORT — runs only after a final-answer nudge also
 *  came back empty, so deliberation is never promoted while a real answer is still gettable.
 *  Exported for direct e2e. */
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

              // Stall failover: a provider that accepted the request and then emits NO chunk
              // at all within ttftGateMsFor is abandoned and the next candidate takes over.
              // This catches the hole `timeoutMs` cannot — headers in a second, then silence
              // forever. Any first chunk (content, reasoning, tool-call, usage, finish) clears
              // the timer; it is never a cap on generation length. See ttftGateMsFor for why
              // the bound tracks FAILOVER_CONNECT_TIMEOUT_MS instead of the 8s hedge knob.
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
                  // Reasoning models (DeepSeek R1 & friends) stream thinking either as native
                  // reasoning fields or as `<think>` markup inside content. The splitter routes
                  // both to the reasoning channel, keeps them OUT of the chat text, is safe for
                  // tags split across chunks, and never doubles reasoning when a gateway sends
                  // the same thinking through both channels at once.
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
            // A FOLDED turn is not a success. `folded` above means this candidate produced NO
            // content channel and NO tool call — only reasoning, which the fold promoted so the
            // user sees something instead of an empty bubble. Reporting that as `true` marked the
            // candidate healthy, so Auto re-picked it every turn (live repro ×3, 2026-08-28
            // 12:57-1:29 AM: nemotron-3-ultra-free on OpenRouter narrated into the reasoning
            // channel, got folded, and stayed the Auto pick). The answer still ships — switching
            // mid-stream would corrupt it — but the picker's cooldown now steers the NEXT turn
            // elsewhere. Mechanical signal (empty content channel), not answer-quality judgment:
            // the same category as engine.ts's actGapDemote.
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
