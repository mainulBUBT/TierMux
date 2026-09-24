// The agent loop: streamText is the execution engine, this file is the policy around it —
// message conversion, the mode-filtered toolset, toolApproval, repairToolCall, prepareStep
// compaction, stopWhen, and AgentResult assembly. Mechanical recovery only — never
// answer-quality judgment (docs/SIMPLE_CORE_RESET_2026-08-24.md).

import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type StopCondition,
  type ToolSet,
  type LanguageModel,
} from 'ai';
import type { ChatMessage, ChatContentBlock, ProposedPlan, TodoItem } from '../../shared/types';
import type { AgentOpts, AgentResult, ToolEvent } from '../agent';
import { createRouterProvider } from './routerProvider';
import { buildV3ToolSet, READ_ONLY_TOOLS } from './tools/v3';
import { runSubagent } from './subagent';
import { getMcpManager } from './tools/mcp/manager';
import { makeRepairViaModelSelfCorrection } from './repair';
import { compactIfNeeded, ageToolOutputs } from './compact';
import { resolveVerifyCommand, runVerifyCommand } from './tools/workspace/verifyCommand';
import { resolvePolicy, policyFromSettings } from '../../permissions/policy';
import { recordOutcome, findCatalogModel, peekTopModel } from '../../router/picker';
import { resolveExecutionProfile } from '../executionProfile';
import { composeSystemPrompt } from '../../context/system';
import { gatherPromptContext } from '../../context/promptContext';
import { diagLog } from '../../util/diag';
import type { WorkReportData } from '../../shared/workReport';
import { classifyConversation, attachmentKindsFromContent, type TaskKind } from '../routing';
import { contentToString } from '../content';

/** Near-deterministic tool calls; not 0 — greedy decoding sent a free model into a repetition loop (2026-09-06). */
const TOOL_CALL_TEMPERATURE = 0.2;

/** Profile used until the serving model is known (see currentProfile() in runTurn). */
const FALLBACK_PROFILE = resolveExecutionProfile(undefined);

// Withdrawn on small-window models (schema tax). delegateTask stays — on a small window it is
// how exploration is kept OUT of the context. Never a capability tool.
const COORDINATION_TOOLS = ['todoWrite'];
/** At/below this window the schema tax stops being affordable. */
const SMALL_WINDOW_MAX = 16_384;

/** Tool messages kept verbatim per step. Ask and Plan are EXPLORATION: with agent's 3, a turn that
 *  reads four big files round-robin stubs each one before it comes round again and re-reads them
 *  until the repeat guard fires (live repro 2026-09-21, ask mode, ~6 min, no answer). Agent stays at
 *  3 — its edits need exact text and the write guard demands a current copy anyway. */
const EXPLORE_KEEP_RECENT = 10;

/** Ask mode ends with an ANSWER, not a silent pause. The last budgeted step is tool-less and a stuck
 *  turn gets one tool-less continuation — both mechanical (budget arithmetic / the repeat guard's own
 *  signal), neither judges the answer. */
const BUDGET_WRAPUP = 'Step budget used up. Answer the user now from what you have already read — no more tool calls. Cite path:line and say plainly what you could not confirm.';
const STUCK_WRAPUP = 'You keep re-reading the same files without converging. Stop using tools and answer the user\'s question now from what you have already found — cite path:line and say plainly what you could not confirm.';

/** UI-facing copy of a tool's result (ToolEvent.detail) — the tool card's "View output" body
 *  and the crash-recovery snapshot both read it. Capped separately from what the model sees:
 *  this copy crosses the webview bridge on every call and lives in the DOM all session. */
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

/** Test seam: when set, the engine uses this scripted LanguageModelV4 instead of the picker.
 *  Production never sets it. */
let modelOverride: LanguageModel | undefined;
export function __setEngineModelForTests(m: LanguageModel | undefined): void {
  modelOverride = m;
}

/** Plan mode's stop condition: stop on an ACCEPTED exitPlanMode result, not on the call.
 *  Stopping on the call ended the turn even when the tool rejected the plan, so the model
 *  never saw the error and the user got a dead turn with no card. Reads the tool's structural
 *  verdict only, never the plan's content. */
const planAccepted: StopCondition<ToolSet> = ({ steps }) =>
  (steps.at(-1)?.toolResults ?? []).some(
    (r) => r.toolName === 'exitPlanMode'
      && !(typeof r.output === 'object' && r.output !== null && 'error' in r.output),
  );

/** Default step cap. `tiermux.agent.maxStepsPerTurn` overrides it — the setting has existed
 *  and been documented since v3 while the engine hardcoded 50, so changing it did nothing. */
const DEFAULT_MAX_STEPS = 50;

/** Todos this turn declared complete get ONE evidence check, then at most one fix pass — the
 *  same bounded shape as the verify gate, and for the same reason: the user should not have to
 *  re-check the agent's own "done". Only fires on turns that used todoWrite. */
const DEFAULT_AUDIT_TODOS = true;

/** Fix-and-recheck rounds after the verify command fails. `tiermux.agent.verifyFixRounds`
 *  overrides it. 0 disables the retry (the failure is reported as-is), never the gate.
 *  2 → 1 on 2026-09-06: each round is a full model call over the whole transcript, and on free
 *  tiers a second one rarely fixed what the first did not — it just doubled the wait. */
