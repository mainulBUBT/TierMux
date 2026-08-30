// v3 engine — TierMux is the policy layer; the AI SDK (streamText) is the execution engine.
// This file owns: message conversion, the mode-filtered toolset, permission policy
// (toolApproval), malformed-call self-correction (repairToolCall), compaction (prepareStep),
// the 50-step cap (stopWhen), and AgentResult assembly. Mechanical recovery only — never
// answer-quality judgment (docs/SIMPLE_CORE_RESET_2026-08-24.md).

import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type ToolSet,
  type LanguageModel,
} from 'ai';
import type { ChatMessage, ChatContentBlock } from '../../shared/types';
import type { AgentOpts, AgentResult, ToolEvent } from '../agent';
import { createRouterProvider } from './routerProvider';
import { buildV3ToolSet } from './tools/v3';
import { makeRepairViaModelSelfCorrection } from './repair';
import { compactIfNeeded } from './compact';
import { resolvePolicy, policyFromSettings } from '../../permissions/policy';
import { recordOutcome, findCatalogModel } from '../../router/picker';
import { resolveExecutionProfile } from '../executionProfile';
import { composeSystemPrompt } from '../../context/system';
import { gatherPromptContext } from '../../context/promptContext';
import { diagLog } from '../../util/diag';

/** Profile used until the serving model is known (see currentProfile() in runTurn). */
const FALLBACK_PROFILE = resolveExecutionProfile(undefined);

// Coordination tools — dropped on small-window models: the toolset serializes to ~3,570
// schema tokens on EVERY request (measured 2026-08-30, 14 tools) and these two cost ~740
// while being withdrawable. Deliberately NOT the web tools — withdrawing a capability makes
// the model refuse the task instead of doing it smaller (see tools/v3/index.ts).
const COORDINATION_TOOLS = ['todoWrite', 'delegateTask'];
/** At/below this window the schema tax stops being affordable. */
const SMALL_WINDOW_MAX = 16_384;

// ── Wire-format conversion (OpenAI ChatMessage ↔ AI SDK ModelMessage) ──────────

function blocksToUserContent(content: ChatContentBlock[] | string): string | Array<{ type: 'text'; text: string } | { type: 'file'; data: string; mediaType: string }> {
  if (typeof content === 'string') return content;
  const parts: Array<{ type: 'text'; text: string } | { type: 'file'; data: string; mediaType: string }> = [];
  for (const b of content) {
    if (typeof b === 'string') { parts.push({ type: 'text', text: b }); continue; }
    if (b?.type === 'text' && typeof b.text === 'string') {
      parts.push({ type: 'text', text: b.text });
    } else if (b?.type === 'image_url') {
      const url = (b as { image_url?: { url?: string } }).image_url?.url ?? '';
      if (url.startsWith('data:')) {
        const mediaType = url.slice(5, url.indexOf(';')) || 'image/png';
        parts.push({ type: 'file', data: url, mediaType });
      }
    }
    // Raw PDF `file` blocks: dropped here — the old extractAttachments pipeline converted
    // them host-side before they ever reached the engine; v3.1 restores that flow.
  }
  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
}

/** ModelMessage assistant content is string | parts; narrow once, reuse everywhere. */
function assistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<{ type?: string; text?: string }>)
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
}

export function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  // toolName lookup for tool messages (the OpenAI wire shape carries only tool_call_id).
  const nameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string' && m.content) out.push({ role: 'system', content: m.content });
    } else if (m.role === 'user') {
      out.push({ role: 'user', content: blocksToUserContent(m.content ?? '') });
    } else if (m.role === 'assistant') {
      const text = assistantText(m.content);
      const calls = (m.tool_calls ?? []).map((tc) => {
        nameById.set(tc.id, tc.function.name);
        let input: unknown;
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = {}; }
        return { type: 'tool-call' as const, toolCallId: tc.id, toolName: tc.function.name, input };
      });
      const parts: Array<{ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }> = [];
      if (text) parts.push({ type: 'text', text });
      out.push({ role: 'assistant', content: [...parts, ...calls] });
    } else if (m.role === 'tool') {
      const name = nameById.get(m.tool_call_id ?? '') ?? 'tool';
      const value = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      out.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: m.tool_call_id ?? '', toolName: name, output: { type: 'text', value } }] });
    }
  }
  return out;
}

