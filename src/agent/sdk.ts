

import type { Router } from '../router/router';
import { AllModelsFailedError } from '../router/router';
import type { ChatMessage, TodoItem, ReasoningEffort } from '../shared/types';
import type { IProfilerService } from '../profiler/profilerService';
import type { OcConnection } from '../backend/ocLauncher';
import { OcClient, toOcParts } from '../backend/ocClient';
import { getLastRoutedModel, setForcedModel, setForcedTaskKind, setForcedAttachments, setForcedReasoningEffort, setRouteFailoverListener, setRouteRationaleListener, noteTurnOutcome, type RouteRationaleInfo } from '../backend/routerProxy';
import { classifyTask, attachmentKindsFromContent, type TaskKind } from './routing';
import { VISION_BLIND } from './answerQuality';
import { assessAnswerQuality } from './answerQuality';
import { contentToString, collectSessionAttachmentBlocks } from './content';
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

/**
 * Watchdog thresholds (observability only — see the "watchdog is observability, not recovery"
 * design). Two independent, fixed points: `warning` is informational, `actionable` is where the
 * UI offers Continue Waiting / Restart Request / Switch Model / Accept Current Output. Neither
 * threshold ever triggers an automatic action by itself. Overridable so tests don't need to
 * edit these production constants directly.
 */
let watchdogWarningMs = 90_000;
let watchdogWarningToolMs = 150_000;
let watchdogActionableMs = 180_000;
let watchdogActionableToolMs = 300_000;
export function setWatchdogThresholds(overrides: {
  warningMs?: number; warningToolMs?: number; actionableMs?: number; actionableToolMs?: number;
}): void {
  if (typeof overrides.warningMs === 'number') watchdogWarningMs = overrides.warningMs;
  if (typeof overrides.warningToolMs === 'number') watchdogWarningToolMs = overrides.warningToolMs;
  if (typeof overrides.actionableMs === 'number') watchdogActionableMs = overrides.actionableMs;
  if (typeof overrides.actionableToolMs === 'number') watchdogActionableToolMs = overrides.actionableToolMs;
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
  mode: 'agent' | 'plan' | 'ask';
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
  /** Smart Auto scoring rationale for a route() this run triggered — "why this model?". */
  onSelectionRationale?: (info: RouteRationaleInfo) => void;
  onKeyRotated?: (info: { platform: string; keyIndex: number; keyTotal: number }) => void;
  onStep: (phase: string, label: string) => void;
  onTodos: (todos: TodoItem[]) => void;
  onAskUser: (question: string, options?: string[]) => Promise<string>;
  /** OC paused a tool call on an `ask` permission rule (e.g. `bash: 'ask'` in ocConfig.ts) and
   *  is waiting for a decision before it proceeds. `title` is OC's own human-readable
   *  description of what it wants to do (e.g. the shell command). */
  onPermissionAsk?: (info: { title: string; pattern?: string | string[]; command?: string }) => Promise<'once' | 'always' | 'reject'>;
  onError: (message: string) => void;
  /** Soft, non-blocking notice (e.g. "stream ended early") — used when a run produced a
   *  usable answer despite a mid-stream error, instead of a hard red error. */
  onWarning?: (message: string) => void;
  /**
   * Watchdog — observability only, never recovery. These three are strictly one-way: the SDK
   * emits them and never receives a decision   back. A user-clicked "Restart Request"/"Switch
   * Model"/"Accept Current Output" is a UI command handled by the caller (chatViewProvider)
   * through the existing cancel/re-invoke path, not through a callback into this file.
   */
  onWatchdogWarning?: (info: { elapsedMs: number; lastActivity?: WatchdogActivity }) => void;
  onWatchdogActionable?: (info: { elapsedMs: number; lastActivity?: WatchdogActivity; hasPartialOutput: boolean }) => void;
  /** A real protocol event arrived — hide any warning/actionable UI, no user input needed. */
  onWatchdogDismissed?: () => void;
  /** Profiler service — always called (NoopProfiler when disabled). */
  profiler?: IProfilerService;
}

/** Last activity is protocol-derived only — never inferred from timers, polling, or local
 *  bookkeeping. See the watchdog event list in `runViaOc` for exactly which events qualify. */
