

import type { Router } from '../router/router';
import { AllModelsFailedError } from '../router/router';
import type { ChatContentBlock, ChatMessage, TodoItem, ReasoningEffort } from '../shared/types';
import type { IProfilerService } from '../profiler/profilerService';
import type { OcConnection } from '../backend/ocLauncher';
import { OcClient, toOcParts } from '../backend/ocClient';
import { getLastRoutedModel, setForcedModel, setForcedTaskKind, setForcedAttachments, setForcedReasoningEffort } from '../backend/routerProxy';
import { classifyTask, attachmentKindsFromContent, type TaskKind } from './routing';
import { assessAnswerQuality } from './answerQuality';
import { contentToString } from './content';
import { findReplayBoundary, formatTranscriptForReplay } from './sessionReplay';

let traceOcEvents = false;
let traceSink: ((raw: string) => void) | undefined;
/** Setter exposed for `extension.ts` (wires to the `tiermux.engine.traceOcEvents` config). */
export function setOcTrace(on: boolean, sink?: (raw: string) => void): void {
  traceOcEvents = on;
  if (sink) traceSink = sink;
}

let qualityGateEnabled = true;
/** Setter for `extension.ts` to wire `tiermux.agent.qualityGate` (refreshed on config change). */
export function setQualityGate(on: boolean): void {
  qualityGateEnabled = on;
}

let hotStandbyEnabled = true;
/** Setter for `extension.ts` to wire `tiermux.agent.hotStandby` (refreshed on config change). */
export function setHotStandby(on: boolean): void {
  hotStandbyEnabled = on;
}

let hedgingEnabled = true;
/** Setter for `extension.ts` to wire `tiermux.agent.chatHedging` (refreshed on config change). */
export function setHedging(on: boolean): void {
  hedgingEnabled = on;
}

/**
 * Configured `compaction.tailTurns` (from `tiermux.engine.compaction`), used only to make
 * the `session.compacted` user notice informative ("…last ~N turns preserved"). Defaults to
 * OC's built-in 15 when TierMux doesn't override it. Purely cosmetic — compaction itself is
 * driven entirely server-side by OC reading the same setting at launch.
 */
let compactionTailTurns = 15;
/** Setter for `extension.ts` to share the resolved compaction.tailTurns for the notice. */
export function setCompactionTailTurns(n: number | undefined): void {
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) compactionTailTurns = Math.round(n);
}

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

  onChunk: (text: string) => void;
  onTool: (e: ToolEvent) => void;
  onReasoning: (text: string) => void;
  onModel: (platform: string, model: string, runtimeName?: string) => void;
  onFailover: (from: string, reason: string) => void;
  onKeyRotated?: (info: { platform: string; keyIndex: number; keyTotal: number }) => void;
  onStep: (phase: string, label: string) => void;
  onTodos: (todos: TodoItem[]) => void;
  /** OC generated/updated this session's title (from its own `small_model`, delivered via
   *  `session.updated`). TierMux uses OC's title as the source of truth instead of generating
   *  its own — see chatViewProvider.onSessionTitle. */
  onSessionTitle?: (title: string) => void;
  onAskUser: (question: string, options?: string[]) => Promise<string>;
  /** OC paused a tool call on an `ask` permission rule (e.g. `bash: 'ask'` in ocConfig.ts) and
   *  is waiting for a decision before it proceeds. `title` is OC's own human-readable
   *  description of what it wants to do (e.g. the shell command). */
  onPermissionAsk?: (info: { title: string; pattern?: string | string[]; command?: string }) => Promise<'once' | 'always' | 'reject'>;
  onError: (message: string) => void;
  /** Soft, non-blocking notice (e.g. "stream ended early") — used when a run produced a
   *  usable answer despite a mid-stream error, instead of a hard red error. */
  onWarning?: (message: string) => void;
  /** Profiler service — always called (NoopProfiler when disabled). */
  profiler?: IProfilerService;
}

type ToolSet = Record<string, any>;

/**
 * Pull a human-readable message out of an OC `session.error` / `error` event payload. OC's
 * error shape varies by build and upstream provider — the message can sit at `error.message`,
 * `error.error.message`, `message`, or be a bare string. Without this we'd fall back to the
 * useless "OC session error" and never learn why runs fail. Returns '' when nothing parsed.
 */
function extractOcError(p: any): string {
  const e = p?.error;
  if (typeof e === 'string' && e.trim()) return e.trim();
  const obj = e && typeof e === 'object' ? e : {};

  const pick = (...vals: any[]): string => {
    const v = vals.find((v) => typeof v === 'string' && v.trim());
    return v ? v.trim() : '';
  };
  const msg = pick(
    obj.message, obj.error?.message, obj.msg,
    obj.details, obj.detail, obj.reason,
    obj.data?.message, obj.data?.error,
    typeof obj.cause === 'string' ? obj.cause : obj.cause?.message,
    p?.message, p?.msg, p?.detail, p?.reason,
  );
  const code = pick(obj.code, obj.error?.code, p?.code);
  const type = pick(obj.type, obj.error?.type, p?.type);
  const parts = [msg || code, type].map((s) => String(s).trim())
    .filter((s) => s && s.toLowerCase() !== 'error');
  return parts.join(' — ');
}

/** Errors that won't be fixed by retrying on the same model (so we skip the one-shot retry and
 *  go straight to escalation): context-length/overflow, auth/key, and provider-side rejections. */
const NON_RETRYABLE = /context\s*length|token\s*limit|maximum\s*context|too\s+(long|large|many\s*tokens)|rate\s*limit|quota|unauthorized|invalid\s+api\s?key|forbidden|\b401\b|\b403\b/i;

let ocClient: OcClient | undefined;
/** TierMux session id → OC session id (OC accumulates conversation history server-side). */
const ocSessions = new Map<string, string>();
/** TierMux session id → model id the OC session was created with (to detect model changes). */
const ocSessionModels = new Map<string, string>();
/** TierMux session id → OC agent ('chat'/'planx'/'build') the OC session was created with
 *  (to detect a Ask/Plan/Agent mode switch mid-tab — see the reset check in runViaOc). */