const DEFAULT_VERIFY_FIX_ROUNDS = 1;

/** Identical failing tool call this many times IN A ROW ⇒ not progressing. Three, not two: one
 *  legitimate retry after a re-read is still a decision; a third identical failure is not. */
const REPEAT_FAILURE_LIMIT = 3;
/** Identical read-only call this many times in a turn ⇒ a loop; the turn pauses. The second and
 *  later copies never re-run — the cached result comes back with a note. Live repro 2026-09-06:
 *  grep "distance" 15×, readFile of the same file 8×, three minutes, no answer. */
const REPEAT_READ_LIMIT = 4;

/** Read-only tools wrapped so an identical call returns the earlier result instead of re-running.
 *  Wire-level (same name, same input bytes) — never a judgment about what the model should do.
 *  A read is a repeat only while NOTHING has changed: any non-read tool clears the cache, because
 *  re-reading a file the turn just edited is the opposite of a loop. Without that, a read after an
 *  edit was answered with the model's own pre-edit content plus "the result is unchanged" — so the
 *  edit looked reverted and the model redid it (live repro 2026-09-16: a blade fix that "undid"
 *  itself for 24 minutes). */
function dedupeReads(tools: ToolSet, onRepeat: (signature: string, count: number) => void): ToolSet {
  const seen = new Map<string, { result: unknown; count: number }>();
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    const exec = (t as { execute?: (input: unknown, o: unknown) => Promise<unknown> }).execute;
    if (!exec) { out[name] = t; continue; }
    if (!READ_ONLY_TOOLS.has(name)) {
      out[name] = {
        ...t,
        execute: async (input: unknown, o: unknown) => {
          try { return await exec(input, o); } finally { seen.clear(); }
        },
      } as ToolSet[string];
      continue;
    }
    out[name] = {
      ...t,
      execute: async (input: unknown, o: unknown) => {
        const sig = `${name}:${JSON.stringify(input ?? null)}`;
        const prior = seen.get(sig);
        if (prior) {
          prior.count++;
          onRepeat(sig, prior.count);
          // The content comes back EVERY time, not just on the second copy. ageToolOutputs elides
          // an older tool result with "Re-run the tool … to see it again", so withholding it here
          // told the model to re-run and then refused to answer — it went blind on a file it had
          // read and looped until the stuck guard cut the turn (live repro 2026-09-16).
          const note = `[Identical ${name} call #${prior.count} this turn — served from this turn's cache, not re-run.]`;
          return typeof prior.result === 'string' ? `${note}\n${prior.result}` : prior.result;
        }
        const result = await exec(input, o);
        seen.set(sig, { result, count: 1 });
        return result;
      },
    } as ToolSet[string];
  }
  return out;
}

/** True when a tool RESULT is a failure — either the SDK's tool-error state or the v3
 *  contract's `{ error }` return, which the SDK reports as an ordinary json result. */
function isFailureOutput(output: unknown): boolean {
  if (typeof output !== 'object' || output === null) return false;
  const o = output as { type?: unknown; value?: unknown };
  if (o.type === 'error-text' || o.type === 'error-json') return true;
  const v = o.type === 'json' || o.type === 'text' ? o.value : output;
  return typeof v === 'object' && v !== null && 'error' in (v as Record<string, unknown>);
}

