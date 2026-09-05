// v3 engine — TierMux is the policy layer; the AI SDK (streamText) is the execution engine.
// This file owns: message conversion, the mode-filtered toolset, permission policy
// (toolApproval), malformed-call self-correction (repairToolCall), compaction (prepareStep),
// the 50-step cap (stopWhen), and AgentResult assembly. Mechanical recovery only — never
// answer-quality judgment (docs/SIMPLE_CORE_RESET_2026-08-24.md).

import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type StopCondition,
  type ToolSet,
  type LanguageModel,
} from 'ai';
import type { ChatMessage, ChatContentBlock, ProposedPlan } from '../../shared/types';
import type { AgentOpts, AgentResult, ToolEvent } from '../agent';
import { createRouterProvider } from './routerProvider';
import { buildV3ToolSet } from './tools/v3';
import { makeRepairViaModelSelfCorrection } from './repair';
import { compactIfNeeded, ageToolOutputs } from './compact';
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

/** UI-facing copy of a tool's result. `tr.output` was dropped entirely until 2026-09-01, so
 *  `ToolEvent.detail` was never populated — with two consequences neither side reported:
 *  the webview's `.tm-tool-card-output` branch (main.ts) is keyed on `detail`, so every
 *  non-edit tool card rendered an EMPTY body behind its "View output" disclosure; and
 *  chatViewProvider's crash-recovery snapshot writes `{ role: 'tool', content: e.detail ?? '' }`,
 *  so a mid-turn extension-host crash recovered the tool CALLS with blank RESULTS.
 *
 *  Capped independently of the model's own limit: the tools already cap what the MODEL sees
 *  (runCommand's MAX_CHARS is 30k), but this copy crosses the webview bridge on every tool call
 *  and then lives in the DOM for the rest of the session. 8k is a quarter of the model's view
 *  and still more than the card's 500px body can show without scrolling. */
const UI_DETAIL_CAP = 8_000;
function toolDetail(output: unknown): string | undefined {
  if (output == null) return undefined;
  const text = typeof output === 'string'
    ? output
    : (() => { try { return JSON.stringify(output, null, 2); } catch { return String(output); } })();
  if (!text.trim()) return undefined;
  return text.length > UI_DETAIL_CAP
    ? `${text.slice(0, UI_DETAIL_CAP)}\n\n[… truncated for display — ${text.length - UI_DETAIL_CAP} more characters]`
    : text;
}

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
/** Plan mode's stop condition. `hasToolCall('exitPlanMode')` stopped the turn on the CALL, so a
 *  plan the tool REJECTED (empty steps, or — once the schema tightened — a missing outcome/
 *  evidence) still ended the turn: the model got no chance to read the error and re-submit, and
 *  the user got a dead turn with no card. Stopping on the accepted RESULT instead keeps the AI
 *  SDK's own repair path open — a `{ error }` output leaves the loop running and the tool error
 *  goes back to the model as the next step's input.
 *
 *  Not answer-quality judgment (SIMPLE_CORE_RESET invariant): this reads the TOOL's own
 *  structural verdict on its input, never the plan's content. */
const planAccepted: StopCondition<ToolSet> = ({ steps }) =>
  (steps.at(-1)?.toolResults ?? []).some(
    (r) => r.toolName === 'exitPlanMode'
      && !(typeof r.output === 'object' && r.output !== null && 'error' in r.output),
  );