const ocSessionAgents = new Map<string, string>();
/** `${sessionId}:${hop}` → OC session id, created ahead of time while the prior hop is still
 *  running so escalation can reuse it instead of blocking on a fresh createSession(). */
const prewarmedSessions = new Map<string, string>();
/** OC session ids we deliberately called `client.abort()` on (chat hedging's losing leg —
 *  see runChatHedged's flushWinner). OC reports that as a `session.error: "Aborted"` event,
 *  indistinguishable on the wire from a genuine transient failure — without this set, the
 *  session.error handler's "no output yet, retry once" path would resurrect the leg we just
 *  intentionally killed: a whole new session + full tool-calling loop running to completion
 *  in the background after the hedge already picked a winner, silently burning a free-tier
 *  request quota and re-triggering onStep/onTool UI updates on the already-finalized turn. */
const intentionallyAbortedOcIds = new Set<string>();

/** Called by extension.ts once the OC backend is up (or undefined when it's gone). */
export function setOcEngine(conn: OcConnection | undefined): void {
  ocClient = conn ? new OcClient(conn) : undefined;
  if (!ocClient) { ocSessions.clear(); ocSessionModels.clear(); ocSessionAgents.clear(); prewarmedSessions.clear(); }
}

/** True while the OC engine backend is connected. Lets callers (e.g. title generation)
 *  defer to OC's native behavior instead of duplicating it. */
export function isOcEngineActive(): boolean {
  return !!ocClient;
}

/** OC's own aggregate diff for a TierMux chat session's OC-backed conversation, if one
 *  exists yet (a session with no OC turns yet has no OC session id — returns []). */
export async function getOcSessionDiff(sessionId: string): Promise<Array<{ file: string; before: string; after: string; additions: number; deletions: number }>> {
  const ocId = ocSessions.get(sessionId);
  if (!ocId || !ocClient) return [];
  return ocClient.diff(ocId);
}

/**
 * Ordered routing profiles (virtual models the router proxy exposes) per TierMux mode.
 * `runViaOc` walks this chain left-to-right on empty-answer failures — chat starts on the
 * free/fast tier and hands off to `smart` once; agent/plan already start on `smart` so
 * there's nowhere cheaper to try first.
 */
