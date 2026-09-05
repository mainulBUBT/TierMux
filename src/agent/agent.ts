

// The stable contract chatViewProvider.ts depends on — TierMux's own types only, no AI SDK
// type here or above. Everything AI-SDK-shaped lives in ./core/*, loaded lazily so this file
// stays vscode-free.
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
  /** SDK finish reason ('stop' | 'length' | 'tool-calls' | 'unknown') so the webview's
   *  empty-reply placeholder can tell budget exhaustion from a model that chose to stop. */
  finishReason?: string;
  platform?: string;
  model?: string;
  runtimeName?: string;
  taskKind?: string;
  workMessages?: ChatMessage[];
  paused?: boolean;
  /** Set when the turn STOPPED ITSELF: 'budget' — the step cap cut it mid-tool-calls; 'stuck'
   *  — the same tool call failed identically REPEAT_FAILURE_LIMIT times. Both also set
   *  `paused`. Undefined = the model concluded on its own terms. */
  stopReason?: 'budget' | 'stuck';
  /** The validated structure plan mode's `exitPlanMode` tool produced; the host renders the
   *  plan card from it. Undefined = no plan proposed this turn. */
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
  /** End-of-turn verify gate: 'passed' — the verify command exited 0 (possibly after fix
   *  rounds); 'failed' — non-zero even after `agent.verifyFixRounds`; 'unverified' — files were
   *  mutated but no verify command produced a signal. Undefined — no mutation. */
  verifyOutcome?: 'passed' | 'failed' | 'unverified';
  /** Structured end-of-turn report, emitted for turns that changed files; the host persists it
   *  and the webview renders the ResultCard from it. */
  workReport?: import('../shared/workReport').WorkReportData;
}

/** "Why this model?" rationale from the picker, forwarded by routerProvider. */
export interface SelectionRationaleInfo {
  taskKind: string;
  picked?: string;
  entries: Array<{ model: string; selected: boolean; score: number; capability: number; runtime: number; preference: number; confidence: number; reason: string; skip?: string; keyless?: boolean }>;
}

export type AgentMode = 'plan' | 'agent' | 'ask';

export interface AgentOpts {
  messages: ChatMessage[];
  mode: AgentMode;
  effort: ReasoningEffort;
  abortSignal?: AbortSignal;
  pinnedModel?: string;
  /** Host auto-approve toggle for this session — forwarded to the toolApproval policy. */
  autoApprove?: boolean;
  /** Tool-result aging level for this turn — mirrors the tiermux.agent.toolCompaction
   *  setting ('off' | 'light' | 'aggressive'). Threaded from host settings. */
  toolCompaction?: 'off' | 'light' | 'aggressive';
  /** Hard cap on model round-trips in one turn — mirrors `tiermux.agent.maxStepsPerTurn`.
   *  Omitted ⇒ the engine's default. */
  maxStepsPerTurn?: number;
  /** Fix-and-recheck rounds after the end-of-turn verify command fails — mirrors
   *  `tiermux.agent.verifyFixRounds`, threaded from host settings. 0 reports the failure
   *  without retrying; it never disables the gate itself (that is `verifyCommand: 'off'`). */
  verifyFixRounds?: number;
  /** `platform::modelId` keys to skip during Auto selection for this call only. Ignored when
   *  `pinnedModel` is set. */
  excludeModels?: string[];
  taskKind?: string;
  /** TierMux chat session id. */
  sessionId?: string;
  /** Per-turn request id. */
  requestId?: string;
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
  /** A tool call is paused pending approval — resolved by src/permissions/policy.ts. */
  onPermissionAsk?: (info: { title: string; pattern?: string | string[]; command?: string; toolName?: string }) => Promise<'once' | 'always' | 'reject'>;
  onError: (message: string) => void;
  onWarning?: (message: string) => void;
  /** Turn telemetry sink — set by runTurn itself (not callers); every model call the turn
   *  makes (planner, executor, judges, recap) reports its provider-measured usage here so
   *  WorkReportData.telemetry reflects the WHOLE turn. See src/shared/workReport.ts. */
  usageSink?: (info: { inputTokens: number; outputTokens: number; contextTokens: number; contextWindow?: number; model: string; pass?: number }) => void;
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
