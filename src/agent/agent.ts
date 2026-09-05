

// The stable contract chatViewProvider.ts depends on. Exposes only TierMux's own types
// (AgentOpts/AgentResult/ToolEvent) — no AI SDK type is ever imported here or above. Everything
// AI-SDK-shaped lives inside ./core/*, loaded lazily (see loadCore below) so this file stays
// vscode-free and independently testable, and so a future AI SDK version bump only touches
// ./core/*, not this file or chatViewProvider.ts.
import type { ChatMessage, TodoItem, ReasoningEffort, ProposedPlan } from '../shared/types';

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
  /** SDK finish reason for the turn ('stop' | 'length' | 'tool-calls' | 'unknown') — lets the
   *  webview render an ACCURATE empty-reply placeholder: 'length' = real output-budget
   *  exhaustion; 'stop' = the model chose to stop without answering (live repro: gpt-oss-120b
   *  returned a silent empty step 2 after its tool call — 270 out tokens, NOT budget exhaustion,
   *  yet the old placeholder blamed "token budget"). Undefined = turns persisted pre-plumbing. */
  finishReason?: string;
  platform?: string;
  model?: string;
  runtimeName?: string;
  taskKind?: string;
  workMessages?: ChatMessage[];
  paused?: boolean;
  /** Set when the turn STOPPED ITSELF rather than finishing: 'budget' — the step cap cut it
   *  while tool calls were still in flight; 'stuck' — the same tool call failed with identical
   *  input REPEAT_FAILURE_LIMIT times in a row. Both also set `paused`, so the host shows
   *  Continue and `stopReasonNote` prints a footer naming the reason. Undefined = the model
   *  concluded on its own terms (which may still leave pending todos — a different thing).
   *
   *  Live since 2026-09-05. It was declared but never assigned for the whole v3 era, described
   *  in terms of a "continuation loop in chatViewProvider" that no longer exists. */
  stopReason?: 'budget' | 'stuck';
  /** Set when the model called plan mode's `exitPlanMode` tool — the explicit
   *  planning→execution boundary. The plan arrives as VALIDATED STRUCTURE, so the host renders
   *  its plan card straight from this instead of inferring "was that reply a plan?" from the
   *  text. The turn also ENDS on this call (engine.ts stopWhen). Undefined = no plan proposed
   *  this turn, which in plan mode means the reply is an answer/research, not a proposal. */
  plan?: ProposedPlan;
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
  /** NOT PRODUCED BY THE v3 ENGINE (2026-09-05). `src/agent/core/tools/workspace/verifyCommand.ts`
   *  implements the gate, but nothing calls `runVerifyCommand`, so this is always undefined —
   *  see docs/AGENT_RELIABILITY_PLAN_2026-09-05.md §2.1, which is the decision to wire it or
   *  delete it. Contract as designed, for whoever wires it:
   *  Outcome of the end-of-turn command verify gate: 'passed' — the project's verify
   *  command ran and exited 0 (possibly after fix rounds); 'failed' — it exited non-zero even
   *  after the bounded fix rounds (`tiermux.agent.verifyFixRounds` — the agent owns the
   *  recheck, the user is never asked to re-run it); 'unverified' — the turn mutated files but
   *  no verify command exists. Undefined — no mutation (nothing to verify). The step engine
   *  (a pre-v3 step engine, also gone) treated 'failed' as "the step is NOT accepted": a model marking its
   *  todos completed while the verify command fails gets one focused extra round instead of a
   *  handshake. */
  verifyOutcome?: 'passed' | 'failed' | 'unverified';
  /** NOT PRODUCED BY THE v3 ENGINE (2026-09-05) — the host reads and persists it, and
   *  media/src/ui/components/ResultCard.ts renders it, but nothing ever sets it. §2.2 of the
   *  reliability plan is the decision to build it or delete all four layers.
   *  Structured end-of-turn report (the host persists it in the transcript
   *  as the canonical representation and posts it to the webview for the ResultCard). The
   *  legacy markdown block in `text` is compatibility serialization only. */
  workReport?: import('../shared/workReport').WorkReportData;
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

export type AgentMode = 'plan' | 'agent' | 'ask';

