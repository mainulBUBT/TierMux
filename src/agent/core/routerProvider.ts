

// Pure protocol adapter — AI SDK prompt/tool shapes <-> TierMux's own ChatMessage/ChatToolDefinition
// (OpenAI wire format, which Router.route() already speaks). No routing decisions, no scoring, no
// failover logic here — that's all Router.route()'s job. The model being called is still whatever
// the user picked (GPT/Claude/Qwen/...); this factory does not itself produce "a model."
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult, LanguageModelV4StreamResult, LanguageModelV4StreamPart, LanguageModelV4FunctionTool, LanguageModelV4FilePart } from '@ai-sdk/provider';
import type { Router, RouteOptions } from '../../router/router';
import type { ChatMessage, ChatToolDefinition, ReasoningEffort } from '../../shared/types';
import { diagLog } from '../../util/diag';
import { rescueInlineToolCalls, repairToolArguments, toolSchemaMap, stripRawChannelMarkers } from '../toolArgs';

/** One scored candidate as reported to AgentOpts.onSelectionRationale — `model` is a
 *  "platform::modelId" key (matching onFailover's `from` shape), not a display name;
 *  chatViewProvider.ts's callback resolves it to a display name before it reaches the UI. */
export interface RationaleEntryInfo {
  model: string;
  selected: boolean;
  score: number;
  capability: number;
  runtime: number;
  preference: number;
  confidence: number;
  reason: string;
  skip?: string;
}

export interface RouterProviderOptions {
  effort?: ReasoningEffort;
  taskKind?: string;
  pinnedModel?: string;
  /** Chat session this turn belongs to. Forwarded to Router.route() so Auto keeps serving one
   *  conversation from ONE model instead of re-rolling per turn — see Router.sessionPin. */
  sessionId?: string;
  onFailover?: (from: string, reason: string) => void;
  onKeyRotated?: (info: { platform: string; keyIndex: number; keyTotal: number }) => void;
  onModelSelected?: (platform: string, model: string, runtimeName?: string) => void;
  onSelectionRationale?: (info: { taskKind: string; picked?: string; entries: RationaleEntryInfo[] }) => void;
  /** Quality-based escalation (loop.ts): skip these `platform::modelId` keys — forwarded
   *  straight to Router.route()'s `exclude`, which already implements this filter. */
  excludeModels?: string[];
  /** Quality-based escalation: only consider models at least this smart — forwarded to
   *  Router.route()'s `maxIntelligenceRank` (lower rank number = smarter; already implemented,
   *  just never set by any caller before loop.ts's escalation retry). */
  maxIntelligenceRank?: number;
  /** Step routing (Phase 2): only consider models at most this smart (the cheap pool for easy
   *  plan steps) — forwarded to Router.route()'s `minIntelligenceRank`. */
  minIntelligenceRank?: number;
  /** Turn telemetry sink — forwarded to Router.route()'s onUsage so the turn accumulates
   *  provider-reported token usage from every model call it makes. */
  usageSink?: RouteOptions['onUsage'];
}

const routeKey = (e: { platform: string; modelId: string }): string => `${e.platform}::${e.modelId}`;

/** Convert Router's own onSelectionRationale shape (scoring.ts's RationaleEntry[], which
 *  uses runtimeMultiplier/userPreference and platform+modelId as separate fields) into the
 *  flatter shape AgentOpts.onSelectionRationale/chatViewProvider.ts already expect. */
function toRationaleCallback(
  cb: RouterProviderOptions['onSelectionRationale'],
): RouteOptions['onSelectionRationale'] {
  if (!cb) return undefined;
  return (info) => cb({
    taskKind: info.taskKind,
    picked: info.picked ? routeKey(info.picked) : undefined,
    entries: info.rationale.map((r) => ({
      model: routeKey(r),
      selected: r.selected,
      score: r.score,
      capability: r.capability,
      runtime: r.runtimeMultiplier,
      preference: r.userPreference,
      confidence: r.confidence,
      reason: r.reason,
      skip: r.skip,
    })),
  });
}

/** Extract a `data:<mediaType>;base64,<...>` URL from an AI SDK v4 file part's tagged
 *  `SharedV4FileData` union. The AI SDK core (convertToLanguageModelPrompt) always resolves a
 *  `data:` URL string (what toFilePart in loop.ts hands it) down to `{ type: 'data', data:
 *  <bare base64 string> }` with `mediaType` lifted to the part's top level — so this has to
 *  re-wrap the base64 back into a data URL for the router's ChatContent block shape. */
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

/** Strips a leading/trailing ```json ... ``` (or bare ```) fence some models wrap JSON output
 *  in despite being told not to — generateObject's own JSON.parse would otherwise fail outright. */
