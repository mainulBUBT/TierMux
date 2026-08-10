

// The stable contract chatViewProvider.ts depends on. Exposes only TierMux's own types
// (AgentOpts/AgentResult/ToolEvent) — no AI SDK type is ever imported here or above. Everything
// AI-SDK-shaped lives inside ./core/*, loaded lazily (see loadCore below) so this file stays
// vscode-free and independently testable, and so a future AI SDK version bump only touches
// ./core/*, not this file or chatViewProvider.ts.
import type { Router } from '../router/router';
import type { ChatMessage, TodoItem, ReasoningEffort } from '../shared/types';
import type { IProfilerService } from '../profiler/profilerService';

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
  stopReason?: 'budget' | 'stuck';
  /** Set when the turn ended via the genuine-error catch path (not abort) — `onError` already
   *  surfaced a message to the UI. Callers must NOT also render this as a normal completed
   *  turn (empty text + a real footer reads as a phantom "successful" blank reply). */
  failed?: boolean;
  /** The failure message when `failed` is true — same text already sent to `onError`, exposed
   *  here so the caller can render it as a proper reply bubble instead of leaving the user with
   *  only the thin error notice and no visible response in the conversation. */
  errorMessage?: string;
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

/** Last activity is protocol-derived only. Watchdog isn't wired up yet (see the
 *  plan's deferred items — port once the agent core is stable); kept optional so
 *  chatViewProvider.ts's existing callbacks compile unchanged. */
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
  taskKind?: string;
  /** TierMux chat session id. */
  sessionId?: string;
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
  /** Watchdog — not wired up yet (see plan's deferred items). Kept optional so
   *  chatViewProvider.ts's existing callbacks compile unchanged. */
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

/** Plan mode: read-only, no write/edit/delete/runCommand/question tools. */
export async function runPlanStream(router: Router, opts: AgentOpts, _tools?: unknown): Promise<AgentResult> {
  return (await loadCore())(router, { ...opts, mode: 'plan' });
}

/** Ask mode: read-only Q&A, no edits, no bash. */
export async function runAskStream(router: Router, opts: AgentOpts, _tools?: unknown): Promise<AgentResult> {
  return (await loadCore())(router, { ...opts, mode: 'ask' });
}
