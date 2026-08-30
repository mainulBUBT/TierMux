// v3 routerProvider (plan step 8) — the AI SDK seam, rewritten from Router.route() to the
// thin picker. Owns: candidate loop (model + fallbackChain), API-key lookup, streaming
// translation between the V4 part protocol and the OpenAI wire the providers speak, and
// TWO failover rules, both reported back to the picker's per-model cooldown via recordOutcome:
//   (1) availability — a candidate that answers 429/5xx/401/network/timeout is retried on the
//       next candidate in the chain;
//   (2) quality — a candidate that returns nothing usable (no text, no tool call, no foldable
//       reasoning) is also skipped in favor of the next candidate.
// No scoring, no hedging, no session pin, no circuit-breaker beyond the minimal cooldown the
// picker keeps — those lived in the deleted Router and stay deleted.
//
// Kept from the previous version (battle-tested translation): toRouterMessages,
// toRouterTools, filePartToDataUrl, hasRawPdfPart, toV4Usage, and the stream-part emission
// order (text-start/-delta/-end, tool-input-*, tool-call, finish).

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
import type { ChatMessage, ChatToolDefinition, ReasoningEffort, Platform } from '../../shared/types';
import { resolveProvider } from '../../providers';
import { ProviderHttpError } from '../../providers/base';
import { selectModel, setModelSources, getApiKeysFor, recordOutcome, type ModelSources } from '../../router/picker';
import { ThinkStripper, stripThinkTags, reasoningFromDelta, type Router, type RouteOptions } from '../../router/router';
import { diagLog } from '../../util/diag';

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
      || e.status === 429 || (e.status !== undefined && e.status >= 500);
  }
  return e instanceof Error && /network|fetch failed|timed out|ECONN/i.test(e.message);
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
export async function resolveCandidates(opts: RouterProviderOptions): Promise<Candidate[]> {
  const selection = await selectModel([], {
    pinnedModel: opts.pinnedModel,
    excludeModels: opts.excludeModels,
    taskKind: opts.taskKind,
    sessionId: opts.sessionId,
    requireTools: opts.requireTools,
  });
  if (selection.rationale) opts.onSelectionRationale?.(selection.rationale);

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
  const MAX_CANDIDATES = 4;
  const MAX_PER_PLATFORM = 2;
  const primary: Candidate[] = [];
  const overflow: Candidate[] = [];
  const perPlatform = new Map<string, number>();
  // Memoized so one secret lookup per platform covers every model of that platform in the
  // chain (the scan below walks past the bound to find alternatives).
  const keyCache = new Map<string, string[]>();
  const keysFor = async (platform: string): Promise<string[]> => {
    let keys = keyCache.get(platform);
    if (!keys) { keys = await getApiKeysFor(platform); keyCache.set(platform, keys); }
    return keys;
  };

  for (const key of [selection.model, ...selection.fallbackChain]) {
    if (primary.length >= MAX_CANDIDATES) break;
    const [platform, ...rest] = key.split('::');
    const modelId = rest.join('::');
    if (!modelId || modelId === 'auto') continue;
    const provider = resolveProvider(platform as Platform, modelId);
    if (!provider) continue;
    const apiKeys = await keysFor(platform);
    if (apiKeys.length === 0) continue;
    const candidate: Candidate = { platform: platform as Platform, modelId, apiKeys };
    const used = perPlatform.get(platform) ?? 0;
    if (used >= MAX_PER_PLATFORM) {
      // Held back, not dropped: it still serves if no other platform can fill the slot.
      if (overflow.length < MAX_CANDIDATES) overflow.push(candidate);
      continue;
    }
    perPlatform.set(platform, used + 1);
    primary.push(candidate);
  }

  // Only one platform available? The diversity cap would leave a 2-long chain where a
  // 4-long one was possible — refill from the held-back models in their original order.
  for (const c of overflow) {
    if (primary.length >= MAX_CANDIDATES) break;
    primary.push(c);
  }
  return primary;
}

/** Wraps the v3 picker (or, for utility callers that still hold a Router, the Router itself)
 *  as an AI-SDK-shaped LanguageModelV4. The SDK calls doGenerate/doStream; this translates
 *  with a bounded failover on 429/5xx.
 *
 *  Two forms:
 *   - `createRouterProvider(providerOpts)` — v3 engine path: selection via router/picker.ts.
 *   - `createRouterProvider(router, providerOpts)` — utility path (plan structuring, condense,
 *     titles): the Router's own routing/failover serves the call. v3.1 migrates these callers. */