export async function runTurn(_router: unknown, opts: AgentOpts): Promise<AgentResult> {
  // Turn-start facts: if signalAborted=true here, no model request can ever run this turn.
  diagLog('engine.start', `mode=${opts.mode} msgs=${opts.messages?.length ?? 0} signalAborted=${opts.abortSignal?.aborted ?? 'none'} requestId=${opts.requestId ?? '-'}`);
  // TTFT instrumentation anchor (tiermux.agent.diagTrace): every stage below logs elapsed
  // ms from here, so a slow "nothing is happening" turn can be attributed — our routing vs
  // the provider's queue+prefill — instead of guessed at.
  const turnT0 = Date.now();
  const modelMessages = toModelMessages(opts.messages);
  // Plan mode's exitPlanMode tool hands its VALIDATED structure here; the turn stops on that
  // call (stopWhen below) and the host renders the plan card straight from this object — no
  // prose classification, no extra model round-trip. Last call wins if a model calls it twice.
  let proposedPlan: ProposedPlan | undefined;
  const tools: ToolSet = buildV3ToolSet(opts.mode, {
    abortSignal: opts.abortSignal,
    sessionId: opts.sessionId,
    requestId: opts.requestId,
    onTodos: opts.onTodos,
    onBeforeWrite: opts.onBeforeWrite,
    onAskUser: opts.onAskUser,
    onPlanProposed: (plan) => { proposedPlan = plan; },
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
      // Fires when the candidate's response SETTLES (routerProvider's reportServed), not at
      // pick time — the pick itself is timed by rp.chain in resolveCandidates. Diag-visible so
      // a "why does the footer name THIS model" question has a timestamp next to the
      // failover walk (see rp.failover logs).
      diagLog('engine.served', `${Date.now() - turnT0}ms into the turn — ${platform}::${mdl} reported as the serving model`);
    },
    onUsage: opts.usageSink
      ? (info) => opts.usageSink?.({ inputTokens: info.inputTokens, outputTokens: info.outputTokens, contextTokens: info.inputTokens, model: info.model })
      : undefined,
  });

  const { repair } = makeRepairViaModelSelfCorrection({ model, signal: opts.abortSignal });
  const policy = policyFromSettings(opts.autoApprove ?? false, opts.mode, opts.sessionId);
  const toolEvents: ToolEvent[] = [];
  let reasoningText = '';
  // ai v7 consumeStream() RESOLVES on stream errors (they go to its onError option) — the
  // try/catch below never sees provider failures; captured here for the post-pass guard.
  let streamError: string | undefined;
  /** consumeStream() RESOLVES on stream errors, so a continuation pass that dies on the wire
   *  (401/429/credit, "all candidates failed") is invisible unless this option catches it.
   *  The pass-1 output already stands, so this only has to make the failure diagnosable. */
  const passError = (tag: string) => (error: unknown) =>
    diagLog(`engine.${tag}StreamError`, (error instanceof Error ? error.message : String(error)).slice(0, 160));
  // True while the current step has streamed reply text but no tool call yet (see onChunk).
  let narrationSinceToolCall = false;
  // Armed for the plan-gap continuation pass only (see the nudge below): its FIRST step must
  // CLOSE the turn with a tool call, turning "please finish" from a prompt hope into a
  // wire-level guarantee. Step 0 only — forcing every step would make a prose answer
  // impossible, and a model that wants one more read afterwards is fine.
  //
  // What it does NOT do any more is dictate WHICH close. It used to pin
  // `toolChoice: {type:'tool', toolName:'exitPlanMode'}`, so a model that had investigated and
  // then hesitated was forced to emit a plan — the only escape hatch was `looksLikeQuestion`,
  // which reads the reply TEXT and therefore misses hesitation expressed as narration. That is
  // exactly the 2026-09-01 repro: "Let me re-read the user's actual words carefully…" is not a
  // question, so the guess would have been compelled. `toolChoice: 'required'` still forbids a
  // third round of narration, while `activeTools` narrows the choice to the two legitimate ways
  // to close a plan-mode turn — present the plan, or ask which plan was wanted.
  let forcePlanToolOnNextStep = false;
  /** The only two tool calls that close a plan-mode turn. askUser does NOT stop the turn (its
   *  answer comes back and the loop continues), which is the point: asking is a way forward,
   *  not a way out. */
  const PLAN_CLOSERS = ['exitPlanMode', 'askUser'];

  let outcome: { finishReason: string; text: string; responseMessages: ModelMessage[] } = {
    finishReason: 'unknown', text: '', responseMessages: [],
  };
  // Which model actually served the turn — surfaced in AgentResult so the host's per-bubble
  // footer shows the real model (failover can switch it mid-turn; the LAST server wins).
  let served: { platform?: string; model?: string; runtimeName?: string } = {};
  /** TTFT instrumentation (tiermux.agent.diagTrace): when the first content delta arrived.
   *  Turn-start latency splits into OUR routing cost (rp.chain's "ms to resolve") vs the
   *  provider's queue+prefill (engine.ttft). */
  let firstDeltaAt: number | undefined;

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
  const runPass = (messages: ModelMessage[]) => {
    // Per-PASS state, reset here rather than declared per-pass so onChunk can close over it.
    // It used to leak: pass 1 ending on text left this true, so the continuation pass's first
    // tool-call chunk fired a SECOND onRetractDraft for a draft the nudge had already
    // retracted. Surfaced by scripts/exitPlanMode.e2e.ts's plan-gap case (retracted=2).
    narrationSinceToolCall = false;
    return streamText({
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
      prepareStep: ({ messages, stepNumber }) => {
        const profile = currentProfile();
        const offer = profile.contextWindow <= SMALL_WINDOW_MAX
          ? Object.keys(tools).filter((t) => !COORDINATION_TOOLS.includes(t))
          : undefined;
        const forcePlan = forcePlanToolOnNextStep && stepNumber === 0;
        // Age FIRST, compact second: aging elides consumed tool output on EVERY step (no
        // budget needed), and compaction then estimates on the aged transcript — a shrunken
        // history crossing its 80% trigger later, or never. The tiermux.agent.toolCompaction
        // setting drives the aging THRESHOLD and nothing else: 'off' skips aging entirely,
        // 'light' stubs earlier outputs over 2,000 chars, 'aggressive' over 800. Both modes
        // treat every tool the same — there is no per-tool head/tail or line-capping here,
        // whatever older copies of the setting's description claimed. Unknown values → light.
        const compactionMode = opts.toolCompaction ?? 'light';
        const aging = compactionMode === 'off'
          ? { stubbedChars: 0 as number, messages: undefined as ModelMessage[] | undefined }
          : ageToolOutputs(messages, compactionMode === 'aggressive' ? 800 : 2_000);
        if (aging.stubbedChars > 0) {
          diagLog('engine.ageToolOutputs', `${aging.stubbedChars.toLocaleString()} chars of earlier tool output elided before step ${stepNumber}`);
        }
        const compaction = compactIfNeeded(aging.messages ?? messages, profile.pruneTarget);
        const stepMessages = compaction.messages ?? aging.messages;
        return {
          ...(stepMessages ? { messages: stepMessages } : {}),
          // forcePlan's activeTools deliberately WINS over the small-window offer: on this one
          // step the turn has to close, and every tool outside PLAN_CLOSERS is a way not to.
          // It is the ONLY toolChoice override here: forcing a tool call to stop a model from
          // narrating is judging output shape, which is what NARRATION_RE was deleted for.
          ...(forcePlan
            ? { activeTools: PLAN_CLOSERS, toolChoice: 'required' as const }
            : offer ? { activeTools: offer } : {}),
        };
      },
      // exitPlanMode IS the end of a plan-mode turn (Claude Code's ExitPlanMode has the same
      // semantics): the plan is now the user's move, so a further step could only narrate the
      // plan a second time into the chat bubble underneath the card. Harmless in agent/ask mode,
      // where the tool isn't offered at all.
      stopWhen: [stepCountIs(50), planAccepted],
      abortSignal: opts.abortSignal,
      maxRetries: 1,

      onChunk: ({ chunk }) => {
        // First streamed delta of the pass — the TTFT number (tiermux.agent.diagTrace).
        // rp.chain's "ms to resolve" is OUR routing cost; the remainder to TTFT is the
        // provider's queue + prompt prefill. Logged once per pass, never per chunk.
        if (firstDeltaAt == null && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call')) {
          firstDeltaAt = Date.now();
          diagLog('engine.ttft', `${firstDeltaAt - turnT0}ms to first delta (${chunk.type})`);
        }
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
            detail: toolDetail(tr.output),
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
  };

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

  // Dead-at-start abort, RESOLVED path (2026-09-05). The catch block above has this exact
  // guard, but an abort almost never reaches it: `consumeStream` RESOLVES rather than
  // rejecting — the same ai v7 behaviour this file already documents for stream errors twice
  // — so Stop within the first second fell straight through to the normal return as a
  // "successful" turn with text: '' and paused: undefined. That is the 0-token mystery
  // placeholder the catch-block guard was written to prevent: a blank assistant bubble, no
  // Continue button, no way to tell "stopped" from "answered with nothing".
  //
  // Caught by scripts/foundation.e2e.ts scenario 7 the moment it moved off the POC loop
  // (docs/AGENT_RELIABILITY_PLAN_2026-09-05.md §4.1) — the POC's runAgent rejected on abort,
  // so the resolved path had never been exercised.
  if (opts.abortSignal?.aborted && !outcome.text.trim() && !reasoningText.trim() && toolEvents.length === 0) {
    diagLog('engine.abortEmpty', 'abort before any output (resolved path) — returning paused:true so the turn stays resumable');
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

  // Stream-error guard: a provider failure consumeStream resolved used to fall through as a
  // "successful" empty turn (0 in/0 out) with the real reason (401/403/429/credit, or "all
  // candidates failed") swallowed — repro 1:18 AM, dead in 1s. Surface it, but only when the
  // turn produced NOTHING; partial output from a later-step failure still ships. A
  // dead-at-start abort returns paused instead (guard above).
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

  // CONTINUATION NUDGE — one continuation when the turn ends without CLOSING
  // (finish 'stop' only). Wire-level signals only, never prose classification:
  //   act-gap    — no tool ran and the reply is empty.
  //   report-gap — tools ran but the synthesis step came back empty (the SDK always
  //     runs a next step after tool calls, so this is an empty synthesis, not an
  //     early loop end).
  //   plan-gap   — plan mode ended without an exitPlanMode call (see below).
  // Deliberately NOT narration matching: guessing "announced the next action instead
  // of taking it" from reply prose is a regex tower — every new phrasing misses it and
  // every widening swallows a real answer. A non-empty synthesis ships as-is; when the
  // model wrote todos, unfinished items surface the host's Continue affordance instead
  // of burning a second model call on a guess.
  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
  const lastUserText = typeof lastUser?.content === 'string' ? lastUser.content : '';
  // The carve-out that keeps plan mode able to ANSWER. It matters more since planGap stopped
  // testing the reply's shape (see below): it is now the only thing standing between an
  // information request and a forced plan. The interrogative list alone was too narrow — a
  // plan-mode "give me an example of plan mode" (2026-09-01 5:09 PM) is plainly a question and
  // matches neither the leading interrogative nor a trailing "?".
  //
  // The additions are deliberately phrases that cannot also be a build request: "give me a dark
  // mode toggle" IS work, so "give me" alone is not enough — it has to be asking for an
  // example, a comparison, or a walkthrough.
  const looksLikeQuestion = !!lastUserText
    && (/\?\s*$/m.test(lastUserText)
      || /^(how|what|why|when|who|which|explain|tell me|describe|review)\b/i.test(lastUserText.trim())
      || /\b(an? example of|examples? of|the difference between|compare\b|walk me through|summar(?:y of|ise|ize))\b/i.test(lastUserText));
  const replyEmpty = outcome.text.trim().length === 0;
  diagLog('engine.turnEnd', `finish=${outcome.finishReason} textLen=${outcome.text.length} steps=${outcome.responseMessages.length} tools=${toolEvents.length} reasoningLen=${reasoningText.length} empty=${replyEmpty}`);
  const didWork = toolEvents.length > 0;
  // Invariant 3 (SIMPLE_CORE_RESET): a turn gets AT MOST ONE continuation pass, whichever
  // trigger fires first. The nudge and the length-cut guard below both run off outcome, and
  // onEnd OVERWRITES outcome.finishReason with the continuation's own — so a nudge pass that
  // is itself cut at the output budget would otherwise fall straight into the length guard
  // (probe: 4 model calls in one turn). This flag is the gate; no ladder.
  let continued = false;
  const actGap = !didWork && replyEmpty;
  const reportGap = didWork && replyEmpty;
  // plan-gap — the SAME unclosed loop, in plan mode: the model investigated and then ended on
  // narration instead of calling exitPlanMode, so the user gets "Now let me check if there's
  // any existing theme support…" and no plan card. The wire-level fact is identical to
  // act/report-gap (finish 'stop', reply empty or narration); what differs is only WHAT
  // closing the turn means — a plan call, not an edit. Not answer-quality judgment: a turn
  // that DID call exitPlanMode is closed by definition and never lands here.
  // Live repro (2026-08-31, 3:06 PM, Ollama/nemotron-3-ultra, "add a dark mode toggle to
  // setting"): 69.5k in / 236 out / 1m2s, ended on "Now let me check if there's any existing
  // theme or dark mode support in the application." — no plan, no card.
  // planGap does NOT test the reply's shape. It used to require `replyEmpty || replyIsNarration`,
  // which is an agent-mode proxy borrowed into a mode where the wire-level fact is simpler and
  // stronger: in plan mode there are exactly THREE legitimate ways to close a turn — a plan
  // (exitPlanMode outcome 'plan'), a finding (outcome 'no-change'), or a prose answer to a
  // question — and the first two are tool calls. No tool call plus a non-question request means
  // the turn is unclosed, whatever the prose looks like.
  //
  // Live repro 2026-09-01 4:33 PM (Kilo/stepfun/step-3.7-flash:free, vendor order-view): the
  // reply was "I found the key line. Let me look at OrderController.php:250 where the products
  // are being loaded…" — unmistakably unclosed, and NARRATION_RE misses it because the stem
  // regex is anchored at the start and the text opens with "I found". Widening that regex would
  // be a tower (the very next reply shape would miss again, and "Let me know if…" is a real
  // ending the close-loop suite guards). Dropping the test is the smaller, truer change.
  //
  // Safe to drop only NOW: before outcome 'no-change' existed, a model whose honest conclusion
  // was "nothing needs changing" had no tool close, so forcing one would have manufactured a
  // plan. It has one now. Genuine Q&A is still carved out by looksLikeQuestion below.
  const planGap = opts.mode === 'plan' && !proposedPlan;
  if (
    (opts.mode === 'agent' || planGap)
    && !opts.abortSignal?.aborted
    && outcome.finishReason === 'stop'
    && !looksLikeQuestion
    && (actGap || reportGap || planGap)
  ) {
    diagLog('engine.applyNudge', `${planGap ? 'plan-gap (no exitPlanMode call)' : reportGap ? 'report-gap (tools ran, empty synthesis)' : 'act-gap (no tools ran, empty reply)'} (textLen=${outcome.text.length}) — continuation pass`);
    // Pass-1 narration triggered the nudge — retract it (repro: nemotron-3-ultra-free 12:57
    // AM, both passes' narration stacked in one bubble); pass 2's text is the sole draft.
    if (outcome.text.trim()) opts.onRetractDraft?.();
    // Wire-level guarantee, not a second prompt: the continuation's first step is FORCED to
    // call one of PLAN_CLOSERS. Pass 1 already gave the model its free chance to answer in
    // prose, and looksLikeQuestion has already excluded genuine Q&A — so "narrate a third time"
    // is the only outcome this removes. It does not remove "I am not sure what you meant":
    // askUser is one of the two allowed calls. Providers that ignore toolChoice fall back to
    // the prose nudge below, which is why both exist.
    forcePlanToolOnNextStep = planGap;
    try {
      await runPass([
        ...modelMessages,
        ...outcome.responseMessages,
        {
          role: 'user',
          content: planGap
            ? 'You stopped mid-investigation without finishing. You cannot edit files in this mode, so you must close this turn with a tool call NOW: either exitPlanMode with the concrete steps for the change the user asked for — using the files you have already read, naming the real paths and the path:line that justifies each step — or, if you are genuinely unsure which of two readings the user meant, askUser with those readings as options. Do not end the turn describing what you are about to look at next, and do not invent steps to fill a plan you are not sure about.'
            : reportGap
              ? 'You ran tools but ended the turn without a final answer. CLOSE the task now: tell the user what you found or changed (with file paths) and the result. If the task is not actually finished, keep working with your tools instead of stopping. Never end a turn silently.'
              : 'You stopped after describing what you would do — no tool ran and no file changed. Continue NOW: perform the task yourself with your tools (readFile to inspect, editFile/writeFile to change, then re-read the changed region to verify). Only reply in prose, without tools, if the task genuinely requires no file change.',
        },
      ]).consumeStream({ onError: passError('nudge') });
    } catch {
      // Keep the pass-1 output rather than failing the turn.
    } finally {
      forcePlanToolOnNextStep = false;
    }
    continued = true;
    // Cross-turn health demotion only: act-gap repeated through the continuation means this
    // model talks instead of acting — recordOutcome(false) feeds the picker's cooldown so the
    // NEXT Auto turn routes elsewhere (pinned exempt; in-loop answer still ships).
    // Repro ×3 (2026-08-28 12:57–1:29 AM): nemotron-3-ultra-free narrated on every task.
    if (!planGap && actGap && !reportGap && toolEvents.length === 0 && served.platform && served.model) {
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
  // 'stop'). `!continued` keeps it to ONE continuation per turn either way — invariant 3: a
  // nudge pass that is itself length-cut ships truncated with finish 'length', which is what
  // the webview's Continue affordance is for.
  if (outcome.finishReason === 'length' && !opts.abortSignal?.aborted && !continued) {
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
      ]).consumeStream({ onError: passError('lengthContinue') });
      // Mechanical de-dup only: a model that ignored "do not restart" and re-emitted the whole
      // answer already CONTAINS the partial, so concatenating would ship it twice.
      const cont = outcome.text;
      if (cont.trim() && cont !== partial && !cont.startsWith(partial)) outcome.text = partial + cont;
    } catch {
      // Keep the partial answer rather than failing the turn.
    }
    continued = true;
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
    ...(proposedPlan ? { plan: proposedPlan } : {}),
  };
}
