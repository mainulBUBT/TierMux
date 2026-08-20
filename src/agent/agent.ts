

// The stable contract chatViewProvider.ts depends on. Exposes only TierMux's own types
// (AgentOpts/AgentResult/ToolEvent) — no AI SDK type is ever imported here or above. Everything
// AI-SDK-shaped lives inside ./core/*, loaded lazily (see loadCore below) so this file stays
// vscode-free and independently testable, and so a future AI SDK version bump only touches
// ./core/*, not this file or chatViewProvider.ts.
import type { Router } from '../router/router';
import type { ChatMessage, TodoItem, ReasoningEffort } from '../shared/types';
import type { IProfilerService } from '../profiler/profilerService';
import type { ClarifyingQuestion } from './clarify';

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
  /** Set when the turn was TERMINATED by a loop-control guardrail (over budget, or stuck
   *  repeating/thrashing) rather than finishing naturally. The autonomous continuation loop in
   *  chatViewProvider uses this to HALT — auto-continuing a budget/stuck stop just repeats the
   *  waste. Undefined = the model concluded on its own terms (may still have pending todos). */
  stopReason?: 'budget' | 'stuck' | 'askQuestions';
  /** Set when the model called the plan-mode `askQuestions` tool this turn — the caller uses
   *  this directly instead of parsing `text` for the legacy ???QUESTIONS??? sentinel. */
  askQuestions?: ClarifyingQuestion[];
  /** Set when the turn ended via the genuine-error catch path (not abort) — `onError` already
   *  surfaced a message to the UI. Callers must NOT also render this as a normal completed
   *  turn (empty text + a real footer reads as a phantom "successful" blank reply). */
  failed?: boolean;
  /** The failure message when `failed` is true — same text already sent to `onError`, exposed
   *  here so the caller can render it as a proper reply bubble instead of leaving the user with
   *  only the thin error notice and no visible response in the conversation. */
  errorMessage?: string;
  /** Files this turn created/modified/deleted via mutating tools, derived from the tool calls in
   *  `workMessages`. Lets the caller render a deterministic "Files changed" recap independent of
   *  the model's prose, so a turn that ended on a bare tool call still surfaces what it changed. */
  changedFiles?: { path: string; status: 'created' | 'modified' | 'deleted' }[];
  /** Outcome of the end-of-turn command verify gate (loop.ts): 'passed' — the project's verify
   *  command ran and exited 0; 'failed' — it exited non-zero even after the one fix retry;
   *  'unverified' — the turn mutated files but no verify command exists. Undefined — no mutation
   *  (nothing to verify). The step engine (core/stepEngine.ts) treats 'failed' as "the step is
   *  NOT accepted": a model marking its todos completed while the verify command fails gets one
   *  focused extra round instead of a handshake. */
  verifyOutcome?: 'passed' | 'failed' | 'unverified';
}

/** Smart Auto scoring rationale for a route() call this run triggered — "why this model?".
 *  Router.route() already exposes this as an onSelectionRationale RouteOptions callback
 *  (same shape as onFailover/onKeyRotated); core/routerProvider.ts forwards it through,
 *  translating scoring.ts's RationaleEntry[] (runtimeMultiplier/userPreference, platform+
 *  modelId) into this flatter shape. Optional because a plain scripted e2e harness has no
 *  UI to feed it to. */
export interface SelectionRationaleInfo {
  taskKind: string;
  picked?: string;
  entries: Array<{ model: string; selected: boolean; score: number; capability: number; runtime: number; preference: number; confidence: number; reason: string; skip?: string }>;
}

/** Last activity is protocol-derived (chunks, tool events, reasoning, step labels). The
 *  engine-side tracker lives in core/watchdog.ts (TurnWatchdog): a turn quiet past its
 *  warning/actionable thresholds fires these once each; any protocol event dismisses the
 *  showing card. The callbacks stay optional so headless callers compile unchanged. */
export interface WatchdogActivity {
  label: string;
  atMs: number;
}

export type AgentMode = 'plan' | 'agent' | 'ask';