export function createRouterProvider(
  routerOrOpts?: Router | RouterProviderOptions,
  maybeOpts: RouterProviderOptions = {},
): LanguageModelV4 {
  if (routerOrOpts && typeof (routerOrOpts as Router).route === 'function') {
    return createRouterBackedProvider(routerOrOpts as Router, maybeOpts);
  }
  const providerOpts = (routerOrOpts as RouterProviderOptions | undefined) ?? maybeOpts;
  return createPickerProvider(providerOpts);
}

/** The pre-v3 behavior, kept for utility callers that pass the scoring Router. */
function createRouterBackedProvider(router: Router, providerOpts: RouterProviderOptions): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'tiermux',
    modelId: providerOpts.pinnedModel ?? `auto-${providerOpts.effort ?? 'medium'}`,
    supportedUrls: {},

    async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      const messages = toRouterMessages(options.prompt);
      const tools = toRouterTools(options.tools);
      const routeOpts: RouteOptions = {
        model: providerOpts.pinnedModel ?? 'auto',
        temperature: options.temperature,
        max_tokens: options.maxOutputTokens,
        tools,
        requireTools: !!tools?.length,
        reasoningEffort: providerOpts.effort,
        taskKind: providerOpts.taskKind as RouteOptions['taskKind'],
        sessionId: providerOpts.sessionId,
        onFailover: providerOpts.onFailover ? (info: { from: { platform: string; modelId: string }; reason: string }) => providerOpts.onFailover?.(`${info.from.platform}::${info.from.modelId}`, info.reason) : undefined,
        abortSignal: options.abortSignal,
      };
      const result = await router.route(messages, routeOpts);
      providerOpts.onModelSelected?.(result.platform, result.model, result.runtimeName);
      const msg = result.response.choices?.[0]?.message;
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
      const rawFR = result.response.choices?.[0]?.finish_reason;
      return {
        content,
        finishReason: { unified: hasCalls ? 'tool-calls' : (rawFR === 'length' ? 'length' : 'stop'), raw: hasCalls ? 'tool_calls' : (rawFR ?? 'stop') },
        usage: toV4Usage(result.response.usage?.prompt_tokens, result.response.usage?.completion_tokens),
        warnings: [],
      };
    },

    async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
      const messages = toRouterMessages(options.prompt);
      const tools = toRouterTools(options.tools);
      let controller!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
      const stream = new ReadableStream<LanguageModelV4StreamPart>({ start(c) { controller = c; } });
      controller.enqueue({ type: 'stream-start', warnings: [] });

      const think = new ThinkStripper();
      const textId = 'text-0';
      let textStarted = false;
      let chunkCount = 0;

      const routeOpts: RouteOptions = {
        model: providerOpts.pinnedModel ?? 'auto',
        temperature: options.temperature,
        max_tokens: options.maxOutputTokens,
        tools,
        requireTools: !!tools?.length,
        reasoningEffort: providerOpts.effort,
        taskKind: providerOpts.taskKind as RouteOptions['taskKind'],
        sessionId: providerOpts.sessionId,
        onChunk: (delta: string) => {
          chunkCount++;
          const clean = think.feed(delta);
          if (clean) {
            if (!textStarted) { textStarted = true; controller.enqueue({ type: 'text-start', id: textId }); }
            controller.enqueue({ type: 'text-delta', id: textId, delta: clean });
          }
        },
        onFailover: providerOpts.onFailover ? (info: { from: { platform: string; modelId: string }; reason: string }) => providerOpts.onFailover?.(`${info.from.platform}::${info.from.modelId}`, info.reason) : undefined,
        abortSignal: options.abortSignal,
      };

      router.route(messages, routeOpts).then((result) => {
        providerOpts.onModelSelected?.(result.platform, result.model, result.runtimeName);
        const msg = result.response.choices?.[0]?.message;
        const rawFR = result.response.choices?.[0]?.finish_reason;
        const hasToolCalls = !!msg?.tool_calls?.length;

        if (chunkCount === 0 && msg?.content && !hasToolCalls) {
          if (!textStarted) { textStarted = true; controller.enqueue({ type: 'text-start', id: textId }); }
          const fullText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          controller.enqueue({ type: 'text-delta', id: textId, delta: stripThinkTags(fullText) });
        }
        const tail = think.flush();
        if (tail) {
          if (!textStarted) { textStarted = true; controller.enqueue({ type: 'text-start', id: textId }); }
          controller.enqueue({ type: 'text-delta', id: textId, delta: tail });
        }
        if (textStarted) controller.enqueue({ type: 'text-end', id: textId });

        if (hasToolCalls) {
          for (const tc of msg!.tool_calls!) {
            controller.enqueue({ type: 'tool-input-start', id: tc.id, toolName: tc.function.name });
            controller.enqueue({ type: 'tool-input-delta', id: tc.id, delta: tc.function.arguments ?? '{}' });
            controller.enqueue({ type: 'tool-input-end', id: tc.id });
            controller.enqueue({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, input: tc.function.arguments ?? '{}' });
          }
        }

        controller.enqueue({
          type: 'finish',
          finishReason: { unified: hasToolCalls ? 'tool-calls' : (rawFR === 'length' ? 'length' : 'stop'), raw: hasToolCalls ? 'tool_calls' : (rawFR ?? 'stop') },
          usage: toV4Usage(result.response.usage?.prompt_tokens, result.response.usage?.completion_tokens),
        });
        controller.close();
      }).catch((err: unknown) => {
        controller.error(err);
      });

      return { stream };
    },
  };
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
      const candidates = await resolveCandidates(providerOpts);
      if (candidates.length === 0) throw new Error('TierMux: no model candidate resolved');

      let lastError: unknown;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const provider = resolveProvider(c.platform, c.modelId);
        if (!provider) continue;
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
          });
          providerOpts.onModelSelected?.(c.platform, c.modelId, provider.runtimeName);
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
            finishReason: { unified: hasCalls ? 'tool-calls' : (rawFR === 'length' ? 'length' : 'stop'), raw: hasCalls ? 'tool_calls' : (rawFR ?? 'stop') },
            usage: toV4Usage(data.usage?.prompt_tokens, data.usage?.completion_tokens),
            warnings: [],
          };
          } catch (e) {
            lastError = e;
            recordOutcome(c.platform, c.modelId, false);
            if (isFailoverWorthy(e)) {
              providerOpts.onFailover?.(`${c.platform}::${c.modelId}`, e instanceof Error ? e.message : String(e));
              continue; // next key; when keys run out, the candidate loop advances
            }
            throw e;
          }
        }
      }
      throw lastError instanceof Error ? lastError : new Error('TierMux: all candidates failed');
    },

    async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
      const messages = toRouterMessages(options.prompt);
      const tools = toRouterTools(options.tools);
      const candidates = await resolveCandidates(providerOpts);
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
        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i];
          const provider = resolveProvider(c.platform, c.modelId);
          if (!provider) continue;
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

              for await (const chunk of provider.streamChatCompletion(apiKey, attemptMessages, c.modelId, {
                temperature: options.temperature,
                max_tokens: options.maxOutputTokens,
                tools,
                reasoningEffort: providerOpts.effort,
                abortSignal: options.abortSignal,
              })) {
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

            providerOpts.onModelSelected?.(c.platform, c.modelId, provider.runtimeName);
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
              finishReason: { unified: hasCalls ? 'tool-calls' : (finish === 'length' ? 'length' : 'stop'), raw: hasCalls ? 'tool_calls' : (finish ?? 'stop') },
              usage: toV4Usage(usage?.prompt_tokens, usage?.completion_tokens),
            });
            controller.close();
            return;
          } catch (e) {
            lastError = e;
            recordOutcome(c.platform, c.modelId, false);
            if (isFailoverWorthy(e)) {
              providerOpts.onFailover?.(`${c.platform}::${c.modelId}`, e instanceof Error ? e.message : String(e));
              continue; // next key; when keys run out, the candidate loop advances
            }
            controller.error(e);
            return;
          }
          }
        }
        controller.error(lastError instanceof Error ? lastError : new Error('TierMux: all candidates failed'));
      })();

      return { stream };
    },
  };
}