function stripJsonFence(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(t);
  return m ? m[1].trim() : t;
}

/** Convert AI SDK prompt messages -> TierMux ChatMessage[] (OpenAI-wire format). */
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
      // `type:'file'` parts carry the image/PDF attachments (see toFilePart/toUserContent in
      // loop.ts) — these MUST survive into the router's ChatContent blocks, or a vision turn
      // reaches the model with the attachment silently gone regardless of which model got picked.
      const fileParts = msg.content.filter((p): p is LanguageModelV4FilePart => p.type === 'file');
      diagLog('attach.toRouterMessages', `partTypes=${msg.content.map((p) => p.type).join(',')} fileParts=${fileParts.length}`);
      if (fileParts.length === 0) {
        msgs.push({ role: 'user', content: text || '' });
      } else {
        const blocks: Array<{ type: string; [key: string]: unknown }> = [];
        if (text) blocks.push({ type: 'text', text });
        for (const p of fileParts) {
          const url = filePartToDataUrl(p);
          diagLog('attach.toRouterMessages', `file mediaType=${p.mediaType ?? '<none>'} dataType=${(p.data as { type?: string } | undefined)?.type ?? '<none>'} urlResolved=${!!url}`);
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
      const toolParts = msg.content.filter((p): p is any => p.type === 'tool-call');
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
          msgs.push({ role: 'tool', content: typeof part.output === 'string' ? part.output : JSON.stringify(part.output), tool_call_id: part.toolCallId });
        }
      }
    }
  }
  return msgs;
}

/** True when any message carries a raw (unextracted) PDF `type:'file'` block — Router.route()'s
 *  candidates() uses this to hard-filter to providers that actually forward PDF bytes
 *  (BaseProvider.carriesRawPdf), instead of picking an image-only vision model whose provider
 *  silently drops the file. Was previously declared on RouteOptions but never set by any caller. */
function hasRawPdfPart(messages: ChatMessage[]): boolean {
  return messages.some((m) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return false;
    return m.content.some((b) => {
      if (!b || typeof b !== 'object') return false;
      const block = b as { type?: string; file?: { mime?: string } };
      return block.type === 'file' && block.file?.mime === 'application/pdf';
    });
  });
}

/** Convert AI SDK tool definitions -> TierMux ChatToolDefinition[]. */
function toRouterTools(tools?: LanguageModelV4CallOptions['tools']): ChatToolDefinition[] | undefined {
  if (!tools?.length) return undefined;
  return tools
    .filter((t): t is LanguageModelV4FunctionTool => t.type === 'function')
    .map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.inputSchema as Record<string, unknown> } }));
}

/**
 * Wraps Router as an AI-SDK-shaped LanguageModelV4. Router is the "model" from the SDK's
 * point of view — the SDK calls doGenerate/doStream, this translates to router.route() with
 * failover/key-rotation callbacks forwarded. See core/loop.ts for how this gets wired up.
 */