export interface AgentOpts {
  messages: ChatMessage[];
  mode: AgentMode;
  effort: ReasoningEffort;
  abortSignal?: AbortSignal;
  pinnedModel?: string;
  /** `platform::modelId` keys to skip during Auto selection for this call only — e.g. the
   *  auto-continue loop excluding the model that just got stuck, so the retry genuinely tries a
   *  different model rather than very likely re-picking the same one (nothing about a stuck loop
   *  looks like a failure to the router's own health/availability scoring). Ignored when
   *  `pinnedModel` names a specific model (the user's explicit choice always wins) — only affects
   *  Auto selection. */
  excludeModels?: string[];
  taskKind?: string;
  /** TierMux chat session id. */
  sessionId?: string;
  /** Step routing (Phase 2): difficulty of the plan step this turn is executing — derived by the
   *  caller (chatViewProvider's auto-continue loop) from the current todo item. `easy` routes
   *  the round to the cheap fast pool (minIntelligenceRank), `hard` to the top tier
   *  (maxIntelligenceRank), `medium`/undefined to the unconstrained default. Ignored when a
   *  model is pinned or on an escalation retry (the user's choice / the escalation's own
   *  top-tier constraint always win). */
  stepDifficulty?: 'easy' | 'medium' | 'hard';
  /** How many `@mentions` in the latest user message resolved into supplied context — see
   *  routing.ts's classifyTaskCore, which uses this to route "work from what I gave you" turns
   *  (e.g. "reformat this @notes.md") to `chat` instead of an ambiguous default. */
  mentionCount?: number;

  onChunk: (text: string) => void;
  /** Retract the live text draft: a tentative chat reply turned out to be tool-planning narration
   *  (a tool call arrived in the same step), so the draft bubble must be cleared — that text is
   *  re-routed to the Chain-of-Thought block via `onReasoning`. */
  onRetractDraft?: () => void;
  onTool: (e: ToolEvent) => void;
  onReasoning: (text: string) => void;
  onModel: (platform: string, model: string, runtimeName?: string) => void;
  onFailover: (from: string, reason: string) => void;
  onSelectionRationale?: (info: SelectionRationaleInfo) => void;
  onKeyRotated?: (info: { platform: string; keyIndex: number; keyTotal: number }) => void;
  onStep: (phase: string, label: string) => void;
  onTodos: (todos: TodoItem[]) => void;
  onAskUser: (question: string, options?: string[]) => Promise<string>;
  /** A tool call is paused pending approval — resolved via the `toolApproval` policy
   *  (see core/policies/permission.ts), not by this file. */
  onPermissionAsk?: (info: { title: string; pattern?: string | string[]; command?: string; toolName?: string }) => Promise<'once' | 'always' | 'reject'>;
  onError: (message: string) => void;
  onWarning?: (message: string) => void;
  /** Watchdog — fired by core/watchdog.ts's TurnWatchdog when a turn goes quiet (warning at
   *  ~45s without a protocol event, actionable at ~90s). See WatchdogActivity above. */
  onWatchdogWarning?: (info: { elapsedMs: number; lastActivity?: WatchdogActivity }) => void;
  onWatchdogActionable?: (info: { elapsedMs: number; lastActivity?: WatchdogActivity; hasPartialOutput: boolean }) => void;
  onWatchdogDismissed?: () => void;
  /** Profiler service — always called (NoopProfiler when disabled). */
  profiler?: IProfilerService;
}

// Lazy/dynamic on purpose: everything under `./core/` imports `vscode` (workspace.fs,
// CommandGate/EditGate, etc). This file itself has always been vscode-free so it can run
// headlessly under plain Node — a static import here would drag the whole vscode-dependent
// agent core into any headless test that only imports this module for its types.
let runTurn: typeof import('./core/loop').runTurn | undefined;
async function loadCore(): Promise<typeof import('./core/loop').runTurn> {
  if (!runTurn) ({ runTurn } = await import('./core/loop'));
  return runTurn;
}

/** Agent mode: full tool loop over Router, via the AI SDK. The trailing `_tools` param is
 *  unused (the core builds its own tool set) — kept only so existing call sites in
 *  chatViewProvider.ts don't all need a mechanical edit. */
export async function runAgentStream(router: Router, opts: AgentOpts, _tools?: unknown): Promise<AgentResult> {
  return (await loadCore())(router, { ...opts, mode: 'agent' });
}

/** Plan mode: no write/edit/delete tools, and `runCommand` is guarded to read-only commands
 *  (see the mode gate in policies/permission.ts). MCP tools are excluded too — an arbitrary
 *  server's side effects can't be introspected. */
export async function runPlanStream(router: Router, opts: AgentOpts, _tools?: unknown): Promise<AgentResult> {
  return (await loadCore())(router, { ...opts, mode: 'plan' });
}

/** Ask mode: read-only Q&A — no edits; bash is available but guarded to read-only commands
 *  (see the mode gate in policies/permission.ts). */
export async function runAskStream(router: Router, opts: AgentOpts, _tools?: unknown): Promise<AgentResult> {
  return (await loadCore())(router, { ...opts, mode: 'ask' });
}