export interface AgentOpts {
  messages: ChatMessage[];
  mode: AgentMode;
  effort: ReasoningEffort;
  abortSignal?: AbortSignal;
  pinnedModel?: string;
  /** Host auto-approve toggle for this session — forwarded to the toolApproval policy so
   *  non-dangerous commands skip the inline prompt, like CommandGate/EditGate already do. */
  autoApprove?: boolean;
  /** Tool-result aging level for this turn — mirrors the tiermux.agent.toolCompaction
   *  setting ('off' | 'light' | 'aggressive'). Threaded from host settings. */
  toolCompaction?: 'off' | 'light' | 'aggressive';
  /** Hard cap on model round-trips in one turn — mirrors `tiermux.agent.maxStepsPerTurn`,
   *  threaded from host settings like toolCompaction (core/ stays vscode-free so the e2e
   *  gate can run it headless). The setting shipped documented since v3 while the engine
   *  hardcoded 50, so changing it did nothing. Omitted ⇒ the engine's own default. */
  maxStepsPerTurn?: number;
  /** Fix-and-recheck rounds after the end-of-turn verify command fails — mirrors
   *  `tiermux.agent.verifyFixRounds`, threaded from host settings. 0 reports the failure
   *  without retrying; it never disables the gate itself (that is `verifyCommand: 'off'`). */
  verifyFixRounds?: number;
  /** `platform::modelId` keys to skip during Auto selection for this call only — e.g. the
   *  auto-continue loop excluding the model that just got stuck, so the retry genuinely tries a
   *  different model rather than very likely re-picking the same one. Ignored when
   *  `pinnedModel` names a specific model (the user's explicit choice always wins) — only affects
   *  Auto selection. */
  excludeModels?: string[];
  taskKind?: string;
  /** TierMux chat session id. */
  sessionId?: string;
  /** Per-turn request id. Forwarded to CommandGate as a tracking key so the host's
   *  `commandGate.cancel({ sessionId, requestId })` can tree-kill the in-flight shell
   *  AND its descendants on Stop — without a requestId the gate can only kill the next
   *  process it happens to spawn, not the one the user actually wanted stopped. */
  requestId?: string;
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
  /** Checkpoint baseline — fired by the v3 write tools AFTER reading a file's pre-write
   *  content but BEFORE mutating it (null = about to be created). The host wires this to
   *  CheckpointManager.record(); type-only vscode reference (erased at runtime — this file
   *  stays vscode-free). */
  onBeforeWrite?: (uri: import('vscode').Uri, before: string | null) => void;
  onAskUser: (question: string, options?: string[]) => Promise<string>;
  /** A tool call is paused pending approval — resolved via the `toolApproval` policy
   *  (see core/policies/permission.ts), not by this file. */
  onPermissionAsk?: (info: { title: string; pattern?: string | string[]; command?: string; toolName?: string }) => Promise<'once' | 'always' | 'reject'>;
  onError: (message: string) => void;
  onWarning?: (message: string) => void;
  /** Turn telemetry sink — set by runTurn itself (not callers); every model call the turn
   *  makes (planner, executor, judges, recap) reports its provider-measured usage here so
   *  WorkReportData.telemetry reflects the WHOLE turn. See src/shared/workReport.ts. */
  usageSink?: (info: { inputTokens: number; outputTokens: number; contextTokens: number; contextWindow?: number; model: string }) => void;
}

// Lazy/dynamic on purpose: everything under `./core/` imports `vscode` (workspace.fs, the
// toolset, the policy's config reads). This file itself stays vscode-free so it can run
// headlessly under plain Node — a static import here would drag the whole vscode-dependent
// agent core into any headless test that only imports this module for its types.
let runTurn: typeof import('./core/engine').runTurn | undefined;
async function loadCore(): Promise<typeof import('./core/engine').runTurn> {
  if (!runTurn) ({ runTurn } = await import('./core/engine'));
  return runTurn;
}

/** Agent mode: full tool loop, via the AI SDK. The trailing `_tools` param is unused — the
 *  engine builds its own tool set. The leading `router` argument is gone as of 2026-09-05
 *  (plan §4.2): it had been ignored since v3, and the Router it referred to no longer exists.
 *  Model selection lives in router/picker.ts. */
export async function runAgentStream(opts: AgentOpts, _tools?: unknown): Promise<AgentResult> {
  return (await loadCore())(undefined, { ...opts, mode: 'agent' });
}

/** Plan mode: read-only toolset (readFile/listDir/glob/grep) — the policy still gates anything
 *  mutating, and the mode filter drops those tools from the model's view entirely. */
export async function runPlanStream(opts: AgentOpts, _tools?: unknown): Promise<AgentResult> {
  return (await loadCore())(undefined, { ...opts, mode: 'plan' });
}

/** Ask mode: read-only Q&A — same toolset as plan, different system-prompt framing. */
export async function runAskStream(opts: AgentOpts, _tools?: unknown): Promise<AgentResult> {
  return (await loadCore())(undefined, { ...opts, mode: 'ask' });
}