export function createRouterProvider(router: Router, providerOpts: RouterProviderOptions = {}): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'tiermux',
    modelId: `auto-${providerOpts.effort ?? 'medium'}`,
    supportedUrls: {},

    async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      const messages = toRouterMessages(options.prompt);
      const tools = toRouterTools(options.tools);

      // generateObject/generateText's `output: 'object'|'enum'` sets responseFormat but the
      // router has no native "JSON mode" passthrough across ~18 heterogeneous free providers —
      // most weak/free models were never told to emit JSON at all otherwise. Append the schema
      // as an explicit trailing instruction instead (models attend most to the last message);
      // stripJsonFences below cleans up the common case where a model still wraps it in a
      // ```json fence despite being told not to.
      const wantsJson = options.responseFormat?.type === 'json';
      const jsonSchema = wantsJson && options.responseFormat && 'schema' in options.responseFormat ? options.responseFormat.schema : undefined;
      if (wantsJson) {
        messages.push({
          role: 'user',
          content: 'Respond with ONLY valid JSON matching this schema — no markdown fences, no '
            + `prose before or after it:\n${JSON.stringify(jsonSchema ?? {})}`,
        });
      }

      const routeOpts: RouteOptions = {
        model: providerOpts.pinnedModel ?? 'auto',
        temperature: options.temperature,
        max_tokens: options.maxOutputTokens,
        tools,
        requireTools: !!tools?.length,
        // Plumbed to CompletionOptions for a future per-provider native response_format —
        // no adapter reads this yet (see options.ts), the trailing instruction above is what
        // actually does the work today. Harmless to pass down unused.
        responseFormat: wantsJson ? { type: 'json', schema: jsonSchema } : undefined,
        reasoningEffort: providerOpts.effort,
        taskKind: providerOpts.taskKind as RouteOptions['taskKind'],
        sessionId: providerOpts.sessionId,
        onFailover: providerOpts.onFailover ? (info) => providerOpts.onFailover!(`${info.from.platform}::${info.from.modelId}`, info.reason) : undefined,
        onKeyRotated: providerOpts.onKeyRotated ? (info) => providerOpts.onKeyRotated!({ platform: info.platform, keyIndex: info.keyIndex, keyTotal: info.keyTotal }) : undefined,
        onSelectionRationale: toRationaleCallback(providerOpts.onSelectionRationale),
        exclude: providerOpts.excludeModels,
        maxIntelligenceRank: providerOpts.maxIntelligenceRank,
        minIntelligenceRank: providerOpts.minIntelligenceRank,
        onUsage: providerOpts.usageSink,
        abortSignal: options.abortSignal,
        hasRawPdfPart: hasRawPdfPart(messages),
      };
      diagLog('ai-sdk.doGenerate', `pinnedModel="${providerOpts.pinnedModel ?? '<auto>'}" → routeOpts.model="${routeOpts.model}" msgs=${messages.length} tools=${tools?.length ?? 0} hasRawPdfPart=${routeOpts.hasRawPdfPart}`);

      const result = await router.route(messages, routeOpts);
      providerOpts.onModelSelected?.(result.platform, result.model, result.runtimeName);
      diagLog('ai-sdk.doGenerate.served', `result=${result.platform}::${result.model} runtimeName="${result.runtimeName ?? ''}" usage=${JSON.stringify(result.response.usage)}`);

      const msg = result.response.choices?.[0]?.message;
      const content: LanguageModelV4GenerateResult['content'] = [];
      if (msg?.content) {
        const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        content.push({ type: 'text', text: wantsJson ? stripJsonFence(raw) : raw });
      }
      if (msg?.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          content.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, input: tc.function.arguments ?? '{}', providerExecuted: false });
        }
      }
      const hasCalls = !!msg?.tool_calls?.length;
      const rawFR = result.response.choices?.[0]?.finish_reason;
      return {
        content,
        finishReason: { unified: hasCalls ? 'tool-calls' : (rawFR === 'length' ? 'length' : 'stop'), raw: hasCalls ? 'tool_calls' : (rawFR ?? 'stop') },
        usage: {
          inputTokens: { total: result.response.usage?.prompt_tokens },
          outputTokens: { total: result.response.usage?.completion_tokens },
        },
        warnings: [],
      } as unknown as LanguageModelV4GenerateResult;
    },

    async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
      const messages = toRouterMessages(options.prompt);
      const tools = toRouterTools(options.tools);
      const hasTools = !!tools?.length;

      let streamController!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
      const stream = new ReadableStream<LanguageModelV4StreamPart>({ start(c) { streamController = c; } });

      streamController.enqueue({ type: 'stream-start', warnings: [] });
      const textId = 'text-0';
      let chunkCount = 0;
      let textStarted = false;

      const routeOpts: RouteOptions = {
        model: providerOpts.pinnedModel ?? 'auto',
        temperature: options.temperature,
        max_tokens: options.maxOutputTokens,
        tools,
        requireTools: hasTools,
        reasoningEffort: providerOpts.effort,
        taskKind: providerOpts.taskKind as RouteOptions['taskKind'],
        sessionId: providerOpts.sessionId,
        // Router.route() now streams even when tools are offered (tool-call deltas are
        // accumulated by index internally); live text deltas still arrive here as they land.
        onChunk: (delta: string) => {
          chunkCount++;
          if (!textStarted) { textStarted = true; streamController.enqueue({ type: 'text-start', id: textId }); }
          streamController.enqueue({ type: 'text-delta', id: textId, delta });
        },
        onFailover: providerOpts.onFailover ? (info) => providerOpts.onFailover!(`${info.from.platform}::${info.from.modelId}`, info.reason) : undefined,
        onKeyRotated: providerOpts.onKeyRotated ? (info) => providerOpts.onKeyRotated!({ platform: info.platform, keyIndex: info.keyIndex, keyTotal: info.keyTotal }) : undefined,
        onSelectionRationale: toRationaleCallback(providerOpts.onSelectionRationale),
        exclude: providerOpts.excludeModels,
        maxIntelligenceRank: providerOpts.maxIntelligenceRank,
        minIntelligenceRank: providerOpts.minIntelligenceRank,
        onUsage: providerOpts.usageSink,
        abortSignal: options.abortSignal,
        hasRawPdfPart: hasRawPdfPart(messages),
      };
      diagLog('ai-sdk.doStream', `pinnedModel="${providerOpts.pinnedModel ?? '<auto>'}" → routeOpts.model="${routeOpts.model}" msgs=${messages.length} tools=${tools?.length ?? 0} hasRawPdfPart=${routeOpts.hasRawPdfPart}`);

      router.route(messages, routeOpts).then((result) => {
        providerOpts.onModelSelected?.(result.platform, result.model, result.runtimeName);
        diagLog('ai-sdk.doStream.served', `result=${result.platform}::${result.model} runtimeName="${result.runtimeName ?? ''}" usage=${JSON.stringify(result.response.usage)} chunks=${chunkCount}`);
        const msg = result.response.choices?.[0]?.message;
        const rawFR = result.response.choices?.[0]?.finish_reason;
        const hasToolCalls = !!msg?.tool_calls?.length;

        // Rescue inline tool calls emitted as text by weak models (e.g. Cloudflare's llama-3.3
        // emits `{"type":"function","name":"explore","parameters":{...}}` as content because it
        // doesn't speak the tools API). Without this, the tool-call JSON would show as chat text.
        let rescuedToolCalls: { id: string; name: string; arguments: string }[] = [];
        if (!hasToolCalls && tools?.length) {
          const fullText = typeof msg?.content === 'string' ? msg.content
            : (msg?.content ? JSON.stringify(msg.content) : '');
          const toolNames = new Set(tools.map((t) => t.function.name));
          const rescue = rescueInlineToolCalls(fullText, toolNames);
          if (rescue.detected) {
            rescuedToolCalls = rescue.calls.map((c, i) => ({
              id: `call_rescued_${i + 1}`, name: c.name, arguments: repairToolArguments(c.arguments, toolSchemaMap(tools).get(c.name)),
            }));
            // Learn-by-failure: this model emitted its tool call as plain text (it doesn't speak the
            // tools API natively). Record a strike so repeated offenders get benched from tool routing.
            router.noteToolSoftFailure(result.platform, result.model);
          }
        }
        const effectiveToolCalls = hasToolCalls
          ? msg!.tool_calls!.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments ?? '{}' }))
          : rescuedToolCalls;
        const hasEffectiveToolCalls = effectiveToolCalls.length > 0;

        if (chunkCount === 0 && msg?.content && !hasEffectiveToolCalls) {
          if (!textStarted) { textStarted = true; streamController.enqueue({ type: 'text-start', id: textId }); }
          const fullText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          // Raw channel-template markers (GLM-style <|channel|>final<|message|>…) must never
          // render as the user-visible answer when no call was rescuable.
          streamController.enqueue({ type: 'text-delta', id: textId, delta: stripRawChannelMarkers(fullText) });
        }
        if (textStarted) streamController.enqueue({ type: 'text-end', id: textId });

        if (hasEffectiveToolCalls) {
          for (const tc of effectiveToolCalls) {
            streamController.enqueue({ type: 'tool-input-start', id: tc.id, toolName: tc.name });
            streamController.enqueue({ type: 'tool-input-delta', id: tc.id, delta: tc.arguments });
            streamController.enqueue({ type: 'tool-input-end', id: tc.id });
            streamController.enqueue({ type: 'tool-call', toolCallId: tc.id, toolName: tc.name, input: tc.arguments });
          }
        }

        streamController.enqueue({
          type: 'finish',
          finishReason: { unified: hasEffectiveToolCalls ? 'tool-calls' : (rawFR === 'length' ? 'length' : 'stop'), raw: hasEffectiveToolCalls ? 'tool_calls' : (rawFR ?? 'stop') },
          usage: { inputTokens: { total: result.response.usage?.prompt_tokens }, outputTokens: { total: result.response.usage?.completion_tokens } },
        } as unknown as LanguageModelV4StreamPart);
        streamController.close();
      }).catch((err: unknown) => {
        // Surface a router.route() rejection (e.g. AllModelsFailedError from a pinned model
        // hitting 403/quota) by ERRORING the stream rather than enqueuing an `{type:'error'}`
        // stream part. The official AI SDK providers do the same: they let doStream's stream
        // throw, which the SDK turns into a thrown error on `fullStream` — caught by runTurn's
        // catch (→ onError + failed=true), so the failure shows in chat immediately. Enqueuing an
        // error part instead relied on a stream-part shape the SDK is inconsistent about
        // (TS type says `error`, runtime schema says `errorText`), which silently dropped the
        // error and ended the turn empty — only reappearing from persisted transcript on reopen.
        streamController.error(err);
      });

      return { stream };
    },
  };
}
