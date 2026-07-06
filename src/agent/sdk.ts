// Agent engine boundary — the only file chatViewProvider calls. OpenCode (OC) is the
// SOLE agent engine: every run is driven over OC's HTTP/SSE API, which in turn routes
// model calls through the TierMux router proxy. No AI SDK, no built-in agent loop.
//
// Contract preserved (AgentOpts / AgentResult / the four public functions) so
// chatViewProvider is unchanged. When OC isn't connected, runs surface a clear error
// rather than silently falling back to a second engine.
import type { Router } from '../router/router';
import { AllModelsFailedError } from '../router/router';
import type { ChatMessage, TodoItem, ReasoningEffort } from '../shared/types';
import type { IProfilerService } from '../profiler/profilerService';
import type { OcConnection } from '../backend/ocLauncher';
import { OcClient } from '../backend/ocClient';
import { getLastRoutedModel, setForcedModel } from '../backend/routerProxy';
import { classifyTask } from './routing';
import { assessAnswerQuality } from './answerQuality';
import { contentToString } from './content';
import { findReplayBoundary, formatTranscriptForReplay } from './sessionReplay';

// ---- Trace toggle — when true, raw OC SSE frames are logged via the supplied sink. ----
let traceOcEvents = false;
let traceSink: ((raw: string) => void) | undefined;
/** Setter exposed for `extension.ts` (wires to the `tiermux.engine.traceOcEvents` config). */
export function setOcTrace(on: boolean, sink?: (raw: string) => void): void {
  traceOcEvents = on;
  if (sink) traceSink = sink;
}

// ---- Quality-gate toggle — when true, weak-but-non-empty answers escalate to the
// next chain hop (FrugalGPT-style) instead of being accepted. Wires to
// `tiermux.agent.qualityGate`. See plans/groovy-tinkering-swan.md. ----
let qualityGateEnabled = true;
/** Setter for `extension.ts` to wire `tiermux.agent.qualityGate` (refreshed on config change). */
export function setQualityGate(on: boolean): void {
  qualityGateEnabled = on;
}

// ---- Hot-standby toggle — when true, the NEXT chain hop's OC session is created in the
// background while the current hop is still running, so escalation (quality gate / no-answer
// / network retry) doesn't pay session-creation latency on top of the failure. Wires to
// `tiermux.agent.hotStandby`. ----
let hotStandbyEnabled = true;
/** Setter for `extension.ts` to wire `tiermux.agent.hotStandby` (refreshed on config change). */
export function setHotStandby(on: boolean): void {
  hotStandbyEnabled = on;
}

// ---- Chat hedging toggle — when true, a short first chat turn races `fast` and `smart`
// concurrently instead of sequentially, taking whichever produces a good answer first.
// Wires to `tiermux.agent.chatHedging`. ----
let hedgingEnabled = true;
/** Setter for `extension.ts` to wire `tiermux.agent.chatHedging` (refreshed on config change). */
export function setHedging(on: boolean): void {
  hedgingEnabled = on;
}

// ---- Public types (frozen — chatViewProvider depends on these) ----

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
  // Streaming callbacks → webview postMessage
  onChunk: (text: string) => void;
  onTool: (e: ToolEvent) => void;
  onReasoning: (text: string) => void;
  onModel: (platform: string, model: string, runtimeName?: string) => void;
  onFailover: (from: string, reason: string) => void;
  onKeyRotated?: (info: { platform: string; keyIndex: number; keyTotal: number }) => void;
  onStep: (phase: string, label: string) => void;
  onTodos: (todos: TodoItem[]) => void;
  onAskUser: (question: string, options?: string[]) => Promise<string>;
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
  // First non-empty string value wins. OC error payloads vary by build and upstream
  // provider — message can sit at error.message, error.error.message, message, msg,
  // or (commonly) the less-obvious details/detail/reason/data/cause fields. Cast a
  // wide net so the real cause surfaces instead of the useless "OC session error".
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

// ---- OpenCode engine state ----

let ocClient: OcClient | undefined;
/** TierMux session id → OC session id (OC accumulates conversation history server-side). */
const ocSessions = new Map<string, string>();
/** TierMux session id → model id the OC session was created with (to detect model changes). */
const ocSessionModels = new Map<string, string>();
/** `${sessionId}:${hop}` → OC session id, created ahead of time while the prior hop is still
 *  running so escalation can reuse it instead of blocking on a fresh createSession(). */
const prewarmedSessions = new Map<string, string>();

