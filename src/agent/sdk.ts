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
import type { OcConnection } from '../backend/ocLauncher';
import { OcClient } from '../backend/ocClient';
import { getLastRoutedModel, setForcedModel } from '../backend/routerProxy';
import { classifyTask } from './routing';
import { assessAnswerQuality } from './answerQuality';
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
}

type ToolSet = Record<string, any>;

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
async function runViaOc(opts: AgentOpts, _retryCount = 0, chainIndex = 0, staleOcId?: string): Promise<AgentResult> {
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
  const ocModelID = isVirtual ? modelID : profile;
  if (!isVirtual) setForcedModel(modelID);

  const prewarmKey = `${key}:${hop}`;
  if (!ocId) {
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
  } else {
    console.log(`[tiermux] reusing OC session id=${ocId} model=${modelID}`);
  }

  // Send only the latest user message — OC maintains the conversation server-side.
  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
  const userText = typeof lastUser?.content === 'string'
    ? lastUser.content
    : lastUser?.content == null ? '' : JSON.stringify(lastUser.content);
  // What actually goes out over the wire: `userText`, UNLESS `firstPromptOverride` (set
  // only on the transcript-fallback path above) replaces it ONCE for a freshly recreated
  // session. `userText` itself stays the real latest question — used for quality-gate
  // classification/logging regardless of which text was actually sent to OC.
  const promptText = firstPromptOverride ?? userText;

  let out = '';
  const platform = 'tiermux';
  const model = modelID;
  opts.onModel(platform, model);
  opts.onStep('thinking', 'Working…');

  return new Promise<AgentResult>((resolve, reject) => {
    let done = false;
    const finish = (r: AgentResult) => {
      if (done) return;
      done = true;
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
        const errMsg = typeof p.error === 'string'
          ? p.error
          : p.error?.message ?? p.message ?? 'OC session error';
        // Resolve the run NOW — otherwise the promise hangs until the 90s hard timeout,
        // leaving "Working…" and any in-flight todos stuck on screen after a failure.
        // If we got no text, first try to take over on a stronger model (once). Escalate
        // BEFORE surfacing the error: otherwise a run that recovers (or fails and retries)
        // shows a redundant red error — the failover notice already explains the takeover.
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
    void client.prompt(ocId, { parts: [{ type: 'text', text: promptText }], agent, model: { providerID: 'tiermux', modelID: ocModelID } }, opts.abortSignal)
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
export async function runChatStream(_router: Router, opts: AgentOpts): Promise<AgentResult> {
  return runViaOc({ ...opts, mode: 'chat' });
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
