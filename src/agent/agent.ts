

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

export interface AgentOpts {
  messages: ChatMessage[];
  mode: 'agent' | 'plan' | 'ask';
  effort: ReasoningEffort;
  abortSignal?: AbortSignal;
  pinnedModel?: string;
  taskKind?: string;
  /** TierMux chat session id. */
  sessionId?: string;

  onChunk: (text: string) => void;
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
  onPermissionAsk?: (info: { title: string; pattern?: string | string[]; command?: string }) => Promise<'once' | 'always' | 'reject'>;
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