/** Called by extension.ts once the OC backend is up (or undefined when it's gone). */
export function setOcEngine(conn: OcConnection | undefined): void {
  ocClient = conn ? new OcClient(conn) : undefined;
  if (!ocClient) { ocSessions.clear(); ocSessionModels.clear(); prewarmedSessions.clear(); }
}

/**
 * Ordered routing profiles (virtual models the router proxy exposes) per TierMux mode.
 * `runViaOc` walks this chain left-to-right on empty-answer failures — chat starts on the
 * free/fast tier and hands off to `smart` once; agent/plan already start on `smart` so
 * there's nowhere cheaper to try first.
 */
const FALLBACK_CHAIN: Record<'chat' | 'agent' | 'plan', string[]> = {
  chat: ['fast', 'smart'],
  // Two hops of `smart`: a dropped connection (or a hung/broken OC session) escalates to
  // a FRESH smart run rather than downgrading to `fast`. The router still rotates the
  // underlying provider/key per hop, so the second attempt often lands on a different
  // upstream — full quality preserved, no silent downgrade on a transient network blip.
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
): Promise<AgentResult> {
  if (!ocClient) {
    opts.onError('TierMux engine is not running. Run "npm run fetch:binaries" (or set OPENCODE_BIN), then reload the window.');
    return { text: '' };
  }
  const client = ocClient;

  const key = opts.sessionId ?? '__default__';
  // `planx` is our custom read-only planner (returns the plan as text). NOT OC's built-in `plan`,
  // which writes a plan file and plan_exit-hands-off to build — wrong for TierMux's planProposed card.
  const agent = opts.mode === 'chat' ? 'chat' : opts.mode === 'plan' ? 'planx' : 'build';
  // Honor the user's explicitly-selected model; fall back to the routing chain only when on auto.
  // An explicit user pin means there's nothing to fall back to — treat it as a length-1 chain so
  // `tryEscalate` below never tries to hand off away from the model the user chose.
  const pinned = opts.pinnedModel && opts.pinnedModel !== 'auto' ? opts.pinnedModel : undefined;
  const chain = pinned ? [pinned] : (FALLBACK_CHAIN[opts.mode] ?? ['smart']);
  const hop = Math.min(chainIndex, chain.length - 1);
  const isFinalHop = hop >= chain.length - 1;
  const profile = chain[hop];
  const modelID = pinned ?? profile;

  let ocId = ocSessions.get(key);
  // Source session to replay history FROM when we're about to create a brand-new OC
  // session mid-conversation (escalation/retry pass their old ocId in via `staleOcId`;
  // a same-call model switch captures its own `ocId` right here, before nulling it).
  let forkSourceOcId = staleOcId;
  // If the user changed the model since the last run, the existing OC session was created
  // with the old model. OC doesn't switch models mid-session, so we start a fresh one.
  if (ocId && ocSessionModels.get(key) !== modelID) {
    console.log(`[tiermux] model changed (${ocSessionModels.get(key)} → ${modelID}), resetting OC session`);
    forkSourceOcId = ocId;
    ocSessions.delete(key);
    ocSessionModels.delete(key);
    ocId = undefined;
  }
  // Always use the virtual profile (fast/smart) for OC session creation so OC never needs
  // to know about specific model IDs. OC's static model registry is built at launch time
  // from enabled models — custom endpoint models added or enabled later would cause
  // createSession to 400. Instead, we pass the real pinned model to routerProxy via
  // setForcedModel (an in-process channel safe to use because runs are serialized) so the
  // router forces it on every completion call without OC needing to know about it.
  const VIRTUAL = new Set(['auto', 'fast', 'smart']);
  const isVirtual = VIRTUAL.has(modelID);
  // `profile` is NOT safe to use here when pinned: `chain` collapses to `[pinned]` in that
  // case, so `profile` is the raw "platform::modelId" pin itself, not a virtual name — OC
  // 400s on it. Use the mode's own virtual chain position instead so createSession always
  // gets a name OC recognizes, regardless of whether this run is pinned.
  const virtualChain = FALLBACK_CHAIN[opts.mode] ?? ['smart'];
  const ocModelID = isVirtual ? modelID : virtualChain[Math.min(hop, virtualChain.length - 1)];
  if (!isVirtual) setForcedModel(modelID);

  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
  const userText = typeof lastUser?.content === 'string'
    ? lastUser.content
    : lastUser?.content == null ? '' : JSON.stringify(lastUser.content);

  const profiler = opts.profiler;
  const turnId = profiler?.beginTurn({
    sessionId: key,
    mode: opts.mode,
    promptLength: userText.length,
    taskKind: classifyTask(userText),
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
      console.log(`[tiermux] using pre-warmed OC session id=${ocId} for hop=${hop} model=${modelID}`);
    }
  }
  // Replay text for the FIRST prompt only (transcript-fallback path) — undefined means
  // "send userText as normal," exactly like every reused session today.
  let firstPromptOverride: string | undefined;
  // A brand-new OC session mid-conversation starts with zero memory of prior turns (OC
  // scopes history per session id). Before falling back to a blank session, try to fork
  // the old one so the new session inherits everything already settled. No-ops (returns
  // undefined) when there's no prior history (a session's true first turn) or no source
  // to fork from — those cases fall straight through to today's exact createSession path.
  const priorUserTurnCount = opts.messages.filter((m) => m.role === 'user').length - 1;
  if (!ocId && forkSourceOcId && priorUserTurnCount > 0) {
    try {
      const oldMessages = await client.messages(forkSourceOcId);
      // `client.messages()` silently swallows any fetch error to `[]` — indistinguishable
      // from a real (impossible) empty session. Since we only ever reach here when the old
      // session is known to have had activity, an empty result means the fetch failed, not
      // that there's nothing to exclude. Forking with an unresolved boundary in that case
      // would ask OC for the session's CURRENT live state — which, for escalation/retry,
      // already contains the very turn we're trying to discard. Bail to the transcript
      // fallback instead of risking that leak.
      if (oldMessages.length === 0) throw new Error('messages() returned no history — refusing an unbounded fork');
      const boundary = findReplayBoundary(oldMessages as any, priorUserTurnCount);
      const forked = await client.fork(forkSourceOcId, boundary);
      const forkedId = (forked as any)?.id ?? (forked as any)?.sessionID ?? (forked as any)?.sessionId ?? (forked as any)?.ID;
      if (typeof forkedId === 'string' && forkedId.length > 0) {
        ocId = forkedId;
        ocSessions.set(key, ocId);
        ocSessionModels.set(key, modelID);
        console.log(`[tiermux] forked OC session id=${ocId} (history replay) for model=${modelID}`);
      } else {
        throw new Error('fork returned no session id');
      }
    } catch (err) {
      console.log(`[tiermux] session fork failed, falling back to transcript replay: ${err instanceof Error ? err.message : err}`);
      firstPromptOverride = formatTranscriptForReplay(opts.messages);
    }
  }
  if (!ocId) {
    try {
      // OC's createSession schema wants `model.id` (NOT `model.modelID`, which the
      // prompt endpoint uses). Sending modelID here 400s and the agent never starts.
      const info = await client.createSession({ agent, model: { providerID: 'tiermux', id: ocModelID } });
      // Defensive: handle response shapes where the id field is named differently
      // or the entire body IS the id.
      const id = (info as any)?.id ?? (info as any)?.sessionID ?? (info as any)?.sessionId ?? (info as any)?.ID;
      if (typeof id === 'string' && id.length > 0) {
        ocId = id;
      } else if (typeof info === 'string' && (info as string).length > 0) {
        ocId = info as string;
      } else {
        console.error(`[tiermux] OC createSession returned no id. raw=`, JSON.stringify(info));
        opts.onError(`TierMux engine could not start a session. Raw response logged to DevTools console.`);
        setForcedModel(undefined);
        return { text: '' };
      }
      ocSessions.set(key, ocId);
      ocSessionModels.set(key, modelID);
      console.log(`[tiermux] OC session created id=${ocId} agent=${agent} model=tiermux/${modelID}`);
    } catch (err) {
      console.error(`[tiermux] OC createSession failed:`, err);
      opts.onError(`TierMux engine failed to start a session: ${err instanceof Error ? err.message : err}`);
      setForcedModel(undefined);
      return { text: '' };
    }
    if (turnId) profiler?.timerEnd(turnId, 'SessionSetup');
  } else {
    console.log(`[tiermux] reusing OC session id=${ocId} model=${modelID}`);
  }
  onSessionId?.(ocId); // internal hook (Chat Hedging) — lets a caller track this hop's OC session id

  // What actually goes out over the wire: `userText`, UNLESS `firstPromptOverride` (set
  // only on the transcript-fallback path above) replaces it ONCE for a freshly recreated
  // session. `userText` itself stays the real latest question — used for quality-gate
  // classification/logging regardless of which text was actually sent to OC.
  const promptText = firstPromptOverride ?? userText;

  let out = '';
  const platform = 'tiermux';
  const model = modelID;
  // Tracks whether we've already announced the "now answering" phase. Emitted once on
  // the first real text token so the live status reads Thinking… → Responding…, and so
  // `s.lastStepLabel` / buffered (non-streaming) providers land on the right phase too.
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
      // Drop any pre-warmed session for a hop this run never escalated into — it would
      // otherwise leak (OC has no delete API; this just stops us tracking/reusing it).
      for (const k of [...prewarmedSessions.keys()]) if (k.startsWith(`${key}:`)) prewarmedSessions.delete(k);
      // Replace the virtual profile ("fast"/"smart") with the concrete provider+model
      // the Router actually resolved this run onto, so the UI shows the real pick (e.g.
      // "chutes / stepfun/step-3.7-flash:free") instead of the generic "tiermux".
      const routed = getLastRoutedModel();
      if (routed && routed.model && routed.model !== model) {
        const realPlatform = routed.runtimeName ?? routed.platform;
        opts.onModel(realPlatform, routed.model, routed.runtimeName);
        resolve({ ...r, platform: realPlatform, model: routed.model, runtimeName: routed.runtimeName });
        return;
      }
      resolve(r);
    };
    // Reject the run (rather than resolving via onError) ONLY for terminal router
    // exhaustion — every provider/key failed. Throwing AllModelsFailedError lets the
    // chatViewProvider catch surface the "enable these free models" recommendation
    // instead of a cryptic 503. Reuses `done` so it can't race finish().
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      unsub();
      setForcedModel(undefined);
      for (const k of [...prewarmedSessions.keys()]) if (k.startsWith(`${key}:`)) prewarmedSessions.delete(k);
      reject(err);
    };

    // Empty-result takeover: if a run ends with NO usable text (model gave up, tool loop
    // died empty, OC errored mid-run), hand off to the NEXT link in `chain` so a stronger
    // model takes over — mirrors the 5xx retry in the prompt().catch() below. Bounded by
    // `isFinalHop` (the chain's length) so a genuinely unanswerable turn still terminates.
    // Returns true when a hop was kicked off; the caller MUST then skip finish() (the
    // retry resolves later). Only invoked asynchronously (from event handlers / watchdog),
    // by which point `unsub`/`watchdog` below are initialized.
    const tryEscalate = (force = false, weak?: { primary?: string }): boolean => {
      // Pinned model / last hop: nowhere to hand off to.
      if (isFinalHop) { console.log(`[tiermux][DBG] tryEscalate SKIP: isFinalHop (model=${modelID} hop=${hop} chain=${chain.join('>')})`); return false; }
      const hasOut = !!out.trim();
      // Accept a good answer: text present, not a forced (network) retry, and not
      // flagged weak by the quality gate. (Previously this bailed on ANY non-empty
      // out — the weak param is what lets weak-but-non-empty answers escalate.)
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
      unsub();
      clearTimeout(watchdog);
      // hop+1 carries _retryCount unchanged: an OC-session drop shouldn't burn the prompt()
      // retry budget — that's for transient 5xx on a single hop, not a profile escalation.
      void runViaOc(opts, _retryCount, hop + 1, ocId).then(finish, fail);
      return true;
    };

    // Quality gate (FrugalGPT-style): if the run produced a WEAK-but-non-empty
    // answer (refusal / repetition / truncation / too-short-for-task), escalate
    // to the next chain hop instead of accepting it. `userText` is the last user
    // message, already resolved above; the task kind is recomputed locally
    // because AgentOpts.taskKind is not populated by the caller. Bounded by
    // isFinalHop (pinned/last hop) and the qualityGateEnabled kill-switch.
    const maybeEscalateWeak = (): boolean => {
      const len = out.trim().length;
      if (!out.trim() || isFinalHop || !qualityGateEnabled) {
        console.log(`[tiermux][DBG] quality-gate SKIP: len=${len} isFinalHop=${isFinalHop} enabled=${qualityGateEnabled} model=${modelID}`);
        return false;
      }
      const q = assessAnswerQuality(out, classifyTask(userText));
      const tail = JSON.stringify(out.slice(-60));
      if (q.weak && turnId) profiler?.setQualityGate(turnId, q.signals, q.score);
      console.log(`[tiermux][DBG] quality-gate DECIDE: len=${len} score=${q.score} signals=[${q.signals.join(',')}] primary=${q.primary ?? '-'} weak=${q.weak} model=${modelID} tail=${tail}`);
      if (!q.weak) return false;
      const escalated = tryEscalate(false, { primary: q.primary });
      console.log(`[tiermux][DBG] quality-gate RESULT: escalated=${escalated}`);
      return escalated;
    };

    // Hot standby: create the NEXT hop's OC session in the background while THIS hop is
    // still generating, so tryEscalate() can reuse it instead of blocking on createSession().
    // Deliberately does NOT touch setForcedModel — that stays deferred until the pre-warmed
    // session is actually swapped in for a real run, so it can't race the active hop's
    // forced model (setForcedModel is a single global, safe only when calls stay serialized).
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
      // Prior history exists: fork THIS (currently running) session ahead of time so the
      // prewarmed session is correctly warm (has context), not just available. Falls back
      // to a blank session (today's behavior) on any failure — the escalation path's own
      // fork-then-transcript-fallback logic still covers it if this prewarm didn't land.
      const create = priorUserTurnCount > 0
        ? client.messages(ocId!).then((oldMessages) => {
            const boundary = findReplayBoundary(oldMessages as any, priorUserTurnCount);
            // `undefined` here is AMBIGUOUS, not "safe to fork as-is": it can mean the
            // current turn's own message hasn't landed on the old session yet — but by
            // the time this fork() call actually reaches OC, the concurrently in-flight
            // prompt() may have appended it (a real race, since prewarm deliberately runs
            // while the current turn is still being processed). Forking with no boundary
            // in that case would silently pull in a dangling/incomplete current turn. Since
            // we can't be sure, skip prewarming this turn rather than risk it — the
            // escalation path's own fork (run only AFTER the current turn fully settles,
            // so it's never ambiguous) still covers correctness if this hop is needed.
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

    // Track the latest text we saw per part id, so `message.part.updated` (which carries
    // the full text) can be diffed against the previous value to emit deltas.
    const lastTextByPart = new Map<string, string>();
    // Track the latest reasoning per part id (for the reasoning channel).
    const lastReasoningByPart = new Map<string, string>();
    // Track which part ids are "text" vs "reasoning" vs other.
    const partKind = new Map<string, 'text' | 'reasoning' | 'other'>();
    // Track message-id → role (from `message.updated`). OC fires part events for the
    // USER message too; without this we'd stream the user's own text back as the answer.
    const messageRole = new Map<string, string>();
    const roleOfPart = (part: any, p: any): string | undefined => {
      if (part?.role) return part.role;
      const mid = part?.messageID ?? part?.messageId ?? p?.messageID ?? p?.messageId;
      return mid ? messageRole.get(mid) : undefined;
    };
    // OC emits BOTH `message.part.delta` (incremental) and `message.part.updated`
    // (cumulative) for the same text on some builds. Processing both doubles every
    // token. Lock onto whichever text channel speaks first and ignore the other.
    let textChannel: 'delta' | 'updated' | undefined;

    const onRaw = traceOcEvents && traceSink
      ? (raw: string) => { try { traceSink!(raw); } catch { /* swallow */ } }
      : undefined;

    // Inactivity watchdog — NOT a total-run timeout. `session.idle` is the normal
    // resolver; this only fires if OC goes completely silent (no SSE events at all)
    // for the window below, which means the engine died or the event name drifted.
    // Every event resets it (see resetWatchdog() in the subscribe callback), so an
    // actively-streaming run — however long — is never cut short. User cancel resolves
    // immediately via the abort path. On fire we still try to salvage the last message.
    //
    // A running tool (bash build, big write) can legitimately emit nothing until it
    // completes, which is longer than 3 minutes for real workloads. Track whether a
    // tool is in-flight (`toolActive`, set from the tool-status branches below) and use
    // a much longer window while one is — the short window still applies to plain
    // "OC went silent" hangs where no tool is running.
    //
    // Non-final hops (a weak/free model that still has a stronger fallback ahead of it
    // in `chain`) get a much shorter fuse: a dead or hung free-tier model should hand off
    // to the next link quickly rather than making the user wait out the full window.
    const INACTIVITY_MS = 3 * 60_000;
    const TOOL_INACTIVITY_MS = 5 * 60_000;
    const FAST_FAIL_MS = 45_000;
    let toolActive = false;
    let watchdog: ReturnType<typeof setTimeout>;
    const resetWatchdog = () => {
      clearTimeout(watchdog);
      const windowMs = !isFinalHop ? FAST_FAIL_MS : toolActive ? TOOL_INACTIVITY_MS : INACTIVITY_MS;
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
      resetWatchdog(); // any event = OC is alive; keep the run going

      // OC wraps the event envelope inside a top-level `payload` field:
      //   { payload: { type: "session.idle", properties: { ... } } }
      // Older OC builds sent { type, properties } directly. Handle both.
      const payload = (ev as any).payload ?? ev;
      const p = (payload as any).properties ?? {};
      // sessionID filter: only handle events for our session
      const evSession = p.sessionID ?? p.sessionId;
      if (evSession && ocId && evSession !== ocId) return;

      const t = (payload as any).type ?? (ev as any).type ?? '';

      // Verbose event log when the trace toggle is on — captures the FULL
      // payload (not just the recognized types) so we can see what OC actually sends
      // and patch the event-mapping switch accordingly.
      if (traceOcEvents && traceSink) {
        try { traceSink(`type=${t} sessionID=${p.sessionID ?? p.sessionId ?? '-'} keys=${Object.keys(p).join(',')}`); } catch { /* swallow */ }
      }

      // ---- Streaming text deltas (some OC builds emit these) ----
      if (t === 'message.part.delta' || t === 'part.delta') {
        const delta = p.delta ?? p.text ?? '';
        const field = p.field;
        if (!delta) return;
        // Skip deltas from the user message part (echo guard).
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

      // ---- Message metadata (carries the role; also where OC may report the model) ----
      if (t === 'message.updated' || t === 'message') {
        const info = p.info ?? p.message ?? p;
        const mid = info?.id ?? info?.messageID ?? info?.messageId;
        if (mid && info?.role) messageRole.set(mid, info.role);
        return;
      }

      // ---- Full part update (OC's primary text-carrier) ----
      if (t === 'message.part.updated' || t === 'part.updated') {
        // Two shapes seen in OC: { part: { type, text, id, ... } } or the part at the top level.
        const part = p.part ?? (p.type ? p : null);
        if (!part) return;
        // Ignore parts that belong to the USER message — otherwise we echo the prompt back.
        if (roleOfPart(part, p) === 'user') return;
        const partId: string = part.id ?? part.partID ?? p.partID ?? '';
        if (partId) {
          if (part.type === 'reasoning') partKind.set(partId, 'reasoning');
          else if (part.type === 'text') partKind.set(partId, 'text');
          else if (part.type === 'tool' || part.tool) {
            partKind.set(partId, 'other');
            // OC 1.x tool part: { type:'tool', tool, state:{ status, input, output, title } }.
            // `state` is an OBJECT (not a string) — passing it through verbatim renders as
            // "[object Object]" and loses the input/output. Unpack it here.
            const st = part.state;
            const stObj = st && typeof st === 'object' ? st : null;
            const status = stObj?.status ?? (typeof st === 'string' ? st : 'running');
            // Re-arm with the up-to-date flag — the resetWatchdog() at the top of this
            // callback ran before we knew this event was a tool update, so it may have
            // scheduled using the PREVIOUS (stale) toolActive value.
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
        // Reasoning parts carry their text in `part.text` (not `part.reasoning`); route it
        // to the reasoning channel so it shows as a Thinking block, not as the answer.
        if (partKind.get(partId) === 'reasoning' && typeof part.text === 'string') {
          const prev = lastReasoningByPart.get(partId) ?? '';
          if (part.text.length > prev.length && part.text.startsWith(prev)) {
            opts.onReasoning(part.text.slice(prev.length));
          }
          lastReasoningByPart.set(partId, part.text);
          return;
        }
        // Extract text and/or reasoning from the part and emit only the diff.
        // Skip when the delta channel already owns text emission (avoid double emit).
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

      // ---- Tool updates (alternate shape) ----
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

      // ---- Todo list ----
      if (t === 'todo.updated' || t === 'todo') {
        try {
          const todos = p.todos ?? (Array.isArray(p) ? p : null);
          if (Array.isArray(todos)) opts.onTodos(todos as TodoItem[]);
        } catch { /* ignore */ }
        return;
      }

      // ---- Status updates ----
      if (t === 'session.status' || t === 'status') {
        opts.onStep('working', p?.status?.message ?? p?.message ?? 'Working…');
        return;
      }

      // ---- Errors ----
      if (t === 'session.error' || t === 'error') {
        const extracted = extractOcError(p);
        let errMsg = extracted;
        if (!extracted) {
          // Payload shape unrecognized — capture the raw body so we can teach extractOcError
          // the missing field, instead of silently falling back to "OC session error".
          const keys = p && typeof p === 'object' ? Object.keys(p) : [];
          console.warn('[tiermux] Unparsed session.error payload:', p);
          errMsg = keys.length
            ? `OC session error (unparsed payload; keys: ${keys.join(',')})`
            : 'OC session error';
        }
        // Resolve the run NOW — otherwise the promise hangs until the 90s hard timeout,
        // leaving the status + in-flight todos stuck on screen after a failure.
        console.log(`[tiermux] OC session.error: ${errMsg} (outLen=${out.trim().length} model=${modelID} hop=${hop})`);

        // 1) We already streamed a usable answer — deliver it. A mid-stream error (upstream
        //    timeout, dropped SSE, a tool failing late) shouldn't throw away 1.6k of good
        //    output. Soft non-blocking notice instead of a hard red error; the answer shows.
        if (out.trim()) {
          opts.onWarning?.(`Answer may be incomplete — ${errMsg}`);
          finish({ text: out, platform, model, taskKind: opts.taskKind });
          return;
        }

        // 2) No output yet — recover if we can. Transient errors get one fresh-session retry
        //    (mirrors the 5xx/network path in prompt().catch). Non-retryable errors (context
        //    overflow, auth/quota) skip straight to escalation — a bigger model can carry the
        //    context that overflowed, and retrying the same input would just fail again.
        if (_retryCount === 0 && !NON_RETRYABLE.test(errMsg)) {
          console.log(`[tiermux] OC session.error (no output, transient) — dropping session ${ocId}, retrying`);
          ocSessions.delete(key);
          ocSessionModels.delete(key);
          unsub();
          clearTimeout(watchdog);
          void runViaOc(opts, 1, chainIndex, ocId).then(finish, fail);
          return;
        }

        // 3) Retry spent or non-retryable — hand off to a stronger model before giving up.
        if (tryEscalate()) return;
        opts.onError(errMsg);
        finish({ text: out, platform, model, taskKind: opts.taskKind });
        return;
      }

      // ---- Session idle: resolve. If we never saw streaming deltas, fetch messages as a fallback. ----
      if (t === 'session.idle' || t === 'idle' || t === 'session.complete' || t === 'session.done' || t === 'session.completed') {
        console.log(`[tiermux][DBG] session.idle: outLen=${out.trim().length} model=${modelID} hop=${hop} chain=${chain.join('>')}`);
        if (out.trim()) {
          // Quality gate: a non-empty but weak answer (refusal/loop/truncation/
          // too-short) escalates to the next chain hop before we accept it.
          if (maybeEscalateWeak()) return;
          finish({ text: out, platform, model, taskKind: opts.taskKind });
          return;
        }
        // No accumulated text — fetch the session messages and pull the last assistant text.
        void (async () => {
          try {
            const msgs = await client.messages(ocId!);
            const text = extractLastAssistantText(msgs);
            if (text) {
              out = text;
              opts.onChunk(text);
            }
          } catch { /* ignore — keep whatever we have */ }
          // Still no answer after the fallback fetch — let a stronger model take over (once).
          if (tryEscalate()) return;
          // Fetched text may be non-empty but weak — run the quality gate on it too.
          if (maybeEscalateWeak()) return;
          finish({ text: out, platform, model, taskKind: opts.taskKind });
        })();
        return;
      }
    }, opts.abortSignal, onRaw);

    // Fire pre-warm alongside the prompt POST (not after it resolves — prompt() may not
    // resolve until the whole turn finishes, since SSE/session.idle drives completion,
    // not the HTTP response).
    prewarmNextHop();
    promptSentAt = Date.now();
    const promptP = client.prompt(ocId, { parts: [{ type: 'text', text: promptText }], agent, model: { providerID: 'tiermux', modelID: ocModelID } }, opts.abortSignal);
    // The router resolves the concrete model synchronously while issuing the POST
    // (candidate selection happens before the fetch awaits). Announce it now so an
    // Auto-routed (virtual-profile) run shows the real model in the live status
    // subtitle right away, instead of waiting for finish() (by which point the
    // status is already hidden).
    const routedNow = getLastRoutedModel();
    if (routedNow?.model && routedNow.model !== model) {
      opts.onModel(routedNow.runtimeName ?? routedNow.platform, routedNow.model, routedNow.runtimeName);
    }
    void promptP
      .catch((e: unknown) => {
        // User-cancel aborts the POST too — that's expected, not an error to surface.
        if (opts.abortSignal?.aborted) { finish({ text: out, platform, model }); return; }
        const msg = e instanceof Error ? e.message : String(e);
        // 5xx means the OC session is broken (server-side crash, stale session after restart, etc.).
        // Drop it from the cache so the next attempt gets a fresh session, then retry once automatically.
        const is5xx = /→\s*5\d\d/.test(msg);
        // Network-layer failures (OC bridge ↔ router connection lost) surface as Node undici's
        // `TypeError: fetch failed` or one of its underlying causes. The router already treats these
        // as failoverable; here at the OC layer we must too, or the agent dead-ends on a dropped
        // connection. Retry once on the same hop; if that's exhausted, escalate to the next profile.
        const isNetwork = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|other side closed|terminated|network error/i.test(msg);
        if ((is5xx || isNetwork) && _retryCount === 0) {
          console.log(`[tiermux] OC prompt() ${is5xx ? '5xx' : 'network error'} — dropping session ${ocId}, retrying with a fresh session`);
          ocSessions.delete(key);
          ocSessionModels.delete(key);
          unsub();
          clearTimeout(watchdog);
          // Retry the full run on the SAME hop (will create a new OC session on the way in).
          void runViaOc(opts, 1, chainIndex, ocId).then(finish, fail);
          return;
        }
        // Retry budget spent (or this was a repeat). Before surfacing the error, try a fresh hop —
        // a network blip shouldn't kill the turn if there's another profile link available.
        if (isNetwork && tryEscalate(true)) return;
        // Terminal router exhaustion (routerProxy maps AllModelsFailedError → 503). Reject the run
        // so the chatViewProvider catch fires maybeRecommendModels() — surfacing a concrete "enable
        // these free models" prompt rather than a bare 503. Empty failures: the detail was already
        // logged by the router; the recommendation only checks instanceof.
        if (/→\s*503/.test(msg)) {
          fail(new AllModelsFailedError([]));
          return;
        }
        // Already streamed a usable answer → deliver it with a soft notice (see session.error).
        if (out.trim()) {
          opts.onWarning?.(`Answer may be incomplete — ${msg}`);
          finish({ text: out, platform, model });
          return;
        }
        opts.onError(msg);
        finish({ text: out, platform, model });
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
    // OC wraps each message as { info: { role, ... }, parts: [...] }; older/flat
    // shapes put role at the top. Check both so we never return the user's message.
    const role = m?.info?.role ?? m?.role;
    if (!m || role !== 'assistant') continue;
    // Direct content.
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const texts: string[] = [];
      for (const p of m.content) {
        if (typeof p === 'string') { texts.push(p); continue; }
        if (p && typeof p === 'object') {
          // Never surface reasoning (chain-of-thought) or tool parts as the answer —
          // reasoning is where models ramble identity text ("As Claude Code, I…"), which
          // otherwise leaks in as "random words" when a run ends via this fallback.
          if (p.type === 'reasoning' || p.type === 'tool' || p.type === 'tool_call') continue;
          if (typeof p.text === 'string') texts.push(p.text);
          else if (typeof p.content === 'string') texts.push(p.content);
        }
      }
      const joined = texts.join('');
      if (joined) return joined;
    }
    // Parts array (OC's shape).
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

// ---- Public API — what chatViewProvider calls ----

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
  const userText = typeof lastUser?.content === 'string'
    ? lastUser.content
    : lastUser?.content == null ? '' : JSON.stringify(lastUser.content);
  const taskKind = classifyTask(userText);

  // Direct router path for trivial greetings only — bypass OC entirely.
  // Actual questions route through OC so the model can inspect the project
  // (grounding rules live in ocConfig.ts's agent prompts, which this bypass
  // skips entirely — 'chat' must NOT be added back here without also fixing
  // where broad Q&A gets its grounding from).
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

// ---- Chat-Turn Request Hedging (turn-1-only) --------------------------------------
// Short heuristic for "cheap enough to double-run" — mirrors the too-short word floors
// already used for 'chat' in answerQuality.ts, just at the character level since we
// haven't classified the turn yet at eligibility-check time.
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
  const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
  if (!text || text.length > HEDGE_MAX_CHARS) return false;
  const kind = classifyTask(text);
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
  const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
  const taskKind = classifyTask(userText);

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
    if (legs[other].ocId) void ocClient?.abort(legs[other].ocId);
  };

  const runLeg = async (which: Profile): Promise<void> => {
    const leg = legs[which];
    const legOpts: AgentOpts = {
      ...opts,
      pinnedModel: which,
      onChunk: (t) => { leg.buffered += t; if (winner === which) opts.onChunk(t); },
      onModel: (p, m, rt) => { leg.platform = p; leg.modelID = m; leg.runtimeName = rt; if (winner === which) opts.onModel(p, m, rt); },
      onFailover: () => {}, // a hedge leg is a length-1 chain (isFinalHop) — nothing to escalate to, nothing to report
    };
    try {
      const r = await runViaOc(legOpts, 0, 0, undefined, (id) => { leg.ocId = id; });
      leg.result = r;
      const q = assessAnswerQuality(r.text, taskKind);
      if (!q.weak) flushWinner(which);
    } catch (err) {
      leg.err = err as Error;
    }
  };

  await Promise.allSettled([runLeg('fast'), runLeg('smart')]);
  if (!winner) {
    // Neither leg was clearly good — accept whichever actually finished (prefer smart).
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