export interface WatchdogActivity {
  label: string;
  atMs: number;
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

/** Malformed tool-call errors (bad schema/arguments, calling a tool not offered) are usually a
 *  one-off glitch from a weak/free model rather than proof the model is broken — escalating
 *  immediately forks the session and forces the next model to redo prior exploration from
 *  scratch. Give these a second same-model attempt before falling back to the chain. */
const TOOL_CALL_ERROR = /tool\s*call|tool\s*schema|invalid\s*argument|arguments?\s+provided|unavailable\s*tool|tried\s+to\s+call/i;

let ocClient: OcClient | undefined;
/** TierMux session id → OC session id (OC accumulates conversation history server-side). */
const ocSessions = new Map<string, string>();
/** TierMux session id → model id the OC session was created with (to detect model changes). */
const ocSessionModels = new Map<string, string>();
/** TierMux session id → OC agent ('plan'/'build', OC's own native agents) the OC session
 *  was created with (to detect a Plan/Agent mode switch mid-tab — see the reset check in runViaOc). */
const ocSessionAgents = new Map<string, string>();
/** `${sessionId}:${hop}` → OC session id, created ahead of time while the prior hop is still
 *  running so escalation can reuse it instead of blocking on a fresh createSession(). */
const prewarmedSessions = new Map<string, string>();
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

/** True if `sessionId` has a live OC session backing it — i.e. `/compact`'s client-side
 *  `condenseHistory` is a no-op for its actual OC-side token usage (see summarizeOcSession). */
export function hasOcSession(sessionId: string): boolean {
  return ocSessions.has(sessionId);
}

/**
 * Drop cached OC session bookkeeping for a TierMux chat session. Pure cache cleanup — does NOT
 * cancel an in-flight run, start a new one, or notify anyone; callers own those steps separately
 * (e.g. `chatViewProvider`'s watchdog "Restart Request"/"Switch Model" actions cancel first, then
 * call this, then re-invoke the normal run path). Also used internally wherever this file already
 * drops the same three maps (model/mode change, escalation, network retry).
 */
export function clearSession(sessionId: string): void {
  ocSessions.delete(sessionId);
  ocSessionModels.delete(sessionId);
  ocSessionAgents.delete(sessionId);
}

/**
 * Trigger OC's native server-side compaction for a TierMux session's OC-backed conversation.
 * `condenseHistory` only rewrites TierMux's own local `s.history` — for a continuing OC
 * session, TierMux forwards just the latest user message on each turn (see runViaOc) and
 * relies on OC's own session memory for everything else, so client-side condensing never
 * actually reduces OC's context. This does. Returns false (no-op) if there's no OC session
 * for this id yet, or the OC call fails — callers should fall back to condenseHistory.
 */
export async function summarizeOcSession(sessionId: string, router: Router): Promise<boolean> {
  const ocId = ocSessions.get(sessionId);
  if (!ocId || !ocClient) return false;
  const modelID = await router.pickUtilityModel();
  if (!modelID) return false;
  return ocClient.summarize(ocId, modelID);
}

/** Grep-style text search across the workspace via OC's ripgrep-backed `/find` endpoint
 *  (no TierMux-local equivalent exists — see mentions.ts). Best-effort: [] if OC isn't
 *  running, mirroring every other optional-OC-call in this file. */
export async function findTextViaOc(pattern: string): Promise<Array<{ path: string; lineNumber: number; lineText: string }>> {
  if (!ocClient) return [];
  return ocClient.findText(pattern);
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
 * `runViaOc` walks this chain left-to-right on empty-answer failures — agent/plan already
 * start on `smart` so there's nowhere cheaper to try first.
 */
const FALLBACK_CHAIN: Record<'agent' | 'plan' | 'ask', string[]> = {
  agent: ['smart', 'smart'],
  plan: ['smart'],
  ask: ['smart'],
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
/** Prepended on every vision turn. Language-agnostic and intent-agnostic on purpose: the
 *  underlying model is multilingual and reads the user's actual request (in whatever language)
 *  to decide whether it's a question or a build task — so we don't classify that ourselves
 *  (a hardcoded English regex would mis-handle a Banglish/Bengali "banao"). We only tell the
 *  model how to TREAT the image: use it, and don't go grepping the repo for text read off it. */
const VISION_DIRECTIVE =
  'An image (screenshot, photo, mockup, or diagram) is attached and is central to this request. Base your response on what the image actually shows: if the request is a question about it, answer directly from the image; if it asks you to build, recreate, or change something from it, treat the image as the design/spec and implement it with the file tools. Do not search or grep the codebase for text you read off the image unless the request is genuinely about existing code.';

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

  const agent = opts.mode === 'plan' ? 'plan' : opts.mode === 'ask' ? 'ask' : 'build';

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
    clearSession(key);
    ocId = undefined;
  }

  if (ocId && ocSessionAgents.get(key) !== undefined && ocSessionAgents.get(key) !== agent) {
    // Fix 4: mode changed (e.g. Plan→Agent). Fork the existing session so the
    // full native history (roles, tool calls, reasoning) carries over — mirroring the
    // model-change block above. Previously this dropped the session WITHOUT forking, which
    // forced the lossy formatTranscriptForReplay() path and flattened the whole conversation
    // into one text blob (indirect-reference hallucination).
    console.log(`[tiermux] mode changed (${ocSessionAgents.get(key)} → ${agent}), forking OC session to preserve history`);
    forkSourceOcId = ocId;
    clearSession(key);
    ocId = undefined;
  }

  const VIRTUAL = new Set(['auto', 'fast', 'smart']);
  const isVirtual = VIRTUAL.has(modelID);

  const virtualChain = FALLBACK_CHAIN[opts.mode] ?? ['smart'];
  const ocModelID = isVirtual ? modelID : virtualChain[Math.min(hop, virtualChain.length - 1)];
  if (!isVirtual) setForcedModel(modelID);

  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');

  const userText = contentToString(lastUser?.content);

  // Attachments from the WHOLE session, not just the latest message — a follow-up
  // question about an earlier screenshot must still route to a vision model and
  // still carry the image (see collectSessionAttachmentBlocks).
  const attachmentBlocks = collectSessionAttachmentBlocks(opts.messages);
  const taskKind: TaskKind = taskKindHint ?? classifyTask(userText, { attachmentKinds: attachmentKindsFromContent(attachmentBlocks) });

  setForcedTaskKind(taskKind === 'vision' ? 'vision' : undefined);
  setForcedAttachments(taskKind === 'vision' ? attachmentBlocks : undefined);

  setForcedReasoningEffort(opts.effort);
  setRouteFailoverListener((from, reason) => opts.onFailover(from, reason));
  setRouteRationaleListener((info) => opts.onSelectionRationale?.(info));

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
  // Set when we forked a stale session that has NO fully-settled prior turn (a mid-turn chain
  // escalation, e.g. tryEscalate() handing off before the user's first turn ever completed) —
  // the forked session already contains the current turn's user message plus whatever tool
  // calls it ran, so the next prompt must nudge the new model to continue, not restate the task.
  let midTurnForkNudge = false;

  const priorUserTurnCount = opts.messages.filter((m) => m.role === 'user').length - 1;
  if (!ocId && forkSourceOcId) {
    try {
      const oldMessages = await client.messages(forkSourceOcId);

      if (oldMessages.length === 0) throw new Error('messages() returned no history — refusing an unbounded fork');
      const midTurn = priorUserTurnCount <= 0;
      // Mid-turn: fork with no boundary so ALL of the old session's history — including the
      // in-flight tool calls and the current turn's own user message — carries over intact.
      const boundary = midTurn ? undefined : findReplayBoundary(oldMessages as any, priorUserTurnCount);
      const forked = await client.fork(forkSourceOcId, boundary);
      const forkedId = (forked as any)?.id ?? (forked as any)?.sessionID ?? (forked as any)?.sessionId ?? (forked as any)?.ID;
      if (typeof forkedId === 'string' && forkedId.length > 0) {
        ocId = forkedId;
        ocSessions.set(key, ocId);
        ocSessionModels.set(key, modelID);
        ocSessionAgents.set(key, agent);
        if (midTurn) midTurnForkNudge = true;
        console.log(`[tiermux] forked OC session id=${ocId} (${midTurn ? 'mid-turn, full history' : 'history replay'}) for model=${modelID}`);
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
      setRouteFailoverListener(undefined);
      setRouteRationaleListener(undefined);

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
      setRouteFailoverListener(undefined);
      setRouteRationaleListener(undefined);
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
  // authoritative list is re-fetched from `session.todo` at each idle. `unchangedCount` /
  // `prevOpenSig` are informational telemetry only (see the idle handler below) — they never
  // drive a decision or escalation.
  let latestTodos: TodoItem[] = [];
  let prevOpenSig = '';
  let unchangedCount = 0;
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
      // Learned vision demotion: record whether this vision turn produced a USABLE answer
      // against the model that served it. Two useless outcomes both count as failures so the
      // model self-demotes: (a) empty — the runaway-tool-loop burn-out; (b) "I can't see images"
      // (VISION_BLIND) — the image was dropped upstream (an aggregator delegated to a text model
      // / a gateway stripped it), which is fluent but non-empty and would otherwise score as OK.
      if (taskKind === 'vision' && promptSentAt > 0 && !opts.abortSignal?.aborted) {
        const usable = !!r.text.trim() && !VISION_BLIND.test(r.text);
        noteTurnOutcome('vision', usable, Date.now() - promptSentAt);
      }
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
      setRouteFailoverListener(undefined);
      setRouteRationaleListener(undefined);

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
      setRouteFailoverListener(undefined);
      setRouteRationaleListener(undefined);
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
      clearSession(key);
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

    // Watchdog — observability only, never recovery. It only ever emits `onWatchdogWarning` /
    // `onWatchdogActionable` (both non-blocking, purely informational) and never itself calls
    // tryEscalate()/finish(). Recovery stays exclusively in the objective-failure paths elsewhere
    // in this function (network errors, session.error, explicit abort).
    //
    // Invariants:
    //  - Only inactivity timers may emit watchdog warning/actionable events. Protocol events
    //    never emit watchdog warnings directly.
    //  - Only actual protocol events may dismiss watchdog UI. Timers never dismiss timers.
    let toolActive = false;
    let watchdog: ReturnType<typeof setTimeout>;
    let watchdogTier: 'healthy' | 'warning' | 'actionable' = 'healthy';
    let lastActivity: WatchdogActivity = { label: 'Started', atMs: Date.now() };

    const scheduleWatchdog = () => {
      clearTimeout(watchdog);
      const warningMs = toolActive ? watchdogWarningToolMs : watchdogWarningMs;
      const actionableMs = toolActive ? watchdogActionableToolMs : watchdogActionableMs;
      const nextMs = watchdogTier === 'healthy' ? warningMs
        : watchdogTier === 'warning' ? Math.max(1000, actionableMs - warningMs)
        : actionableMs; // stays 'actionable': keep re-emitting while silence continues, so a
                         // client-dismissed card reappears if the run really is still quiet.
      watchdog = setTimeout(() => {
        const elapsedMs = Date.now() - lastActivity.atMs;
        if (watchdogTier !== 'actionable') {
          watchdogTier = watchdogTier === 'healthy' ? 'warning' : 'actionable';
        }
        console.log(`[tiermux][watchdog] ${watchdogTier} elapsedMs=${elapsedMs} sessionKey=${key}`);
        if (watchdogTier === 'warning') opts.onWatchdogWarning?.({ elapsedMs, lastActivity });
        else opts.onWatchdogActionable?.({ elapsedMs, lastActivity, hasPartialOutput: !!out.trim() });
        scheduleWatchdog();
      }, nextMs);
    };
    scheduleWatchdog();

    /** Call only from the precise protocol-event list documented at each call site below —
     *  never from a timer, poll, heartbeat, or local UI refresh. */
    const noteActivity = (label: string): void => {
      lastActivity = { label, atMs: Date.now() };
      if (watchdogTier !== 'healthy') {
        console.log(`[tiermux][watchdog] dismissed reason=${label} sessionKey=${key}`);
        watchdogTier = 'healthy';
        opts.onWatchdogDismissed?.();
      }
      scheduleWatchdog();
    };

    const unsub = client.subscribe((ev) => {

      const payload = (ev as any).payload ?? ev;
      const p = (payload as any).properties ?? {};

      const evSession = p.sessionID ?? p.sessionId ?? p.info?.id;
      if (evSession !== ocId) return;

      // No blanket "any event resets the watchdog" here — only the specific protocol events
      // enumerated at each call site below (`noteActivity(...)`) count as evidence of life.

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
          noteActivity('Reasoning');
          opts.onReasoning(delta);
        } else {
          noteActivity('Streaming response');
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
            // The native `question` tool is already surfaced as a real interactive card via
            // the dedicated `question.asked` event handler above — showing it again here too
            // would duplicate it as an ugly generic "Question" tool-call card.
            if ((part.tool ?? part.name) === 'question') return;

            const st = part.state;
            const stObj = st && typeof st === 'object' ? st : null;
            const status = stObj?.status ?? (typeof st === 'string' ? st : 'running');

            toolActive = mapToolStatus(status) === 'running';
            const toolLabel = normalizeToolName(part.tool ?? part.name ?? 'tool');
            noteActivity(`Tool: ${toolLabel}${toolActive ? '' : ' (done)'}`);
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
            noteActivity('Reasoning');
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
            noteActivity('Streaming response');
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
            noteActivity('Reasoning');
            opts.onReasoning(delta);
          }
          lastReasoningByPart.set(partId, part.reasoning);
        }
        return;
      }

      if (t === 'tool.updated' || t === 'tool') {
        // Same dedup as the message.part.updated tool branch above.
        if ((p.name ?? p.tool) === 'question') return;
        const st = p.state;
        const stObj = st && typeof st === 'object' ? st : null;
        const status = stObj?.status ?? (typeof st === 'string' ? st : 'running');
        toolActive = mapToolStatus(status) === 'running';
        {
          const toolLabel = normalizeToolName(p.name ?? p.tool ?? 'tool');
          noteActivity(`Tool: ${toolLabel}${toolActive ? '' : ' (done)'}`);
        }
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
        // Deliberately NOT a watchdog activity signal — a todo refresh is TierMux asking OC a
        // question, not evidence the model itself is alive/working.
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

        noteActivity('Permission requested'); // OC surfacing an ask IS evidence it's alive
        void (async () => {
          const response = opts.onPermissionAsk
            ? await opts.onPermissionAsk({ title, pattern: patterns, command }).catch(() => 'reject' as const)
            : 'reject' as const; // no handler wired (e.g. hedging/title-gen runs) → safe default is deny, not hang
          await client.replyPermission(ocId!, permissionID, response).catch((err) => {
            console.error(`[tiermux] replyPermission failed:`, err);
          });
          noteActivity('Permission resolved');
        })();
        return;
      }

      if (t === 'question.asked') {
        // OC's native `question` tool (verified live against a running 1.17.11 server's
        // GET /doc — not a TierMux text protocol). Reuses the existing onAskUser/askUserPrompt
        // card unchanged: one question at a time, answered in order, then replied in one shot.
        const requestID: string = p.id ?? '';
        const questions: Array<{ question: string; options?: Array<{ label: string }> }> = Array.isArray(p.questions) ? p.questions : [];
        if (!requestID || !questions.length) return;

        noteActivity('Question asked'); // OC pausing on a native question IS evidence it's alive
        void (async () => {
          const answers: string[][] = [];
          for (const q of questions) {
            const optionLabels = (q.options ?? []).map((o) => o.label);
            const answer = await opts.onAskUser(q.question, optionLabels.length ? optionLabels : undefined).catch(() => '');
            answers.push([answer]);
          }
          await client.replyQuestion(requestID, answers).catch((err) => {
            console.error(`[tiermux] replyQuestion failed:`, err);
          });
          noteActivity('Question resolved');
        })();
        return;
      }

      if (t === 'session.status' || t === 'status') {
        // Deliberately NOT a watchdog activity signal — this is a status/busy ping, not one of
        // the enumerated protocol events; treating it as life would reintroduce the exact
        // false-liveness problem the watchdog redesign removes.
        opts.onStep('working', p?.status?.message ?? p?.message ?? 'Working…');
        return;
      }

      if (t === 'session.compacted' || t === 'session.compaction') {
        // Fix 1/4: OC compacted the conversation server-side. Tell the user + engine channel.
        // `compactionTailTurns` is the configured tail (cosmetic — for the "N turns kept" line).
        const msg = `Context compacted by engine — older turns summarized; last ~${compactionTailTurns} turns preserved.`;
        console.log(`[tiermux] ${msg} (session=${ocId})`);
        opts.onWarning?.(msg);
        return;
      }

      if (t === 'session.updated' || t === 'session.created' || t === 'session.title' || t === 'session.title.updated') {
        // OC's own title (e.g. "New session - <timestamp>") is ignored — TierMux generates
        // its own LLM-based title instead (see chatViewProvider.maybeGenerateTitle).
        return;
      }

      if (t === 'session.error' || t === 'error') {
        noteActivity('Session error'); // objective failure — also clears any pending watchdog UI
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

        if (out.trim()) {
          finish({ text: out, platform, model, taskKind: opts.taskKind });
          return;
        }

        const retryBudget = TOOL_CALL_ERROR.test(errMsg) ? 1 : 0;
        if (_retryCount <= retryBudget && !NON_RETRYABLE.test(errMsg)) {
          console.log(`[tiermux] OC session.error (no output, transient) — dropping session ${ocId}, retrying (attempt ${_retryCount + 1}/${retryBudget + 1})`);
          clearSession(key);
          unsub();
          clearTimeout(watchdog);
          void runViaOc(opts, _retryCount + 1, chainIndex, ocId, undefined, taskKind).then(finish, fail);
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
        noteActivity('Idle'); // idleBusy guards this to a one-time transition, not a repeat ping

        void (async () => {
          try {
            // Before accepting the finish, check for unfinished todos (agent mode). `session.todo`
            // is the source of truth — `latestTodos` is only a fallback. Unchanged todos across
            // repeated idles are weaker evidence than silence (a model can legitimately churn on
            // one todo for minutes without touching the list) — so this is telemetry only, never
            // a decision/escalation trigger. Keep nudging indefinitely; no auto "explain the
            // blocker" prompt, no auto-finish from a stalled-looking todo list.
            if (opts.mode === 'agent') {
              let todos: any[] = [];
              try { todos = await client.todo(ocId!); }
              catch { todos = latestTodos; }
              if (!todos.length && latestTodos.length) todos = latestTodos; // endpoint returned [] but we saw todos
              if (todos.length) opts.onTodos(todos as TodoItem[]); // push authoritative state so the UI reflects completion, not just the initial seed
              const open = todos.filter((td) => td && td.status !== 'completed');
              if (open.length) {
                const sig = open.map((td) => `${td.id ?? td.content ?? ''}:${td.status}`).sort().join('|');
                unchangedCount = sig === prevOpenSig ? unchangedCount + 1 : 0;
                prevOpenSig = sig;
                if (unchangedCount >= TODO_STALL_THRESHOLD) {
                  console.log(`[tiermux] todos unchanged for ${unchangedCount} idles (${open.length} open) — informational only, continuing to nudge`);
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

    const baseParts = firstPromptOverride
      ? [{ type: 'text' as const, text: firstPromptOverride }, ...toOcParts(lastUser?.content ?? '').filter((p) => p.type === 'file')]
      : midTurnForkNudge
        // Restate the actual task, not just "continue" — a vague nudge lets a model that
        // just finished an exploration phase (e.g. reading docs) mistake what it learned for
        // the deliverable and answer with a summary instead of resuming the requested build.
        ? [{ type: 'text' as const, text: `Continue the task below using the file-editing tools to actually produce the requested output — do not just describe or summarize what you've found so far.\n\nTask: ${userText}` }, ...toOcParts(lastUser?.content ?? '').filter((p) => p.type === 'file')]
        : toOcParts(lastUser?.content ?? '');
    // Vision steering: remind the model to actually USE the attached image and not run off
    // grepping the repo for text it read off a screenshot. One directive for all cases — the
    // multilingual model decides question-vs-build from the user's own words.
    const parts = taskKind === 'vision'
      ? [{ type: 'text' as const, text: VISION_DIRECTIVE }, ...baseParts]
      : baseParts;
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
          clearSession(key);
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

/** Agent mode: full tool loop via OC `build` over `tiermux/smart`. */
export async function runAgentStream(_router: Router, opts: AgentOpts, _tools: ToolSet): Promise<AgentResult> {
  return runViaOc({ ...opts, mode: 'agent' });
}

/** Plan mode: read-only OC `plan` agent over `tiermux/smart`. */
export async function runPlanStream(_router: Router, opts: AgentOpts, _tools: ToolSet): Promise<AgentResult> {
  return runViaOc({ ...opts, mode: 'plan' });
}

/** Ask mode: read-only OC `ask` agent over `tiermux/smart` — pure Q&A, no edits, no bash. */
export async function runAskStream(_router: Router, opts: AgentOpts, _tools: ToolSet): Promise<AgentResult> {
  return runViaOc({ ...opts, mode: 'ask' });
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