const FALLBACK_CHAIN: Record<'chat' | 'agent' | 'plan', string[]> = {
  chat: ['fast', 'smart'],

  agent: ['smart', 'smart'],
  plan: ['smart'],
};

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
async function runViaOc(
  opts: AgentOpts,
  _retryCount = 0,
  chainIndex = 0,
  staleOcId?: string,
  onSessionId?: (id: string) => void,

  taskKindHint?: TaskKind,
): Promise<AgentResult> {
  if (!ocClient) {

    throw new Error('TierMux engine is not running. Check the "TierMux Engine" output channel for details, then reload the window to retry.');
  }
  const client = ocClient;

  const key = opts.sessionId ?? '__default__';

  const agent = opts.mode === 'chat' ? 'chat' : opts.mode === 'plan' ? 'planx' : 'build';

  const pinned = opts.pinnedModel && opts.pinnedModel !== 'auto' ? opts.pinnedModel : undefined;
  const chain = pinned ? [pinned] : (FALLBACK_CHAIN[opts.mode] ?? ['smart']);
  const hop = Math.min(chainIndex, chain.length - 1);
  const isFinalHop = hop >= chain.length - 1;
  const profile = chain[hop];
  const modelID = pinned ?? profile;

  let ocId = ocSessions.get(key);

  let forkSourceOcId = staleOcId;

  if (ocId && ocSessionModels.get(key) !== modelID) {
    console.log(`[tiermux] model changed (${ocSessionModels.get(key)} → ${modelID}), resetting OC session`);
    forkSourceOcId = ocId;
    ocSessions.delete(key);
    ocSessionModels.delete(key);
    ocSessionAgents.delete(key);
    ocId = undefined;
  }

  if (ocId && ocSessionAgents.get(key) !== undefined && ocSessionAgents.get(key) !== agent) {
    // Fix 4: mode changed (e.g. Plan→Agent, Ask→Agent). Fork the existing session so the
    // full native history (roles, tool calls, reasoning) carries over — mirroring the
    // model-change block above. Previously this dropped the session WITHOUT forking, which
    // forced the lossy formatTranscriptForReplay() path and flattened the whole conversation
    // into one text blob (indirect-reference hallucination).
    console.log(`[tiermux] mode changed (${ocSessionAgents.get(key)} → ${agent}), forking OC session to preserve history`);
    forkSourceOcId = ocId;
    ocSessions.delete(key);
    ocSessionModels.delete(key);
    ocSessionAgents.delete(key);
    ocId = undefined;
  }

  const VIRTUAL = new Set(['auto', 'fast', 'smart']);
  const isVirtual = VIRTUAL.has(modelID);

  const virtualChain = FALLBACK_CHAIN[opts.mode] ?? ['smart'];
  const ocModelID = isVirtual ? modelID : virtualChain[Math.min(hop, virtualChain.length - 1)];
  if (!isVirtual) setForcedModel(modelID);

  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');

  const userText = contentToString(lastUser?.content);

  const taskKind: TaskKind = taskKindHint ?? classifyTask(userText, { attachmentKinds: attachmentKindsFromContent(lastUser?.content ?? '') });

  setForcedTaskKind(taskKind === 'vision' ? 'vision' : undefined);

  const attachmentBlocks = Array.isArray(lastUser?.content)
    ? (lastUser.content as ChatContentBlock[]).filter((b) => {
      const type = typeof b === 'object' && b !== null ? (b as { type?: string }).type : undefined;
      return type === 'image_url' || type === 'file';
    })
    : [];
  setForcedAttachments(taskKind === 'vision' ? attachmentBlocks : undefined);

  setForcedReasoningEffort(opts.effort);

  const profiler = opts.profiler;
  const turnId = profiler?.beginTurn({
    sessionId: key,
    mode: opts.mode,
    promptLength: userText.length,
    taskKind,
    containsMentions: /@\w/.test(userText),
    containsAttachments: opts.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p: any) => p?.type === 'image_url'),
    ),
  });
  if (turnId) profiler?.setModel(turnId, modelID, hop);

  const prewarmKey = `${key}:${hop}`;
  if (!ocId) {
    if (turnId) profiler?.timerStart(turnId, 'SessionSetup');
    const prewarmed = prewarmedSessions.get(prewarmKey);
    if (prewarmed) {
      ocId = prewarmed;
      prewarmedSessions.delete(prewarmKey);
      ocSessions.set(key, ocId);
      ocSessionModels.set(key, modelID);
      ocSessionAgents.set(key, agent);
      console.log(`[tiermux] using pre-warmed OC session id=${ocId} for hop=${hop} model=${modelID}`);
    }
  }

  let firstPromptOverride: string | undefined;

  const priorUserTurnCount = opts.messages.filter((m) => m.role === 'user').length - 1;
  if (!ocId && forkSourceOcId && priorUserTurnCount > 0) {
    try {
      const oldMessages = await client.messages(forkSourceOcId);

      if (oldMessages.length === 0) throw new Error('messages() returned no history — refusing an unbounded fork');
      const boundary = findReplayBoundary(oldMessages as any, priorUserTurnCount);
      const forked = await client.fork(forkSourceOcId, boundary);
      const forkedId = (forked as any)?.id ?? (forked as any)?.sessionID ?? (forked as any)?.sessionId ?? (forked as any)?.ID;
      if (typeof forkedId === 'string' && forkedId.length > 0) {
        ocId = forkedId;
        ocSessions.set(key, ocId);
        ocSessionModels.set(key, modelID);
        ocSessionAgents.set(key, agent);
        console.log(`[tiermux] forked OC session id=${ocId} (history replay) for model=${modelID}`);
      } else {
        throw new Error('fork returned no session id');
      }
    } catch (err) {
      console.log(`[tiermux] session fork failed, falling back to transcript replay: ${err instanceof Error ? err.message : err}`);
      firstPromptOverride = formatTranscriptForReplay(opts.messages);
    }
  } else if (!ocId && priorUserTurnCount > 0) {

    console.log(`[tiermux] no OC session found for an existing conversation — replaying transcript from history`);
    firstPromptOverride = formatTranscriptForReplay(opts.messages);
  }
  if (!ocId) {
    let info: unknown;
    try {

      info = await client.createSession({ agent, model: { providerID: 'tiermux', id: ocModelID } });
    } catch (err) {
      console.error(`[tiermux] OC createSession failed:`, err);
      setForcedModel(undefined);
      setForcedTaskKind(undefined);
      setForcedAttachments(undefined);
      setForcedReasoningEffort(undefined);

      throw new Error(`TierMux engine failed to start a session: ${err instanceof Error ? err.message : err}`);
    }

    const id = (info as any)?.id ?? (info as any)?.sessionID ?? (info as any)?.sessionId ?? (info as any)?.ID;
    if (typeof id === 'string' && id.length > 0) {
      ocId = id;
    } else if (typeof info === 'string' && (info as string).length > 0) {
      ocId = info as string;
    } else {
      console.error(`[tiermux] OC createSession returned no id. raw=`, JSON.stringify(info));
      setForcedModel(undefined);
      setForcedTaskKind(undefined);
      setForcedAttachments(undefined);
      setForcedReasoningEffort(undefined);
      throw new Error('TierMux engine could not start a session. Raw response logged to DevTools console.');
    }
    ocSessions.set(key, ocId);
    ocSessionModels.set(key, modelID);
    ocSessionAgents.set(key, agent);
    console.log(`[tiermux] OC session created id=${ocId} agent=${agent} model=tiermux/${modelID}`);
    if (turnId) profiler?.timerEnd(turnId, 'SessionSetup');
  } else {
    console.log(`[tiermux] reusing OC session id=${ocId} model=${modelID}`);
  }
  onSessionId?.(ocId); // internal hook (Chat Hedging) — lets a caller track this hop's OC session id

  let out = '';
  const platform = 'tiermux';
  const model = modelID;

  // Fix 3 — todo completion guard state (per run). `latestTodos` is a snapshot only; the
  // authoritative list is re-fetched from `session.todo` at each idle. The stall detector
  // compares the open-todo signature across idles; `askedBlocker` guarantees termination.
  let latestTodos: TodoItem[] = [];
  let prevOpenSig = '';
  let unchangedCount = 0;
  let askedBlocker = false;
  const TODO_STALL_THRESHOLD = 2;
  // Fix 5 — serialize the idle → todo-check → continue/finish flow so an overlapping
  // `session.idle` (or a late `todo.updated`) can't double-fire a continuation or race finish().
  let idleBusy = false;

  let responded = false;
  let firstChunkReceived = false;
  let promptSentAt = 0;
  const announceResponding = () => {
    if (responded) return;
    responded = true;
    opts.onStep('synthesizing', 'Responding…');
  };
  opts.onModel(platform, model);
  opts.onStep('thinking', 'Thinking…');

  return new Promise<AgentResult>((resolve, reject) => {
    let done = false;
    const finish = (r: AgentResult) => {
      if (done) return;
      done = true;
      if (turnId) {
        const routedNowFor = getLastRoutedModel();
        const estTokens = Math.ceil(r.text.length / 4);
        profiler?.endTurn(turnId, {
          model: routedNowFor?.model ?? model,
          hop,
          tokens: { prompt: 0, completion: estTokens, total: estTokens },
        });
      }
      clearTimeout(watchdog);
      unsub();
      setForcedModel(undefined); // clear forced model so the next run starts clean
      setForcedTaskKind(undefined);
      setForcedAttachments(undefined);
      setForcedReasoningEffort(undefined);

      intentionallyAbortedOcIds.delete(ocId);

      for (const k of [...prewarmedSessions.keys()]) if (k.startsWith(`${key}:`)) prewarmedSessions.delete(k);

      const routed = getLastRoutedModel();
      if (routed && routed.model && routed.model !== model) {
        const realPlatform = routed.runtimeName ?? routed.platform;
        opts.onModel(realPlatform, routed.model, routed.runtimeName);
        resolve({ ...r, platform: realPlatform, model: routed.model, runtimeName: routed.runtimeName });
        return;
      }
      resolve(r);
    };

    const fail = (err: Error) => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      unsub();
      setForcedModel(undefined);
      setForcedTaskKind(undefined);
      setForcedAttachments(undefined);
      setForcedReasoningEffort(undefined);
      intentionallyAbortedOcIds.delete(ocId);
      for (const k of [...prewarmedSessions.keys()]) if (k.startsWith(`${key}:`)) prewarmedSessions.delete(k);
      reject(err);
    };

    const tryEscalate = (force = false, weak?: { primary?: string }): boolean => {

      if (isFinalHop) { console.log(`[tiermux][DBG] tryEscalate SKIP: isFinalHop (model=${modelID} hop=${hop} chain=${chain.join('>')})`); return false; }
      const hasOut = !!out.trim();

      if (!force && hasOut && !weak) { console.log(`[tiermux][DBG] tryEscalate SKIP: accepted (hasOut=${hasOut} force=${force} weak=${weak ? JSON.stringify(weak) : '-'})`); return false; }
      console.log(`[tiermux][DBG] tryEscalate DECIDE: force=${force} hasOut=${hasOut} weak=${weak ? JSON.stringify(weak) : '-'} model=${modelID}`);
      const nextProfile = chain[hop + 1];
      const reason = force ? 'network_error' : !hasOut ? 'no_answer' : 'weak_answer';
      const detail = weak?.primary ? `weak_answer:${weak.primary}` : reason;
      console.log(`[tiermux] OC run ${detail} on ${modelID} — handing off to ${nextProfile}`);
      opts.onFailover(`tiermux/${profile}`, `${detail} → escalating to ${nextProfile}`);
      if (turnId) profiler?.addFallback(turnId, `tiermux/${profile}`, detail);
      ocSessions.delete(key);
      ocSessionModels.delete(key);
      ocSessionAgents.delete(key);
      unsub();
      clearTimeout(watchdog);

      void runViaOc(opts, _retryCount, hop + 1, ocId, undefined, taskKind).then(finish, fail);
      return true;
    };

    const maybeEscalateWeak = (): boolean => {
      const len = out.trim().length;
      if (!out.trim() || isFinalHop || !qualityGateEnabled) {
        console.log(`[tiermux][DBG] quality-gate SKIP: len=${len} isFinalHop=${isFinalHop} enabled=${qualityGateEnabled} model=${modelID}`);
        return false;
      }
      const q = assessAnswerQuality(out, taskKind);
      const tail = JSON.stringify(out.slice(-60));
      if (q.weak && turnId) profiler?.setQualityGate(turnId, q.signals, q.score);
      console.log(`[tiermux][DBG] quality-gate DECIDE: len=${len} score=${q.score} signals=[${q.signals.join(',')}] primary=${q.primary ?? '-'} weak=${q.weak} model=${modelID} tail=${tail}`);
      if (!q.weak) return false;
      const escalated = tryEscalate(false, { primary: q.primary });
      console.log(`[tiermux][DBG] quality-gate RESULT: escalated=${escalated}`);
      return escalated;
    };

    const prewarmNextHop = (): void => {
      if (!hotStandbyEnabled || isFinalHop) return;
      const nextHop = hop + 1;
      const nextProfile = chain[nextHop];
      const pKey = `${key}:${nextHop}`;
      if (prewarmedSessions.has(pKey)) return;
      const extractId = (info: unknown): string | undefined => {
        const id = (info as any)?.id ?? (info as any)?.sessionID ?? (info as any)?.sessionId ?? (info as any)?.ID;
        return typeof id === 'string' && id.length > 0 ? id : undefined;
      };

      const create = priorUserTurnCount > 0
        ? client.messages(ocId!).then((oldMessages) => {
            const boundary = findReplayBoundary(oldMessages as any, priorUserTurnCount);

            if (boundary === undefined) throw new Error('prewarm boundary ambiguous — current turn may already be in flight');
            return client.fork(ocId!, boundary);
          })
        : client.createSession({ agent, model: { providerID: 'tiermux', id: nextProfile } });
      void create
        .then((info) => {
          const id = extractId(info);
          if (id) {
            prewarmedSessions.set(pKey, id);
            console.log(`[tiermux] pre-warmed OC session id=${id} for hop=${nextHop} profile=${nextProfile}`);
          }
        })
        .catch((err) => console.log(`[tiermux] pre-warm failed (non-fatal): ${err instanceof Error ? err.message : err}`));
    };

    const lastTextByPart = new Map<string, string>();

    const lastReasoningByPart = new Map<string, string>();

    const partKind = new Map<string, 'text' | 'reasoning' | 'other'>();

    const messageRole = new Map<string, string>();
    const roleOfPart = (part: any, p: any): string | undefined => {
      if (part?.role) return part.role;
      const mid = part?.messageID ?? part?.messageId ?? p?.messageID ?? p?.messageId;
      return mid ? messageRole.get(mid) : undefined;
    };

    let textChannel: 'delta' | 'updated' | undefined;

    const onRaw = traceOcEvents && traceSink
      ? (raw: string) => { try { traceSink!(raw); } catch { /* swallow */ } }
      : undefined;

    const INACTIVITY_MS = 3 * 60_000;
    const TOOL_INACTIVITY_MS = 5 * 60_000;
    const FAST_FAIL_MS = 45_000;
    let toolActive = false;
    let watchdog: ReturnType<typeof setTimeout>;
    const resetWatchdog = () => {
      clearTimeout(watchdog);
      // Capability-based (Fix 2): only fast-fail when there's a MEANINGFULLY DIFFERENT next
      // hop to escalate to. chat's `fast→smart` race escalates to a different tier → 45s
      // fast-fail is wanted. agent's `smart→smart` escalates to the SAME tier (pointless —
      // would just destroy in-progress work and restart) → use the normal 3/5-min window.
      // Future-proof: a `smart→smarter→max` chain fast-fails only where the next tier differs.
      const nextProfile = chain[hop + 1];
      const canEscalate = !isFinalHop && !!nextProfile && nextProfile !== profile;
      const windowMs = canEscalate ? FAST_FAIL_MS : toolActive ? TOOL_INACTIVITY_MS : INACTIVITY_MS;
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
      }, windowMs);
    };
    resetWatchdog();

    const unsub = client.subscribe((ev) => {

      const payload = (ev as any).payload ?? ev;
      const p = (payload as any).properties ?? {};

      const evSession = p.sessionID ?? p.sessionId ?? p.info?.id;
      if (evSession !== ocId) return;

      resetWatchdog(); // an event confirmed as OURS = this run is alive; keep it going

      const t = (payload as any).type ?? (ev as any).type ?? '';

      if (traceOcEvents && traceSink) {
        try { traceSink(`type=${t} sessionID=${p.sessionID ?? p.sessionId ?? '-'} keys=${Object.keys(p).join(',')}`); } catch { /* swallow */ }
      }

      if (t === 'message.part.delta' || t === 'part.delta') {
        const delta = p.delta ?? p.text ?? '';
        const field = p.field;
        if (!delta) return;

        if (roleOfPart(p.part ?? p, p) === 'user') return;
        if (field === 'reasoning' || p.partID && partKind.get(p.partID) === 'reasoning') {
          opts.onReasoning(delta);
        } else {
          if (textChannel === 'updated') return; // updated channel owns text — avoid double emit
          textChannel = 'delta';
          out += delta;
          announceResponding();
          if (!firstChunkReceived && promptSentAt && turnId) {
            firstChunkReceived = true;
            profiler?.recordTTFT(turnId, Date.now() - promptSentAt);
          }
          opts.onChunk(delta);
        }
        return;
      }

      if (t === 'message.updated' || t === 'message') {
        const info = p.info ?? p.message ?? p;
        const mid = info?.id ?? info?.messageID ?? info?.messageId;
        if (mid && info?.role) messageRole.set(mid, info.role);
        return;
      }

      if (t === 'message.part.updated' || t === 'part.updated') {

        const part = p.part ?? (p.type ? p : null);
        if (!part) return;

        if (roleOfPart(part, p) === 'user') return;
        const partId: string = part.id ?? part.partID ?? p.partID ?? '';
        if (partId) {
          if (part.type === 'reasoning') partKind.set(partId, 'reasoning');
          else if (part.type === 'text') partKind.set(partId, 'text');
          else if (part.type === 'tool' || part.tool) {
            partKind.set(partId, 'other');

            const st = part.state;
            const stObj = st && typeof st === 'object' ? st : null;
            const status = stObj?.status ?? (typeof st === 'string' ? st : 'running');

            toolActive = mapToolStatus(status) === 'running';
            resetWatchdog();
            opts.onTool({
              toolCallId: partId,
              name: normalizeToolName(part.tool ?? part.name ?? 'tool'),
              args: stObj?.input ?? part.input ?? part.args,
              state: mapToolStatus(status),
              detail: stObj?.output ?? stObj?.title ?? part.output ?? undefined,
            });
            if (turnId) {
              profiler?.addToolCall(turnId, normalizeToolName(part.tool ?? part.name ?? 'tool'));
              profiler?.timerStart(turnId, 'Tool');
              profiler?.timerEnd(turnId, 'Tool');
              if (!firstChunkReceived && promptSentAt) {
                firstChunkReceived = true;
                profiler?.recordTTFT(turnId, Date.now() - promptSentAt);
              }
            }
            return;
          } else {
            partKind.set(partId, 'other');
          }
        }

        if (partKind.get(partId) === 'reasoning' && typeof part.text === 'string') {
          const prev = lastReasoningByPart.get(partId) ?? '';
          if (part.text.length > prev.length && part.text.startsWith(prev)) {
            opts.onReasoning(part.text.slice(prev.length));
          }
          lastReasoningByPart.set(partId, part.text);
          return;
        }

        if (typeof part.text === 'string' && textChannel !== 'delta') {
          textChannel = 'updated';
          const prev = lastTextByPart.get(partId) ?? '';
          if (part.text.length > prev.length && part.text.startsWith(prev)) {
            const delta = part.text.slice(prev.length);
            out += delta;
            announceResponding();
            if (!firstChunkReceived && promptSentAt && turnId) {
              firstChunkReceived = true;
              profiler?.recordTTFT(turnId, Date.now() - promptSentAt);
            }
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

      if (t === 'tool.updated' || t === 'tool') {
        const st = p.state;
        const stObj = st && typeof st === 'object' ? st : null;
        const status = stObj?.status ?? (typeof st === 'string' ? st : 'running');
        toolActive = mapToolStatus(status) === 'running';
        resetWatchdog();
        opts.onTool({
          toolCallId: p.id ?? p.callID ?? '',
          name: normalizeToolName(p.name ?? p.tool ?? 'tool'),
          args: stObj?.input ?? p.input ?? p.args,
          state: mapToolStatus(status),
          detail: stObj?.output ?? p.detail,
        });
        if (turnId) {
          profiler?.addToolCall(turnId, normalizeToolName(p.name ?? p.tool ?? 'tool'));
          profiler?.timerStart(turnId, 'Tool');
          profiler?.timerEnd(turnId, 'Tool');
          if (!firstChunkReceived && promptSentAt) {
            firstChunkReceived = true;
            profiler?.recordTTFT(turnId, Date.now() - promptSentAt);
          }
        }
        return;
      }

      if (t === 'todo.updated' || t === 'todo') {
        try {
          const todos = p.todos ?? (Array.isArray(p) ? p : null);
          if (Array.isArray(todos)) {
            // Snapshot only — the authoritative list is fetched from `session.todo` at idle
            // (Fix 3 impl note 2). Never drive a continue/finish decision from this event: a
            // stale `todo.updated` from the previous turn can land mid-continuation.
            latestTodos = todos as TodoItem[];
            opts.onTodos(todos as TodoItem[]);
          }
        } catch { /* ignore */ }
        return;
      }

      if (t === 'permission.asked' || t === 'permission.updated') {
        const permissionID: string = p.id ?? '';
        const patterns: string[] | undefined = p.patterns ?? (p.pattern ? (Array.isArray(p.pattern) ? p.pattern : [p.pattern]) : undefined);
        const command: string | undefined = p.metadata?.command;
        const title: string = p.title ?? (command ? `Run: ${command}` : patterns ? `${p.permission ?? 'tool'}: ${patterns.join(', ')}` : `OC wants to use ${p.permission ?? 'a tool'}`);
        if (!permissionID) return;

        clearTimeout(watchdog);
        void (async () => {
          const response = opts.onPermissionAsk
            ? await opts.onPermissionAsk({ title, pattern: patterns, command }).catch(() => 'reject' as const)
            : 'reject' as const; // no handler wired (e.g. hedging/title-gen runs) → safe default is deny, not hang
          await client.replyPermission(ocId!, permissionID, response).catch((err) => {
            console.error(`[tiermux] replyPermission failed:`, err);
          });
          resetWatchdog(); // resume normal inactivity detection now that OC can proceed
        })();
        return;
      }

      if (t === 'session.status' || t === 'status') {
        // Busy status is a live signal — the top-of-callback resetWatchdog() already kept
        // the run alive; surface OC's status line so the UI shows current activity.
        opts.onStep('working', p?.status?.message ?? p?.message ?? 'Working…');
        return;
      }

      if (t === 'session.compacted' || t === 'session.compaction') {
        // Fix 1/4: OC compacted the conversation server-side. Keep the run alive (the
        // top-of-callback resetWatchdog() already did) and tell the user + engine channel.
        // `compactionTailTurns` is the configured tail (cosmetic — for the "N turns kept" line).
        const msg = `Context compacted by engine — older turns summarized; last ~${compactionTailTurns} turns preserved.`;
        console.log(`[tiermux] ${msg} (session=${ocId})`);
        opts.onWarning?.(msg);
        return;
      }

      if (t === 'session.updated' || t === 'session.created' || t === 'session.title' || t === 'session.title.updated') {
        // OC owns the session title (generated by its own small_model). Surface it so
        // TierMux uses OC's title as the source of truth instead of generating its own.
        const info = p.info ?? p;
        const title = typeof info?.title === 'string' ? info.title.trim() : '';
        if (title) opts.onSessionTitle?.(title);
        return;
      }

      if (t === 'session.error' || t === 'error') {
        const extracted = extractOcError(p);
        let errMsg = extracted;
        if (!extracted) {

          const keys = p && typeof p === 'object' ? Object.keys(p) : [];
          console.warn('[tiermux] Unparsed session.error payload:', p);
          errMsg = keys.length
            ? `OC session error (unparsed payload; keys: ${keys.join(',')})`
            : 'OC session error';
        }

        console.log(`[tiermux] OC session.error: ${errMsg} (outLen=${out.trim().length} model=${modelID} hop=${hop})`);

        if (ocId && intentionallyAbortedOcIds.delete(ocId)) {
          unsub();
          clearTimeout(watchdog);
          fail(new Error('Session intentionally aborted (superseded by the winning hedge leg)'));
          return;
        }

        if (out.trim()) {
          finish({ text: out, platform, model, taskKind: opts.taskKind });
          return;
        }

        if (_retryCount === 0 && !NON_RETRYABLE.test(errMsg)) {
          console.log(`[tiermux] OC session.error (no output, transient) — dropping session ${ocId}, retrying`);
          ocSessions.delete(key);
          ocSessionModels.delete(key);
          ocSessionAgents.delete(key);
          unsub();
          clearTimeout(watchdog);
          void runViaOc(opts, 1, chainIndex, ocId, undefined, taskKind).then(finish, fail);
          return;
        }

        if (tryEscalate()) return;

        fail(new Error(errMsg));
        return;
      }

      if (t === 'session.idle' || t === 'idle' || t === 'session.complete' || t === 'session.done' || t === 'session.completed') {
        console.log(`[tiermux][DBG] session.idle: outLen=${out.trim().length} model=${modelID} hop=${hop} chain=${chain.join('>')}`);
        // Fix 5: serialize — ignore an idle that arrives while we're already handling one
        // (e.g. a late idle during the `await client.todo()` window). The lock is released in
        // the finally below, including when we send a continuation and return to wait for the
        // NEXT idle, so the legitimate next cycle still runs.
        if (idleBusy) return;
        idleBusy = true;

        void (async () => {
          try {
            // Fix 3: before accepting the finish, check for unfinished todos (agent mode).
            // `session.todo` is the source of truth — `latestTodos` is only a fallback. One
            // continuation per idle; stall → one "explain the blocker" turn → finish.
            if (opts.mode === 'agent' && !askedBlocker) {
              let todos: any[] = [];
              try { todos = await client.todo(ocId!); }
              catch { todos = latestTodos; }
              if (!todos.length && latestTodos.length) todos = latestTodos; // endpoint returned [] but we saw todos
              const open = todos.filter((td) => td && td.status !== 'completed');
              if (open.length) {
                const sig = open.map((td) => `${td.id ?? td.content ?? ''}:${td.status}`).sort().join('|');
                unchangedCount = sig === prevOpenSig ? unchangedCount + 1 : 0;
                prevOpenSig = sig;

                if (unchangedCount >= TODO_STALL_THRESHOLD) {
                  // Stalled — one final turn to explain the blocker, then finish regardless.
                  askedBlocker = true;
                  opts.onStep('working', 'Wrapping up stalled todos…');
                  console.log(`[tiermux] todos stalled (${open.length} unchanged for ${unchangedCount} idles) — asking for a blocker explanation, then finishing`);
                  void client.prompt(ocId!, {
                    parts: [{ type: 'text' as const, text:
                      `These todos are still unfinished after repeated attempts:\n${open.map((td: any) => `- [${td.status}] ${td.content ?? td.title ?? ''}`).join('\n')}\nBriefly explain what blocked them (1–2 sentences), then stop.` }],
                    agent, model: { providerID: 'tiermux', modelID: ocModelID },
                  }, opts.abortSignal).catch((e) => console.log(`[tiermux] stall-explain prompt failed: ${e instanceof Error ? e.message : e}`));
                  return; // next idle: askedBlocker true → falls through to finish
                }

                opts.onStep('working', `Resuming ${open.length} unfinished task(s)…`);
                console.log(`[tiermux] ${open.length} unfinished todo(s) on idle — sending one continuation (unchanged=${unchangedCount})`);
                void client.prompt(ocId!, {
                  parts: [{ type: 'text' as const, text:
                    `Continue. Finish these todos, marking each completed as you go:\n${open.map((td: any) => `- [${td.status}] ${td.content ?? td.title ?? ''}`).join('\n')}` }],
                  agent, model: { providerID: 'tiermux', modelID: ocModelID },
                }, opts.abortSignal).catch((e) => console.log(`[tiermux] todo-continuation prompt failed: ${e instanceof Error ? e.message : e}`));
                return; // wait for the next idle
              }
            }

            // No unfinished todos (or not agent mode) — normal completion path.
            if (out.trim()) {
              if (maybeEscalateWeak()) return;
              finish({ text: out, platform, model, taskKind: opts.taskKind });
              return;
            }

            try {
              const msgs = await client.messages(ocId!);
              const text = extractLastAssistantText(msgs);
              if (text) {
                out = text;
                opts.onChunk(text);
              }
            } catch { /* ignore — keep whatever we have */ }

            if (tryEscalate()) return;

            if (maybeEscalateWeak()) return;
            finish({ text: out, platform, model, taskKind: opts.taskKind });
          } finally {
            idleBusy = false;
          }
        })();
        return;
      }
    }, opts.abortSignal, onRaw);

    prewarmNextHop();
    promptSentAt = Date.now();

    const parts = firstPromptOverride
      ? [{ type: 'text' as const, text: firstPromptOverride }, ...toOcParts(lastUser?.content ?? '').filter((p) => p.type === 'file')]
      : toOcParts(lastUser?.content ?? '');
    const promptP = client.prompt(ocId, { parts, agent, model: { providerID: 'tiermux', modelID: ocModelID } }, opts.abortSignal);

    const routedNow = getLastRoutedModel();
    if (routedNow?.model && routedNow.model !== model) {
      opts.onModel(routedNow.runtimeName ?? routedNow.platform, routedNow.model, routedNow.runtimeName);
    }
    void promptP
      .catch((e: unknown) => {

        if (opts.abortSignal?.aborted) { finish({ text: out, platform, model }); return; }
        const msg = e instanceof Error ? e.message : String(e);

        const status = (e as { cause?: { status?: number } } | undefined)?.cause?.status;

        const is5xx = (typeof status === 'number' && status >= 500 && status < 600) || /→\s*5\d\d/.test(msg);

        const isNetwork = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|other side closed|terminated|network error/i.test(msg);
        if ((is5xx || isNetwork) && _retryCount === 0) {
          console.log(`[tiermux] OC prompt() ${is5xx ? '5xx' : 'network error'} — dropping session ${ocId}, retrying with a fresh session`);
          ocSessions.delete(key);
          ocSessionModels.delete(key);
          ocSessionAgents.delete(key);
          unsub();
          clearTimeout(watchdog);

          void runViaOc(opts, 1, chainIndex, ocId, undefined, taskKind).then(finish, fail);
          return;
        }

        if (isNetwork && tryEscalate(true)) return;

        if (status === 503 || /→\s*503/.test(msg)) {
          fail(new AllModelsFailedError([]));
          return;
        }

        if (out.trim()) {
          finish({ text: out, platform, model });
          return;
        }

        fail(new Error(msg));
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
  lsp: 'lspCheck',
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

    const role = m?.info?.role ?? m?.role;
    if (!m || role !== 'assistant') continue;

    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const texts: string[] = [];
      for (const p of m.content) {
        if (typeof p === 'string') { texts.push(p); continue; }
        if (p && typeof p === 'object') {

          if (p.type === 'reasoning' || p.type === 'tool' || p.type === 'tool_call') continue;
          if (typeof p.text === 'string') texts.push(p.text);
          else if (typeof p.content === 'string') texts.push(p.content);
        }
      }
      const joined = texts.join('');
      if (joined) return joined;
    }

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
export async function runChatStream(router: Router, opts: AgentOpts): Promise<AgentResult> {
  const full: AgentOpts = { ...opts, mode: 'chat' };

  const lastUser = [...full.messages].reverse().find((m) => m.role === 'user');
  const userText = contentToString(lastUser?.content);
  const taskKind = classifyTask(userText, { attachmentKinds: attachmentKindsFromContent(lastUser?.content ?? '') });

  if (taskKind === 'trivial' && full.messages.length > 0) {
    const profiler = opts.profiler;
    const turnId = profiler?.beginTurn({
      sessionId: opts.sessionId ?? '__default__', mode: 'chat',
      promptLength: userText.length, taskKind,
      containsMentions: /@\w/.test(userText),
      containsAttachments: opts.messages.some(
        (m) => Array.isArray(m.content) && m.content.some((p: any) => p?.type === 'image_url'),
      ),
    });
    if (turnId) profiler?.setModel(turnId, 'direct', 0);
    opts.onStep('thinking', 'Thinking…');
    profiler?.timerStart(turnId!, 'Provider');
    let firstChunkMs = 0;
    const routeStartMs = Date.now();
    let responded = false;
    let buffer = '';
    try {
      const result = await router.route(full.messages, {
        model: opts.pinnedModel ?? 'auto', taskKind, temperature: 0.2, max_tokens: 4096,
        onChunk: (text) => {
          if (!firstChunkMs) {
            firstChunkMs = Date.now();
            profiler?.recordTTFT(turnId!, Math.round(firstChunkMs - routeStartMs));
          }
          if (!responded) {
            responded = true;
            opts.onStep('synthesizing', 'Responding…');
          }
          buffer += text;
          opts.onChunk(text);
        },
      });
      opts.onModel(result.platform, result.model);
      const text = buffer || contentToString(result.response.choices[0]?.message.content) || '';
      profiler?.timerEnd(turnId!, 'Provider');
      profiler?.endTurn(turnId!, {
        model: `${result.platform}::${result.model}`, hop: 0,
        tokens: {
          prompt: result.response.usage?.prompt_tokens ?? Math.ceil(userText.length / 4),
          completion: result.response.usage?.completion_tokens ?? Math.ceil(text.length / 4),
          total: result.response.usage?.total_tokens ?? Math.ceil((userText.length + text.length) / 4),
        },
      });
      return { text, platform: result.platform, model: result.model, taskKind };
    } catch (err) {
      profiler?.timerEnd(turnId!, 'Provider');
      profiler?.endTurn(turnId!, { model: 'error', hop: 0, tokens: { prompt: 0, completion: 0, total: 0 } });
      throw err;
    }
  }

  return isHedgeEligible(full) ? runChatHedged(full) : runViaOc(full);
}

const HEDGE_MAX_CHARS = 300;

/**
 * Hedging only applies to the FIRST turn of a brand-new chat session (no existing OC
 * session for this key yet). A fresh challenger session has no server-side history —
 * OC scopes history per session id — so racing every turn would require replaying the
 * whole prior transcript into the challenger, which risks a fluent-but-context-blind
 * answer "winning" the quality gate despite being wrong. Turn 1 has no such risk: the
 * latest message IS the whole context, so both legs start on equal footing.
 */
function isHedgeEligible(opts: AgentOpts): boolean {
  if (!hedgingEnabled || opts.mode !== 'chat') return false;
  if (opts.pinnedModel && opts.pinnedModel !== 'auto') return false; // nothing to race
  const key = opts.sessionId ?? '__default__';
  if (ocSessions.has(key)) return false; // only the first turn of a new session
  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
  const text = contentToString(lastUser?.content);
  if (!text || text.length > HEDGE_MAX_CHARS) return false;
  const kind = classifyTask(text, { attachmentKinds: attachmentKindsFromContent(lastUser?.content ?? '') });
  return kind === 'chat' || kind === 'trivial';
}

/**
 * Races `fast` and `smart` concurrently for a short first turn, taking whichever
 * produces a good (quality-gate-passing) answer first. Each leg runs as a PINNED model
 * (`runViaOc` then treats it as a length-1 chain, `isFinalHop=true`), so neither leg
 * escalates or pre-warms internally — this function is the only orchestration layer.
 * Chunks are buffered per leg (never forwarded live) since two concurrent streams can't
 * be interleaved into one chat bubble without garbling; the winner's buffered text is
 * flushed in one shot once chosen.
 */
async function runChatHedged(opts: AgentOpts): Promise<AgentResult> {
  const key = opts.sessionId ?? '__default__';
  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
  const userText = contentToString(lastUser?.content);
  const taskKind = classifyTask(userText, { attachmentKinds: attachmentKindsFromContent(lastUser?.content ?? '') });

  type Profile = 'fast' | 'smart';
  interface LegState { buffered: string; modelID?: string; runtimeName?: string; platform?: string; ocId?: string; result?: AgentResult; err?: Error }
  const legs: Record<Profile, LegState> = { fast: { buffered: '' }, smart: { buffered: '' } };
  let winner: Profile | undefined;

  const flushWinner = (which: Profile): void => {
    if (winner) return;
    winner = which;
    const other: Profile = which === 'fast' ? 'smart' : 'fast';
    if (legs[which].buffered) opts.onChunk(legs[which].buffered); // one flush — no live token streaming during the race
    if (legs[which].platform && legs[which].modelID) {
      opts.onModel(legs[which].platform!, legs[which].modelID!, legs[which].runtimeName);
    }
    ocSessions.set(key, legs[which].ocId!);
    ocSessionModels.set(key, legs[which].modelID ?? which);
    ocSessionAgents.set(key, 'chat'); // hedging only ever races chat-mode legs (fast/smart)
    if (legs[other].ocId) {
      intentionallyAbortedOcIds.add(legs[other].ocId);
      void ocClient?.abort(legs[other].ocId);
    }
  };

  const runLeg = async (which: Profile): Promise<void> => {
    const leg = legs[which];

    const decidedAgainst = (): boolean => !!winner && winner !== which;
    const legOpts: AgentOpts = {
      ...opts,
      pinnedModel: which,
      onChunk: (t) => { leg.buffered += t; if (winner === which) opts.onChunk(t); },
      onModel: (p, m, rt) => { leg.platform = p; leg.modelID = m; leg.runtimeName = rt; if (winner === which) opts.onModel(p, m, rt); },
      onFailover: () => {}, // a hedge leg is a length-1 chain (isFinalHop) — nothing to escalate to, nothing to report
      onStep: (phase, label) => { if (!decidedAgainst()) opts.onStep(phase, label); },
      onTool: (e) => { if (!decidedAgainst()) opts.onTool(e); },
      onReasoning: (t) => { if (!decidedAgainst()) opts.onReasoning(t); },
      onTodos: (todos) => { if (!decidedAgainst()) opts.onTodos(todos); },
      onKeyRotated: (info) => { if (!decidedAgainst()) opts.onKeyRotated?.(info); },
      onError: (message) => { if (!decidedAgainst()) opts.onError(message); },
      onWarning: (message) => { if (!decidedAgainst()) opts.onWarning?.(message); },
      onAskUser: async (question, options) => (decidedAgainst() ? '' : opts.onAskUser(question, options)),
    };
    try {
      const r = await runViaOc(legOpts, 0, 0, undefined, (id) => {
        leg.ocId = id;

        if (winner && winner !== which) {
          intentionallyAbortedOcIds.add(id);
          void ocClient?.abort(id);
        }
      });
      leg.result = r;
      const q = assessAnswerQuality(r.text, taskKind);
      if (!q.weak) flushWinner(which);
    } catch (err) {
      leg.err = err as Error;
    }
  };

  await Promise.allSettled([runLeg('fast'), runLeg('smart')]);
  if (!winner) {

    const pick: Profile | undefined = legs.smart.result ? 'smart' : legs.fast.result ? 'fast' : undefined;
    if (pick) { flushWinner(pick); return legs[pick].result!; }
    throw legs.smart.err ?? legs.fast.err ?? new Error('Both hedge legs failed');
  }
  return legs[winner].result!;
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