export async function runTurn(_router: unknown, opts: AgentOpts): Promise<AgentResult> {
  // Turn-start facts: if signalAborted=true here, no model request can ever run this turn.
  diagLog('engine.start', `mode=${opts.mode} msgs=${opts.messages?.length ?? 0} signalAborted=${opts.abortSignal?.aborted ?? 'none'} requestId=${opts.requestId ?? '-'}`);
  // diagTrace anchor: every stage below logs elapsed ms from here.
  const turnT0 = Date.now();
  /** diagTrace: prepareStep timestamps so onStepEnd can log each step's wall-clock — the one
   *  number that localizes a slow turn (model step vs tool execution is the next split). */
  const stepStartAt = new Map<number, number>();
  // WorkReportData.telemetry — accumulated across EVERY model call this turn makes
  // (continuations and verify-fix rounds included).
  let usageIn = 0;
  let usageOut = 0;
  let lastContextTokens = 0;
  let failovers = 0;
  /** 1 for the initial pass, 2 for the one continuation — forwarded with each usage event so the
   *  host can label which pass a model answered in. Mechanical: set in runPass, never judged. */
  let turnPass = 0;
  const modelMessages = toModelMessages(opts.messages);
  // Classified here, once per turn — the picker sees no messages and would route everything as chat.
  const userTurns = opts.messages.filter((m) => m.role === 'user');
  const latestUserContent = userTurns[userTurns.length - 1]?.content;
  const latestKinds = latestUserContent !== undefined ? attachmentKindsFromContent(latestUserContent) : [];
  const taskKind: TaskKind = (opts.taskKind as TaskKind | undefined) ?? classifyConversation(
    userTurns.map((m) => contentToString(m.content)),
    {
      mentions: opts.mentionCount,
      auto: !opts.pinnedModel || opts.pinnedModel === 'auto',
      attachmentKinds: latestKinds,
      attachments: latestKinds.length,
    },
  ).kind;
  diagLog('engine.taskKind', taskKind);
  // exitPlanMode's validated structure; the host renders the plan card from it. Last call wins.
  let proposedPlan: ProposedPlan | undefined;
  /** The signature that tripped REPEAT_FAILURE_LIMIT or REPEAT_READ_LIMIT — the stop condition's trigger. */
  let stuckSignature: string | undefined;
  /** The task list as it stands: inherited on a Continue, replaced by each todoWrite. Drives
   *  the audit gate and the caller's remaining-items note. */
  let lastTodos: TodoItem[] | undefined = opts.todos;
  const tools: ToolSet = dedupeReads(buildV3ToolSet(opts.mode, {
    abortSignal: opts.abortSignal,
    sessionId: opts.sessionId,
    requestId: opts.requestId,
    onTodos: (todos) => { lastTodos = todos; opts.onTodos(todos); },
    onBeforeWrite: opts.onBeforeWrite,
    onAskUser: opts.onAskUser,
    onPlanProposed: (plan) => { proposedPlan = plan; },
  }) as ToolSet, (sig, count) => {
    if (count >= REPEAT_READ_LIMIT && !stuckSignature) {
      stuckSignature = sig;
      diagLog('engine.stuck', `${sig.slice(0, 80)} repeated ${count}× — stopping the turn (resumable)`);
    }
  });

  const model: LanguageModel = modelOverride ?? createRouterProvider({
    effort: opts.effort,
    taskKind,
    pinnedModel: opts.pinnedModel,
    sessionId: opts.sessionId,
    excludeModels: opts.excludeModels,
    requireTools: true, // the engine always offers tools — non-tool models would deflect
    // Attachment capability from the SAME kinds that produced the taskKind above. A scanned PDF
    // reaches here as `image` kinds (the webview renders page images), so a surviving `pdf`
    // means a raw file block, which only a carriesRawPdf provider forwards.
    requireVision: latestKinds.some((k) => k === 'image' || k === 'pdf'),
    requireRawPdf: latestKinds.includes('pdf'),
    onFailover: (...args: Parameters<NonNullable<typeof opts.onFailover>>) => {
      failovers++;
      opts.onFailover?.(...args);
    },
    onSelectionRationale: opts.onSelectionRationale,
    onModelSelected: (platform, mdl, runtimeName) => {
      served = { platform, model: mdl, runtimeName };
      opts.onModel(platform, mdl, runtimeName);
      // Fires when the candidate's response SETTLES (routerProvider's reportServed), not at
      // pick time.
      diagLog('engine.served', `${Date.now() - turnT0}ms into the turn — ${platform}::${mdl} reported as the serving model`);
    },
    // Accumulate here as well as forwarding: the host's sink is session-wide accounting, the
    // work report needs this turn's.
    onUsage: (info) => {
      usageIn += info.inputTokens || 0;
      usageOut += info.outputTokens || 0;
      lastContextTokens = info.inputTokens || lastContextTokens;
      opts.usageSink?.({ inputTokens: info.inputTokens, outputTokens: info.outputTokens, contextTokens: info.inputTokens, model: info.model, pass: turnPass });
    },
  });

  const { repair } = makeRepairViaModelSelfCorrection({ model, signal: opts.abortSignal });
  const policy = policyFromSettings(opts.autoApprove ?? false, opts.mode, opts.sessionId);
  const toolEvents: ToolEvent[] = [];
  let reasoningText = '';
  // ── Turn-level stop bookkeeping. Both facts are wire-level (a step count; identical bytes
  // in / error out N times), not answer judgment. Without them a cut turn and a finished turn
  // looked identical: no `paused`, no Continue button.
  // 0 means "no limit" (documented in package.json) — Math.max(1, 0) used to silently invert
  // that into the most restrictive setting (stop after step 1) instead of turning the cap off.
  const rawMaxSteps = opts.maxStepsPerTurn ?? DEFAULT_MAX_STEPS;
  const maxSteps = rawMaxSteps === 0 ? Infinity : Math.max(1, rawMaxSteps);
  /** Set when the step cap cut the turn while the model was still calling tools. */
  let hitStepCap = false;
  /** `toolName+input` → consecutive failure count, turn-scoped across continuation passes. */
  const failureCounts = new Map<string, number>();
  const notMakingProgress: StopCondition<ToolSet> = () => stuckSignature !== undefined;
  // ai v7 consumeStream() RESOLVES on stream errors (they go to its onError option) — the
  // try/catch below never sees provider failures; captured here for the post-pass guard.
  let streamError: string | undefined;
  /** consumeStream() RESOLVES on stream errors, so a continuation pass that dies on the wire
   *  is invisible unless this option catches it. */
  const passError = (tag: string) => (error: unknown) =>
    diagLog(`engine.${tag}StreamError`, (error instanceof Error ? error.message : String(error)).slice(0, 160));
  // True while the current step has streamed reply text but no tool call yet (see onChunk).
  let narrationSinceToolCall = false;
  // Armed for the plan-gap continuation only: step 0 must close the turn with a tool call
  // (toolChoice 'required' + PLAN_CLOSERS). Does not pin WHICH closer — pinning exitPlanMode
  // forced a plan out of a hesitating model (2026-09-01); askUser is the other legitimate close.
  let forcePlanToolOnNextStep = false;
  // Armed for the ask-mode stuck wrap-up: step 0 must answer in prose (toolChoice 'none').
  let forceAnswerOnNextStep = false;
  /** The only two tool calls that close a plan-mode turn. askUser does not stop the turn — its
   *  answer comes back and the loop continues. */
  const PLAN_CLOSERS = ['exitPlanMode', 'askUser'];

  let outcome: { finishReason: string; text: string; responseMessages: ModelMessage[] } = {
    finishReason: 'unknown', text: '', responseMessages: [],
  };
  // Which model actually served the turn — surfaced in AgentResult so the host's per-bubble
  // footer shows the real model (failover can switch it mid-turn; the LAST server wins).
  let served: { platform?: string; model?: string; runtimeName?: string } = {};
  /** diagTrace: when the first content delta arrived (TTFT). */
  let firstDeltaAt: number | undefined;

  // Auto's step 0 has no serving model yet. Compacting it against FALLBACK_PROFILE's 32k pruned
  // a long session's history before a 1M-window model ever saw it, and the prune is sticky for
  // the turn (compact.ts) — so budget step 0 against the model the picker is about to try.
  const autoHead = !modelOverride && (!opts.pinnedModel || opts.pinnedModel === 'auto')
    ? await peekTopModel(taskKind)
    : undefined;

  /** Serving model's ExecutionProfile, resolved per step. onModelSelected fires at step END,
   *  so step 0 falls back (pinned model → explicit lookup; Auto → the picker's head; else
   *  FALLBACK_PROFILE). */
  const currentProfile = () => {
    let meta = served.platform && served.model
      ? findCatalogModel(served.platform, served.model)
      : undefined;
    if (!meta && opts.pinnedModel?.includes('::')) {
      const [platform, ...rest] = opts.pinnedModel.split('::');
      meta = findCatalogModel(platform, rest.join('::'));
    }
    meta ??= autoHead;
    return meta ? resolveExecutionProfile(meta) : FALLBACK_PROFILE;
  };

  // System prompt + context gathered ONCE per turn: both passes share the identical prefix
  // (provider prompt-cache friendly) and the async reads never happen per-pass.
  const sessionFilesBlock = await opts.sessionFiles?.().catch(() => undefined);
  const system = composeSystemPrompt(opts.mode, await gatherPromptContext(), opts.todos,
    opts.mode === 'agent' ? getMcpManager()?.instructions() : undefined)
    + (sessionFilesBlock ? `\n\n${sessionFilesBlock}` : '');
  const runPass = (messages: ModelMessage[]) => {
    turnPass++;
    // Per-PASS state, reset here so onChunk can close over it. Leaking it across passes fired
    // a second onRetractDraft for an already-retracted draft (exitPlanMode.e2e plan-gap case).
    narrationSinceToolCall = false;
    // The onStep seam (host → webview status label) was wired end-to-end but never fired, so
    // the status line sat on the send-time activity verb for the whole turn. A pass that
    // follows tool results is synthesizing; the first pass is thinking. The phase string is
    // the host's ('thinking' | 'synthesizing'); the label is what the webview shows.
    opts.onStep(
      toolEvents.length ? 'synthesizing' : 'thinking',
      turnPass > 1 ? `Continuing (pass ${turnPass})…` : toolEvents.length ? 'Writing the reply…' : 'Thinking…',
    );
    return streamText({
      model,
      system,
      messages,
      tools,
      temperature: TOOL_CALL_TEMPERATURE,

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
        stepStartAt.set(stepNumber, Date.now());
        const profile = currentProfile();
        const offer = profile.contextWindow <= SMALL_WINDOW_MAX
          ? Object.keys(tools).filter((t) => !COORDINATION_TOOLS.includes(t))
          : undefined;
        const forcePlan = forcePlanToolOnNextStep && stepNumber === 0;
        const forceAnswer = forceAnswerOnNextStep && stepNumber === 0;
        // Ask mode's last budgeted step: no tools, write the answer (unlimited budgets never reach it).
        const budgetWrapUp = opts.mode === 'ask' && Number.isFinite(maxSteps) && maxSteps > 1 && stepNumber === maxSteps - 1;
        // Age FIRST (every step, no budget needed), then compact against the aged transcript.
        // tiermux.agent.toolCompaction sets only the aging threshold: 'off', 'light' (2,000
        // chars), 'aggressive' (800). Unknown values → light.
        const compactionMode = opts.toolCompaction ?? 'light';
        const aging = compactionMode === 'off'
          ? { stubbedChars: 0 as number, messages: undefined as ModelMessage[] | undefined }
          : ageToolOutputs(messages, compactionMode === 'aggressive' ? 800 : 2_000, opts.mode === 'agent' ? undefined : EXPLORE_KEEP_RECENT);
        if (aging.stubbedChars > 0) {
          diagLog('engine.ageToolOutputs', `${aging.stubbedChars.toLocaleString()} chars of earlier tool output elided before step ${stepNumber}`);
        }
        const compaction = compactIfNeeded(aging.messages ?? messages, profile.pruneTarget);
        const stepMessages = compaction.messages ?? aging.messages;
        if (budgetWrapUp) {
          return {
            messages: [...(stepMessages ?? messages), { role: 'user' as const, content: BUDGET_WRAPUP }],
            toolChoice: 'none' as const,
          };
        }
        return {
          ...(stepMessages ? { messages: stepMessages } : {}),
          ...(forceAnswer ? { toolChoice: 'none' as const } : {}),
          // forcePlan's activeTools wins over the small-window offer: on this one step the turn
          // has to close, and every tool outside PLAN_CLOSERS is a way not to.
          ...(forcePlan
            ? { activeTools: PLAN_CLOSERS, toolChoice: 'required' as const }
            : offer ? { activeTools: offer } : {}),
        };
      },
      // planAccepted: an accepted plan is the end of a plan-mode turn — a further step could
      // only narrate it a second time under the card. notMakingProgress reads the counter
      // onStepEnd fills below. Both are StopConditions, not aborts: the SDK finishes the step
      // cleanly and the turn returns paused/resumable like the step cap does.
      stopWhen: [stepCountIs(maxSteps), planAccepted, notMakingProgress],
      abortSignal: opts.abortSignal,
      maxRetries: 1,

      onChunk: ({ chunk }) => {
        // First streamed delta of the pass — the TTFT number (diagTrace). Logged once per pass.
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
        // Per-step wall-clock (diagTrace): the split that localizes a slow turn — this one
        // number per step, plus rp.ttft's per-candidate first-chunk times in routerProvider.
        const started = stepStartAt.get(step.stepNumber);
        if (started !== undefined) {
          diagLog('engine.step', `step ${step.stepNumber} took ${Date.now() - started}ms`
            + ` (${(step.toolCalls?.length ?? 0)} tool call${(step.toolCalls?.length ?? 0) === 1 ? '' : 's'}, ${Date.now() - turnT0}ms into the turn)`);
        }
        for (const tc of step.toolCalls ?? []) {
          const ev: ToolEvent = { toolCallId: tc.toolCallId, name: tc.toolName, args: tc.input, state: 'running' };
          toolEvents.push(ev);
          opts.onTool(ev);
        }
        const errorParts = (step.content as Array<
          { type?: string; toolCallId?: string; toolName?: string; input?: unknown; error?: unknown }
        >).filter((p) => p.type === 'tool-error' && p.toolCallId);
        const failed = new Set(errorParts.map((p) => p.toolName).filter((n): n is string => !!n));
        for (const ep of errorParts) {
          // A 'tool-error' part (e.g. args the SDK couldn't repair, see repair.ts) never appears
          // in step.toolResults — the SDK excludes it there — so without this its 'running' event
          // (posted above, from step.toolCalls) never gets a matching 'done'/'error', and the
          // webview's step card is stuck showing a spinner forever even though the turn finishes
          // and ships an answer (repro 2026-09-19: a malformed runCommand call left "Running …"
          // frozen while later steps and the final answer rendered normally).
          const ev: ToolEvent = {
            toolCallId: ep.toolCallId as string,
            name: ep.toolName ?? 'unknown',
            args: ep.input,
            state: 'error',
            detail: toolDetail(ep.error instanceof Error ? ep.error.message : ep.error),
          };
          toolEvents.push(ev);
          opts.onTool(ev);
        }
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

          // No-progress counting: identical bytes in + error out, REPEAT_FAILURE_LIMIT times IN A
          // ROW; the tool's reason is never read. ANY success clears the WHOLE table (foundation
          // 27b). A fail/succeed/fail alternation never trips this — the step cap is the backstop.
          const signature = `${tr.toolName}:${JSON.stringify(tr.input ?? null)}`;
          if (!isFailed && !isFailureOutput(tr.output)) {
            failureCounts.clear();
            continue;
          }
          const n = (failureCounts.get(signature) ?? 0) + 1;
          failureCounts.set(signature, n);
          if (n >= REPEAT_FAILURE_LIMIT && !stuckSignature) {
            stuckSignature = signature;
            diagLog('engine.stuck', `${tr.toolName} failed ${n}× with identical input — stopping the turn (resumable)`);
          }
        }
      },

      onError: ({ error }) => {
        // streamText's onError does NOT fire for MID-STREAM model failures in ai v7 (the real
        // capture for those is consumeStream's onError below) — but it IS where a doStream
        // SETUP rejection lands, e.g. resolveCandidates' "Pinned model X could not run: …".
        // That error used to be only diagLogged and the turn shipped as an empty 'unknown'
        // "success" (repro 2026-09-05 22:50, pinned Experiential Labs/qwen3.8-27b,
        // supportsTools=false → silent "No model request completed this turn" bubble). Capture
        // it into streamError so the existing post-pass guard fails the turn with the reason.
        streamError = error instanceof Error ? error.message : String(error);
        diagLog('engine.error', streamError.slice(0, 160));
      },

      onEnd: ({ steps, finishReason }) => {
        // V4 finishReason is an OBJECT ({unified, raw}) — String() gave "[object Object]" and
        // silently disabled every finish-based recovery. Use the unified string.
        const fr = typeof finishReason === 'string'
          ? finishReason
          : ((finishReason as { unified?: string } | undefined)?.unified ?? 'unknown');
        // Last NON-empty step text, not steps.at(-1): a reasoning model can emit text + a tool
        // call, then a silent step (gpt-oss-120b: 270 out tokens discarded at settle).
        // Cap hit WHILE still calling tools ⇒ cut, not finished. A final answer landing exactly
        // on step `maxSteps` also satisfies stepCountIs, and that turn IS complete.
        if (steps.length >= maxSteps && (steps.at(-1)?.toolCalls?.length ?? 0) > 0) {
          hitStepCap = true;
          diagLog('engine.stepCap', `stopped at the ${maxSteps}-step cap with tool calls still in flight — turn is resumable`);
        }
        const passText = [...steps].reverse().find((s) => s.text?.trim())?.text ?? '';
        outcome = {
          finishReason: fr,
          text: passText || outcome.text,
          responseMessages: [...outcome.responseMessages, ...steps.flatMap((s) => s.response.messages)],
        };
      },
    });
  };

  /** A post-answer fix pass (verify/audit) replaces outcome.text in onEnd — keep the turn's own
   *  summary in front of the fix note so the reply still says what was done. */
  const keepSummary = (prior: string) => {
    const next = outcome.text;
    if (prior.trim() && next.trim() && next !== prior && !next.startsWith(prior)) outcome.text = `${prior}\n\n${next}`;
  };

  try {
    await runPass(modelMessages).consumeStream({
      // ai v7: consumeStream resolves even when the provider stream errors — this option is the
      // ONLY place the failure is reported.
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

  // Dead-at-start abort, RESOLVED path: consumeStream resolves on abort (ai v7), so the catch
  // block's guard never ran and Stop within the first second returned a "successful" blank
  // turn with no Continue button (foundation scenario 7).
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

  // Stream-error guard: a provider failure consumeStream resolved used to ship as a "successful"
  // empty turn with the real reason swallowed (repro 1:18 AM, dead in 1s). Surfaced only when the
  // turn produced NOTHING; partial output from a later-step failure still ships.
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

  // CONTINUATION NUDGE — ONE continuation when the turn ends without closing, on wire-level
  // signals only: act-gap (no tool, empty reply), report-gap (tools ran, empty synthesis),
  // plan-gap (plan mode ended without exitPlanMode). Unfinished todos go to the host's Continue
  // button, never a second model call on a guess.
  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
  const lastUserText = typeof lastUser?.content === 'string' ? lastUser.content : '';
  // The carve-out that keeps plan mode able to ANSWER a question instead of being forced into
  // a plan. Interrogatives, a trailing "?", and phrases that cannot be a build request ("give me
  // an example of…", 2026-09-01) — "give me" alone IS work ("give me a dark mode toggle").
  const looksLikeQuestion = !!lastUserText
    && (/\?\s*$/m.test(lastUserText)
      || /^(how|what|why|when|who|which|explain|tell me|describe|review)\b/i.test(lastUserText.trim())
      || /\b(an? example of|examples? of|the difference between|compare\b|walk me through|summar(?:y of|ise|ize))\b/i.test(lastUserText));
  const replyEmpty = outcome.text.trim().length === 0;
  diagLog('engine.turnEnd', `finish=${outcome.finishReason} textLen=${outcome.text.length} steps=${outcome.responseMessages.length} tools=${toolEvents.length} reasoningLen=${reasoningText.length} empty=${replyEmpty}`);
  const didWork = toolEvents.length > 0;
  // SIMPLE_CORE_RESET invariant 3: AT MOST ONE continuation pass per turn, whichever trigger
  // fires first. Without this flag a nudge pass cut at the output budget fell into the length
  // guard too (probe: 4 model calls in one turn).
  let continued = false;
  const actGap = !didWork && replyEmpty;
  const reportGap = didWork && replyEmpty;
  // plan-gap — plan mode ended on narration instead of a tool call (2026-08-31 nemotron-3-ultra;
  // 2026-09-01 step-3.7-flash). The only legitimate closes are a plan, a no-change finding
  // (both tool calls) or a prose answer to a question, so no tool call + non-question = unclosed.
  // The reply's shape is deliberately NOT tested — a narration regex was a tower.
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
    // The continuation's first step is FORCED to call one of PLAN_CLOSERS — "narrate a third
    // time" is the only outcome this removes; askUser stays available. A provider that ignores
    // toolChoice makes the SDK raise ToolChoiceViolationError on that step: the turn still ships the
    // second narration, is not failed, and reports finishReason 'error' (nothing reads it).
    // Pinned by exitPlanMode.e2e.ts 4d.
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
    // act-gap repeated through the continuation ⇒ this model talks instead of acting;
    // recordOutcome(false) feeds the picker's cooldown so the NEXT Auto turn routes elsewhere
    // (pinned exempt). Repro ×3, 2026-08-28: nemotron-3-ultra-free narrated on every task.
    if (!planGap && actGap && !reportGap && toolEvents.length === 0 && served.platform && served.model) {
      recordOutcome(served.platform, served.model, false);
      diagLog('engine.actGapDemote', `no tool work after continuation — cooldown for ${served.platform}::${served.model}`);
    }
  }

  // STUCK WRAP-UP (ask mode) — the repeat guard cut the turn with tool calls still in flight, so no
  // answer exists. ONE tool-less continuation asks for it from what was already read (live repro
  // 2026-09-21: ~6 min of re-reads, then nothing). Same at-most-one rule as the other triggers;
  // the turn still reports stopReason 'stuck', so Continue stays available.
  if (opts.mode === 'ask' && stuckSignature && !continued && !opts.abortSignal?.aborted && outcome.text.trim().length === 0) {
    diagLog('engine.stuckWrapUp', `ask turn stuck on ${stuckSignature.slice(0, 60)} with no answer — one tool-less continuation`);
    forceAnswerOnNextStep = true;
    try {
      await runPass([
        ...modelMessages,
        ...outcome.responseMessages,
        { role: 'user', content: STUCK_WRAPUP },
      ]).consumeStream({ onError: passError('stuckWrapUp') });
    } catch {
      // Keep the paused turn rather than failing it.
    } finally {
      forceAnswerOnNextStep = false;
    }
    continued = true;
  }

  // LENGTH-CUT CONTINUATION — finish 'length' (the reply hit the output budget mid-sentence;
  // 2026-08-30 ×2, deepseek-r1-distill-qwen-32b). The partial answer stands and this pass
  // appends to the same draft. ai v7 never continues a 'length' step on its own. ONE
  // continuation per turn (`!continued`); a nudge pass that is itself cut ships truncated.
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

  // ── VERIFY GATE — runs the user's own verify command (manifest or setting) after a turn
  // that mutated files, and reacts to a real exit code: mechanical, not answer judgment.
  // Bounded: agent mode only, at most `verifyFixRounds` extra model calls, skipped on abort;
  // a command that cannot run (`ok: null`) is "no signal", never a failure.
  let verifyOutcome: AgentResult['verifyOutcome'];
  let verifyCmd: string | undefined;
  let verifyAvailable = false;
  let fixRounds = 0;
  const mutated = changedFilesFrom(toChatMessages(outcome.responseMessages));
  if (opts.mode === 'agent' && mutated.length > 0 && !opts.abortSignal?.aborted && !stuckSignature) {
    verifyCmd = resolveVerifyCommand();
    verifyAvailable = !!verifyCmd;
    if (!verifyCmd) {
      // Nothing detectable and nothing configured: the turn is unverified as a property of the
      // PROJECT, not of the work. The report says so quietly rather than flagging it.
      verifyOutcome = 'unverified';
      diagLog('engine.verify', `${mutated.length} file(s) changed but no verify command — unverified`);
    } else {
      const maxFixRounds = Math.max(0, opts.verifyFixRounds ?? DEFAULT_VERIFY_FIX_ROUNDS);
      let run = await runVerifyCommand(verifyCmd);
      diagLog('engine.verify', `\`${verifyCmd}\` → ${run.ok === null ? 'could not run' : run.ok ? 'passed' : 'FAILED'}`);
      while (run.ok === false && fixRounds < maxFixRounds && !opts.abortSignal?.aborted) {
        fixRounds++;
        diagLog('engine.verifyFix', `round ${fixRounds}/${maxFixRounds} — feeding the failure back`);
        const beforeFix = outcome.text;
        try {
          await runPass([
            ...modelMessages,
            ...outcome.responseMessages,
            {
              role: 'user',
              // TRY FIRST, EXPLAIN LAST (2026-09-17, user direction): the old text offered
              // "if it is unrelated, say so and stop" on EVERY round, so round 1 could be spent
              // writing an excuse instead of attempting the fix — and the excuse then arrived
              // twice, once here and once in the report card. Only the final round asks for the
              // one-sentence verdict. `fixRounds`/`maxFixRounds` are the loop's own counters, so
              // this stays mechanical: no judging of what the model wrote.
              content: fixRounds < maxFixRounds
                ? `The verify command \`${verifyCmd}\` failed after your changes. Fix it, then stop — `
                  + 'it is re-run automatically. Do not revert your work, do not re-run the command yourself, '
                  + `and do not explain the failure yet.\n\nOutput:\n${run.output.slice(0, 6_000)}`
                : `The verify command \`${verifyCmd}\` still fails and this is the last attempt. If you can fix it, do so. `
                  + 'Otherwise reply with ONE sentence saying why it still fails — no preamble, no restating what you changed, '
                  + `no advice. Do not revert your work and do not re-run the command yourself.\n\nOutput:\n${run.output.slice(0, 6_000)}`,
            },
          ]).consumeStream({ onError: passError('verifyFix') });
        } catch {
          break; // a failed fix round must not lose the turn's real work
        }
        keepSummary(beforeFix);
        run = await runVerifyCommand(verifyCmd);
        diagLog('engine.verify', `after fix round ${fixRounds}: ${run.ok === null ? 'could not run' : run.ok ? 'passed' : 'still failing'}`);
      }
      verifyOutcome = run.ok === true ? 'passed' : run.ok === false ? 'failed' : 'unverified';
    }
  }

  // ── TODO AUDIT — the turn said some todos are done; check the workspace, not the claim.
  // Bounded exactly like the verify gate: agent mode, only when todoWrite ran, one read-only
  // sub-agent, at most one fix pass, skipped on abort or a stuck stop.
  let auditOutcome: AgentResult['auditOutcome'];
  const completedTodos = (lastTodos ?? []).filter((t) => t.status === 'completed');
  if ((opts.auditTodos ?? DEFAULT_AUDIT_TODOS) && opts.mode === 'agent' && completedTodos.length > 0
    && !opts.abortSignal?.aborted && !stuckSignature) {
    try {
      const list = completedTodos.map((t, i) => `${i + 1}. ${t.content}`).join('\n');
      const audit = await runSubagent({
        task: `These todos were just marked complete. Verify each against the workspace as it is now.\n\n${list}`,
        agent: 'audit',
        sessionId: opts.sessionId,
        requestId: opts.requestId,
        abortSignal: opts.abortSignal,
      });
      const verdict = audit.summary.trim();
      const firstLine = verdict.replace(/^[*#_\s\-]+/, '');
      const incomplete = /^INCOMPLETE\b/i.test(firstLine);
      auditOutcome = incomplete ? 'incomplete' : 'verified';
      diagLog('engine.audit', `${completedTodos.length} completed todo(s) → ${auditOutcome}`);
      if (incomplete && !opts.abortSignal?.aborted) {
        const beforeAudit = outcome.text;
        await runPass([
          ...modelMessages,
          ...outcome.responseMessages,
          {
            role: 'user',
            content: 'A read-only check of the workspace could not find evidence for work you marked complete. '
              + 'Finish it now, or — if the check is wrong and the work IS there — say where in one line and stop. '
              + `Do not restart the task or re-plan.\n\n${verdict.slice(0, 2_000)}`,
          },
        ]).consumeStream({ onError: passError('auditFix') });
        keepSummary(beforeAudit);
      }
    } catch {
      // The audit is best-effort: it must never lose the turn's real work.
    }
  }

  const workMessages = toChatMessages(outcome.responseMessages);
  // A turn cut by the step cap or by no-progress is NOT finished: `paused` shows the Continue
  // button and stopReason names the stop. `stuck` outranks `budget` (the more specific fact).
  const stopReason = stuckSignature ? 'stuck' as const : hitStepCap ? 'budget' as const : undefined;

  // ── WORK REPORT — emitted only for turns that CHANGED something; a card saying "0 files,
  // unverified" is worse than no card.
  const changedFiles = changedFilesFrom(workMessages);
  const workReport = changedFiles.length > 0 ? {
    version: 1 as const,
    // 'unverified' splits in two for the user: 'changes-only' when the project has no verify
    // command at all, 'unverified' when one exists but produced no signal.
    verifyOutcome: verifyOutcome === 'passed' ? 'verified' as const
      : verifyOutcome === 'failed' ? 'failed' as const
      : verifyAvailable ? 'unverified' as const : 'changes-only' as const,
    verifyAvailable,
    ...(verifyCmd ? { verifyCmd } : {}),
    fixRounds,
    ...(auditOutcome ? { auditOutcome } : {}),
    changedFiles: changedFiles.map((f) => ({
      path: f.path,
      status: (f.status === 'created' ? 'A' : f.status === 'deleted' ? 'D' : 'M') as 'A' | 'M' | 'D',
    })),
    toolTally: [...toolEvents.reduce((m, e) => (
      e.state === 'done' || e.state === 'error' ? m.set(e.name, (m.get(e.name) ?? 0) + 1) : m
    ), new Map<string, number>())].map(([name, count]) => ({ name, count })),
    stopReason: stopReason ?? outcome.finishReason,
    telemetry: {
      model: served.platform && served.model ? `${served.platform}/${served.model}` : 'unknown',
      taskKind,
      inputTokens: usageIn,
      outputTokens: usageOut,
      toolCalls: toolEvents.filter((e) => e.state === 'done' || e.state === 'error').length,
      thoughts: reasoningText ? 1 : 0,
      failovers,
      elapsedMs: Date.now() - turnT0,
    },
    ...(lastContextTokens > 0 ? {
      context: {
        contextTokens: lastContextTokens,
        contextWindow: currentProfile().contextWindow,
        percent: Math.floor((lastContextTokens / currentProfile().contextWindow) * 100),
      },
    } : {}),
  } satisfies WorkReportData : undefined;

  return {
    text: outcome.text,
    reasoning: reasoningText || undefined,
    finishReason: outcome.finishReason,
    platform: served.platform,
    model: served.model,
    runtimeName: served.runtimeName,
    workMessages,
    changedFiles,
    ...(verifyOutcome ? { verifyOutcome } : {}),
    ...(auditOutcome ? { auditOutcome } : {}),
    ...(workReport ? { workReport } : {}),
    ...(stopReason ? { stopReason, paused: true } : {}),
    ...(proposedPlan ? { plan: proposedPlan } : {}),
  };
}