/** ModelMessage[] → ChatMessage[] (for AgentResult.workMessages — the host persists the
 *  OpenAI-wire shape in its session transcripts). */
function toChatMessages(messages: ModelMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: m.content });
    } else if (m.role === 'user') {
      const text = typeof m.content === 'string' ? m.content : m.content.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('');
      out.push({ role: 'user', content: text });
    } else if (m.role === 'assistant') {
      const text = assistantText(m.content);
      const calls = (Array.isArray(m.content) ? m.content : [])
        .filter((p): p is { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown } => p?.type === 'tool-call')
        .map((p) => ({ id: p.toolCallId, type: 'function' as const, function: { name: p.toolName, arguments: JSON.stringify(p.input ?? {}) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (m.role === 'tool') {
      for (const part of m.content) {
        if (part.type === 'tool-result') {
          const value = typeof part.output === 'string' ? part.output
            : (part.output as { type?: string; value?: unknown })?.type === 'text'
              ? String((part.output as { value?: unknown }).value ?? '')
              : JSON.stringify(part.output);
          out.push({ role: 'tool', content: value, tool_call_id: part.toolCallId });
        }
      }
    }
  }
  return out;
}

/** Files this turn touched, derived deterministically from the executed tool calls. */
function changedFilesFrom(messages: ChatMessage[]): Array<{ path: string; status: 'created' | 'modified' | 'deleted' }> {
  const out: Array<{ path: string; status: 'created' | 'modified' | 'deleted' }> = [];
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      let input: { path?: string } = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch { continue; }
      if (!input.path || seen.has(`${tc.function.name}:${input.path}`)) continue;
      seen.add(`${tc.function.name}:${input.path}`);
      if (tc.function.name === 'editFile') out.push({ path: input.path, status: 'modified' });
      if (tc.function.name === 'writeFile') out.push({ path: input.path, status: 'created' });
      if (tc.function.name === 'deleteFile') out.push({ path: input.path, status: 'deleted' });
    }
  }
  return out;
}

// ── The turn ────────────────────────────────────────────────────────────────────

/** Test seam ONLY (foundation-gate scenarios 11-14): when set, the engine uses this model
 *  instead of the picker-backed createRouterProvider — letting the e2e drive the REAL
 *  runTurn (toolset filtering, policy, history round-trip) with a scripted LanguageModelV4.
 *  Production never sets it. */
let modelOverride: LanguageModel | undefined;
export function __setEngineModelForTests(m: LanguageModel | undefined): void {
  modelOverride = m;
}

/** v3 turn entry. The `router` argument is IGNORED — model selection lives in
 *  router/picker.ts (injected via setModelSources at activation). Kept in the signature so
 *  every existing call site compiles unchanged. */
export async function runTurn(_router: unknown, opts: AgentOpts): Promise<AgentResult> {
  // Turn-start facts: if signalAborted=true here, no model request can ever run this turn.
  diagLog('engine.start', `mode=${opts.mode} msgs=${opts.messages?.length ?? 0} signalAborted=${opts.abortSignal?.aborted ?? 'none'} requestId=${opts.requestId ?? '-'}`);
  const modelMessages = toModelMessages(opts.messages);
  const tools: ToolSet = buildV3ToolSet(opts.mode, {
    abortSignal: opts.abortSignal,
    sessionId: opts.sessionId,
    requestId: opts.requestId,
    onTodos: opts.onTodos,
    onBeforeWrite: opts.onBeforeWrite,
    onAskUser: opts.onAskUser,
  }) as ToolSet;

  const model: LanguageModel = modelOverride ?? createRouterProvider({
    effort: opts.effort,
    taskKind: opts.taskKind,
    pinnedModel: opts.pinnedModel,
    sessionId: opts.sessionId,
    excludeModels: opts.excludeModels,
    requireTools: true, // the engine always offers tools — non-tool models would deflect
    onFailover: opts.onFailover,
    onSelectionRationale: opts.onSelectionRationale,
    onModelSelected: (platform, mdl, runtimeName) => {
      served = { platform, model: mdl, runtimeName };
      opts.onModel(platform, mdl, runtimeName);
    },
    onUsage: opts.usageSink
      ? (info) => opts.usageSink?.({ inputTokens: info.inputTokens, outputTokens: info.outputTokens, contextTokens: info.inputTokens, model: info.model })
      : undefined,
  });

  const { repair } = makeRepairViaModelSelfCorrection({ model, signal: opts.abortSignal });
  const policy = policyFromSettings(false, opts.mode, opts.sessionId);
  const toolEvents: ToolEvent[] = [];
  let reasoningText = '';
  // ai v7 consumeStream() RESOLVES on stream errors (they go to its onError option) — the
  // try/catch below never sees provider failures; captured here for the post-pass guard.
  let streamError: string | undefined;
  // True while the current step has streamed reply text but no tool call yet (see onChunk).
  let narrationSinceToolCall = false;

  let outcome: { finishReason: string; text: string; responseMessages: ModelMessage[] } = {
    finishReason: 'unknown', text: '', responseMessages: [],
  };
  // Which model actually served the turn — surfaced in AgentResult so the host's per-bubble
  // footer shows the real model (failover can switch it mid-turn; the LAST server wins).
  let served: { platform?: string; model?: string; runtimeName?: string } = {};

  /** Serving model's ExecutionProfile, resolved per step — drives both the compaction budget
   *  and the tool-offer size. onModelSelected fires at step END, so step 0 falls back
   *  (pinned model → explicit lookup; else FALLBACK_PROFILE). */
  const currentProfile = () => {
    let meta = served.platform && served.model
      ? findCatalogModel(served.platform, served.model)
      : undefined;
    if (!meta && opts.pinnedModel?.includes('::')) {
      const [platform, ...rest] = opts.pinnedModel.split('::');
      meta = findCatalogModel(platform, rest.join('::'));
    }
    return meta ? resolveExecutionProfile(meta) : FALLBACK_PROFILE;
  };

  // System prompt + context gathered ONCE per turn: both passes share the identical prefix
  // (provider prompt-cache friendly) and the async reads never happen per-pass.
  const system = composeSystemPrompt(opts.mode, await gatherPromptContext());
  const runPass = (messages: ModelMessage[]) => streamText({
    model,
    system,
    messages,
    tools,

    toolApproval: ({ toolCall }) =>
      resolvePolicy({ toolName: toolCall.toolName, input: toolCall.input }, policy, async (req) => {
        if (!opts.onPermissionAsk) return 'deny';
        // Mutating INPUT passed through so the host's isDangerous(command) gate can fire and
        // the approval card renders the real command/paths, not a bare "Allow X?".
        const input = (req.input ?? {}) as { command?: string; path?: string };
        const verdict = await opts.onPermissionAsk({
          title: `Allow ${req.tool}?`,
          toolName: req.tool,
          ...(input.command ? { command: input.command } : {}),
          ...(input.path ? { pattern: input.path } : {}),
        });
        return verdict === 'once' ? 'allow' : verdict === 'always' ? 'allow-always' : 'deny';
      }),

    repairToolCall: repair,
    prepareStep: ({ messages }) => {
      const profile = currentProfile();
      const offer = profile.contextWindow <= SMALL_WINDOW_MAX
        ? Object.keys(tools).filter((t) => !COORDINATION_TOOLS.includes(t))
        : undefined;
      return {
        ...compactIfNeeded(messages, profile.pruneTarget),
        ...(offer ? { activeTools: offer } : {}),
      };
    },
    stopWhen: [stepCountIs(50)],
    abortSignal: opts.abortSignal,
    maxRetries: 1,

    onChunk: ({ chunk }) => {
      if (chunk.type === 'text-delta') {
        narrationSinceToolCall = true;
        opts.onChunk(chunk.text);
      } else if (chunk.type === 'reasoning-delta') {
        reasoningText += chunk.text;
        opts.onReasoning(chunk.text);
      } else if (chunk.type === 'tool-call' && narrationSinceToolCall) {
        // Text streamed in the same step just before a tool call is planning narration, not
        // the reply — retract the live draft so the webview re-routes it to Chain-of-Thought.
        narrationSinceToolCall = false;
        opts.onRetractDraft?.();
      }
    },

    onStepEnd: (step) => {
      for (const tc of step.toolCalls ?? []) {
        const ev: ToolEvent = { toolCallId: tc.toolCallId, name: tc.toolName, args: tc.input, state: 'running' };
        toolEvents.push(ev);
        opts.onTool(ev);
      }
      const failed = new Set(
        (step.content as Array<{ type?: string; toolName?: string }>)
          .filter((p) => p.type === 'tool-error' && p.toolName)
          .map((p) => p.toolName as string),
      );
      for (const tr of step.toolResults ?? []) {
        const isFailed = failed.has(tr.toolName);
        const ev: ToolEvent = {
          toolCallId: tr.toolCallId,
          name: tr.toolName,
          args: tr.input,
          state: isFailed ? 'error' : 'done',
        };
        toolEvents.push(ev);
        opts.onTool(ev);
      }
    },

    onError: ({ error }) => {
      // NOTE: streamText's onError does NOT fire for model-stream failures in ai v7 (probe:
      // stream-start → controller.error → neither onError nor onEnd, consumeStream resolves).
      // The real capture is the onError option on consumeStream() below. Kept for internal
      // errors that DO route here.
      diagLog('engine.error', String(error));
    },

    onEnd: ({ steps, finishReason }) => {
      // V4 finishReason is an OBJECT ({unified, raw}) — String() gave "[object Object]" and
      // silently disabled every finish-based recovery. Use the unified string.
      const fr = typeof finishReason === 'string'
        ? finishReason
        : ((finishReason as { unified?: string } | undefined)?.unified ?? 'unknown');
      // Last NON-empty step text, not steps.at(-1): a reasoning model can emit text + a tool
      // call in step 1 then a silent step 2, erasing the only visible content (repro:
      // gpt-oss-120b, 270 out tokens discarded at settle). Continuation passes APPEND their
      // messages and keep the earlier text if the retry ends silent.
      const passText = [...steps].reverse().find((s) => s.text?.trim())?.text ?? '';
      outcome = {
        finishReason: fr,
        text: passText || outcome.text,
        responseMessages: [...outcome.responseMessages, ...steps.flatMap((s) => s.response.messages)],
      };
    },
  });

  try {
    await runPass(modelMessages).consumeStream({
      // ai v7: consumeStream resolves even when the provider stream errors — the ONLY place
      // the failure is reported is this option (the top-level onError above never fires for
      // it, and the try/catch here never sees a rejection).
      onError: (error: unknown) => {
        streamError = error instanceof Error ? error.message : String(error);
        diagLog('engine.streamError', streamError.slice(0, 160));
      },
    });
  } catch (e) {
    const aborted = opts.abortSignal?.aborted || (e as Error)?.name === 'AbortError';
    const message = e instanceof Error ? e.message : String(e);
    diagLog('engine.catch', `aborted=${aborted} name=${(e as Error)?.name ?? '?'} msg="${message.slice(0, 140)}"`);
    // Abort with NOTHING streamed (stale token, or Stop within the first second): return
    // paused:true so the turn stays resumable instead of a 0-token mystery placeholder.
    if (aborted && !outcome.text.trim() && toolEvents.length === 0) {
      diagLog('engine.abortEmpty', 'abort before any output — returning paused:true so the turn stays resumable');
      return {
        text: '',
        finishReason: 'unknown',
        paused: true,
        platform: served.platform,
        model: served.model,
        runtimeName: served.runtimeName,
        workMessages: [],
        changedFiles: [],
      };
    }
    if (!aborted) opts.onError(message);
    return {
      text: outcome.text,
      reasoning: reasoningText || undefined,
      finishReason: outcome.finishReason,
      platform: served.platform,
      model: served.model,
      runtimeName: served.runtimeName,
      workMessages: toChatMessages(outcome.responseMessages),
      failed: !aborted,
      ...(aborted ? {} : { errorMessage: message }),
      changedFiles: changedFilesFrom(toChatMessages(outcome.responseMessages)),
    };
  }

  // Stream-error guard: a provider failure consumeStream resolved used to fall through as a
  // "successful" empty turn (0 in/0 out) with the real reason (401/403/429/credit, or "all
  // candidates failed") swallowed — repro 1:18 AM, dead in 1s. Surface it, but only when the
  // turn produced NOTHING; partial output from a later-step failure still ships. A
  // dead-at-start abort returns paused instead.
  if (
    streamError
    && !opts.abortSignal?.aborted
    && !outcome.text.trim() && !reasoningText.trim() && toolEvents.length === 0
  ) {
    diagLog('engine.streamFailed', `no output + stream error — surfacing: "${streamError.slice(0, 140)}"`);
    return {
      text: '',
      finishReason: outcome.finishReason,
      failed: true,
      errorMessage: streamError,
      platform: served.platform,
      model: served.model,
      runtimeName: served.runtimeName,
      workMessages: [],
      changedFiles: [],
    };
  }

  // Agent-mode CONTINUATION NUDGE — one continuation when the turn ends without CLOSING
  // (finish 'stop' only), skipped for questions so agent-mode Q&A keeps its prose answer:
  //   act-gap    — no tool ran; reply is empty / narration / a proposal fence.
  //   report-gap — tools ran but the synthesis step ended empty or on narration (the SDK
  //     always runs a next step after tool calls, so this is an empty synthesis, not an
  //     early loop end). Narration-after-tools ANNOUNCES the next call instead of making
  //     it — same unclosed loop. Repro ×2 (Kilo/stepfun step-3.7-flash:free, 2026-08-30
  //     3:47/3:54 PM): ended on "Let me continue reading…" after 8 and 6 tool uses.
  // This EXTENDS the existing guard's condition — one guard, not a second (SIMPLE_CORE_RESET
  // rule: live repro → ONE targeted guard).
  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
  const lastUserText = typeof lastUser?.content === 'string' ? lastUser.content : '';
  const looksLikeQuestion = !!lastUserText
    && (/\?\s*$/m.test(lastUserText) || /^(how|what|why|when|who|which|explain|tell me|describe|review)\b/i.test(lastUserText.trim()));
  const replyEmpty = outcome.text.trim().length === 0;
  const replyIsNarration = !replyEmpty
    && /^\s*(the user|i'll|i will|we'll|we will|let's|let me|we need|we can|i need|first,|i should|we should|okay,? so)\b/i.test(outcome.text);
  diagLog('engine.turnEnd', `finish=${outcome.finishReason} textLen=${outcome.text.length} steps=${outcome.responseMessages.length} tools=${toolEvents.length} reasoningLen=${reasoningText.length} empty=${replyEmpty} narration=${replyIsNarration}`);
  const didWork = toolEvents.length > 0;
  const actGap = !didWork && (replyEmpty || replyIsNarration || outcome.text.includes('```'));
  const reportGap = didWork && (replyEmpty || replyIsNarration);
  if (
    opts.mode === 'agent'
    && !opts.abortSignal?.aborted
    && outcome.finishReason === 'stop'
    && !looksLikeQuestion
    && (actGap || reportGap)
  ) {
    diagLog('engine.applyNudge', `${reportGap ? 'report-gap (tools ran, empty synthesis)' : 'act-gap (no tools ran)'} (textLen=${outcome.text.length}, narration=${replyIsNarration}) — continuation pass`);
    // Pass-1 narration triggered the nudge — retract it (repro: nemotron-3-ultra-free 12:57
    // AM, both passes' narration stacked in one bubble); pass 2's text is the sole draft.
    if (outcome.text.trim()) opts.onRetractDraft?.();
    try {
      await runPass([
        ...modelMessages,
        ...outcome.responseMessages,
        {
          role: 'user',
          content: reportGap
            ? 'You ran tools but ended the turn without a final answer. CLOSE the task now: tell the user what you found or changed (with file paths) and the result. If the task is not actually finished, keep working with your tools instead of stopping. Never end a turn silently.'
            : 'You stopped after describing what you would do — no tool ran and no file changed. Continue NOW: perform the task yourself with your tools (readFile to inspect, editFile/writeFile to change, then re-read the changed region to verify). Only reply in prose, without tools, if the task genuinely requires no file change.',
        },
      ]).consumeStream();
    } catch {
      // Keep the pass-1 output rather than failing the turn.
    }
    // Cross-turn health demotion only: act-gap repeated through the continuation means this
    // model talks instead of acting — recordOutcome(false) feeds the picker's cooldown so the
    // NEXT Auto turn routes elsewhere (pinned exempt; in-loop answer still ships).
    // Repro ×3 (2026-08-28 12:57–1:29 AM): nemotron-3-ultra-free narrated on every task.
    if (actGap && !reportGap && toolEvents.length === 0 && served.platform && served.model) {
      recordOutcome(served.platform, served.model, false);
      diagLog('engine.actGapDemote', `no tool work after continuation — cooldown for ${served.platform}::${served.model}`);
    }
  }

  // LENGTH-CUT CONTINUATION — the reply hit the output budget mid-generation
  // (`finish_reason: length`, mapped by routerProvider): a wire-level trigger, never quality
  // judgment. The partial answer STANDS (no retract) and this pass appends to the same draft.
  // Repro (2026-08-30 ×2 in one session, Cloudflare @cf/deepseek-ai/deepseek-r1-distill-
  // qwen-32b): reply cut mid-sentence, finish 'length', 2m24s — the distill burned its output
  // budget on think-narration; AI SDK v7 (unlike v4's `continueSteps`) never continues a
  // 'length' step. ONE continuation, placed after the act/report-gap nudge (fires only on
  // 'stop') so the two can never both run — invariant 3.
  if (outcome.finishReason === 'length' && !opts.abortSignal?.aborted) {
    diagLog('engine.lengthContinue', `finish=length (textLen=${outcome.text.length}) — one continuation pass`);
    // Stitch both halves into the shipped reply: onEnd keeps the earlier text only when the
    // newer pass ends silent, but here pass 1's text is half the real answer.
    const partial = outcome.text;
    try {
      await runPass([
        ...modelMessages,
        ...outcome.responseMessages,
        {
          role: 'user',
          content: 'Your previous reply was cut off mid-sentence by the output token limit. Continue from exactly where it stopped. Do not repeat any earlier text, do not restart the answer, and do not mention the cutoff.',
        },
      ]).consumeStream();
      if (outcome.text.trim() && outcome.text !== partial) outcome.text = partial + outcome.text;
    } catch {
      // Keep the partial answer rather than failing the turn.
    }
  }

  // LAST-RESORT reasoning fold: every pass's content channel empty ⇒ promote the accumulated
  // thinking as the reply (repro: gemini-2.5-flash 11:49 PM — 2 files edited correctly, all
  // narration in the thinking channel). A little duplication beats an empty bubble.
  if (!outcome.text.trim() && reasoningText.trim()) {
    diagLog('engine.reasoningFold', `empty reply after all passes — promoting ${reasoningText.length} chars of reasoning as the reply`);
    outcome.text = reasoningText.trim();
  }

  const workMessages = toChatMessages(outcome.responseMessages);
  return {
    text: outcome.text,
    reasoning: reasoningText || undefined,
    finishReason: outcome.finishReason,
    platform: served.platform,
    model: served.model,
    runtimeName: served.runtimeName,
    workMessages,
    changedFiles: changedFilesFrom(workMessages),
  };
}
