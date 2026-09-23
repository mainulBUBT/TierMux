// The stable contract chatViewProvider.ts depends on — TierMux's own types only. The Cline
// engine lives in ./core/cline/*, loaded lazily so this file stays vscode-free.
import type { ChatMessage, ReasoningEffort, AskQuestion, AskResult } from '../shared/types';

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
  /** 'stop' | 'unknown' — lets the webview's empty-reply placeholder tell a failure from a
   *  model that chose to stop. */
  finishReason?: string;
  platform?: string;
  model?: string;
  runtimeName?: string;
  taskKind?: string;
  workMessages?: ChatMessage[];
  paused?: boolean;
  /** Set when the turn ended via the genuine-error catch path (not abort) — `onError` already
   *  surfaced a message to the UI. Callers must NOT also render this as a normal completed
   *  turn (empty text + a real footer reads as a phantom "successful" blank reply). */
  failed?: boolean;
  /** The failure message when `failed` is true — same text already sent to `onError`, exposed
   *  here so the caller can render it as a proper reply bubble instead of leaving the user with
   *  only the thin error notice and no visible response in the conversation. */
  errorMessage?: string;
  /** Files Cline's editor created or modified this turn, for the "Files changed" recap. */
  changedFiles?: { path: string; status: 'created' | 'modified' | 'deleted' }[];
}

/** "Why this model?" rationale from the picker, forwarded by routerProvider. */
export interface SelectionRationaleInfo {
  taskKind: string;
  picked?: string;
  entries: Array<{ model: string; selected: boolean; score: number; capability: number; runtime: number; preference: number; confidence: number; reason: string; skip?: string; keyless?: boolean }>;
}

export type AgentMode = 'plan' | 'agent';

export interface AgentOpts {
  messages: ChatMessage[];
  mode: AgentMode;
  effort: ReasoningEffort;
  abortSignal?: AbortSignal;
  pinnedModel?: string;
  /** Host auto-approve toggle for this session — forwarded to the toolApproval policy. */
  autoApprove?: boolean;
  /** tiermux.agent.toolCompaction: 'off' compacts only on a provider overflow. */
  toolCompaction?: string;
  /** Hard cap on model round-trips in one turn — mirrors `tiermux.agent.maxStepsPerTurn`.
   *  Omitted ⇒ the engine's default. */
  maxStepsPerTurn?: number;
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
  onTool: (e: ToolEvent) => void;
  onReasoning: (text: string) => void;
  onModel: (platform: string, model: string, runtimeName?: string) => void;
  onFailover: (from: string, reason: string) => void;
  onSelectionRationale?: (info: SelectionRationaleInfo) => void;
  onKeyRotated?: (info: { platform: string; keyIndex: number; keyTotal: number }) => void;
  onStep: (phase: 'thinking' | 'status', label?: string) => void;
  /** Checkpoint baseline — fired before Cline's editor writes a file, with its pre-write
   *  content (null = about to be created). The host wires this to CheckpointManager.record();
   *  type-only vscode reference (erased at runtime — this file stays vscode-free). */
  onBeforeWrite?: (uri: import('vscode').Uri, before: string | null) => void;
  onAskUser: (questions: AskQuestion[]) => Promise<AskResult>;
  /** A tool call is paused pending approval — resolved by src/permissions/policy.ts. */
  onPermissionAsk?: (info: { title: string; pattern?: string | string[]; command?: string; toolName?: string }) => Promise<'once' | 'always' | 'reject'>;
  onError: (message: string) => void;
  /** Mid-run steering handle. Called once with the handle before the run starts and with
   *  `undefined` after it settles; `push(text)` queues a user message the runtime injects at
   *  the next iteration boundary (interrupting only the in-flight model request). */
  onSteerReady?: (steer: { push: (text: string) => void } | undefined) => void;
  /** Turn telemetry sink — every model request the turn makes reports its provider-measured
   *  usage here. See src/shared/workReport.ts. */
  usageSink?: (info: { inputTokens: number; outputTokens: number; contextTokens: number; contextWindow?: number; model: string; pass?: number }) => void;
}

// Lazy/dynamic on purpose: the engine imports `vscode`. This file stays vscode-free so headless
// tests can import it for its types.
let runTurn: typeof import('./core/cline/clineEngine').runTurn | undefined;
async function loadCore(): Promise<typeof import('./core/cline/clineEngine').runTurn> {
  if (!runTurn) ({ runTurn } = await import('./core/cline/clineEngine'));
  return runTurn;
}

/** Agent mode: Cline's act mode. Model selection lives in router/picker.ts, served to Cline
 *  through core/cline/routerModel. The trailing `_tools` param is unused. */
export async function runAgentStream(opts: AgentOpts, _tools?: unknown): Promise<AgentResult> {
  return (await loadCore())(undefined, { ...opts, mode: 'agent' });
}

/** Plan mode: Cline's plan mode — no editor tool, and the policy hard-denies mutation. */
export async function runPlanStream(opts: AgentOpts, _tools?: unknown): Promise<AgentResult> {
  return (await loadCore())(undefined, { ...opts, mode: 'plan' });
}
