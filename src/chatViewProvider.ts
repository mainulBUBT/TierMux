import * as vscode from 'vscode';
import type { ChatContent, ChatContentBlock, ChatMessage, Platform, TodoItem, CustomEndpoint, ReasoningEffort, PlanRunState } from './shared/types';
import type { SecretStore } from './config/secrets';
import type { SettingsStore } from './config/settingsStore';
import type { Catalog } from './catalog/catalog';
import type { UsageTracker } from './config/usage';
import type { UsageStore } from './config/usageStore';
import type { Mode } from './shared/types';
import { runAgentStream, runPlanStream, runAskStream, type AgentResult, type AgentOpts, type AgentMode, type ToolEvent } from './agent/agent';
import { findTextInWorkspace } from './context/textSearch';
import { classifyTask } from './agent/routing';
import { decideStepRound } from './agent/core/stepEngine';
import { runPlan } from './agent/core/planRunner';
import { clearFindings } from './agent/sessionFindings';
import { PRODUCT_NAME } from './shared/branding';
import { SETTINGS_META, defaultForSetting } from './settingsMeta';
import type { Router } from './router/router';
import { AllModelsFailedError } from './router/router';
import type { McpManager } from './mcp/mcpManager';
import { CheckpointManager, type SerializedCheckpoint } from './edits/checkpoints';
import { isDangerous } from './edits/commandGate';
import { statusLines } from './edits/gitSnapshot';
import type { ModelStatsStore, Vote } from './config/modelStats';
import type { SlowModelStore } from './config/slowModel';
import { loadMcpRegistry, searchRemoteMcp } from './mcp/registry';
import type { McpRegistryItem, McpServerConfig } from './messages';
import type { AnnouncementItem, Attachment, ConfigPayload, InMessage, KeyStatusInfo, OutMessage, PlanDataPayload, SelectionRationale, SessionStatus, TranscriptMessage, TranscriptStep } from './messages';
import { renderLegacyMarkdown } from './shared/workReport';
import { resolveVerifyCommand, runVerifyCommand } from './agent/core/tools/workspace/verifyCommand';
import { fetchAnnouncements as fetchWorkerAnnouncements, markAnnouncementsSeen, unseenAnnouncementCount } from './catalog/announcements';
import { normalizeMcpServerConfig } from './mcp/mcpClient';
import { getNonce } from './util/nonce';
import { diagLog } from './util/diag';
import { getPlatformInfo } from './providers';
import { parseSlash, resolveMentions, searchMentions } from './context/mentions';
import { activeEditorRelPath, buildActiveEditorContext, buildDiagnosticsContext } from './context/activeContext';
import { contentToString } from './agent/content';
import { getSnapshot as getRetrievalSnapshot } from './context/telemetry';
import { ATTACHMENT_FILE_FILTERS, IMAGE_BYTE_LIMIT, buildAttachmentFromUri, isSupportedAttachmentPath, kindForPath as kindFromName, lastPdfFailureReason, mimeForPath as mimeForName } from './util/extractAttachments';
import { estimateMessagesTokens } from './agent/budget';
import { TITLE_SYSTEM } from './agent/prompts';
import { condenseHistory, shouldCondense, generateHandoff } from './agent/condense';
import { resolveExecutionProfile } from './agent/executionProfile';
import { resolveClarifying, type ClarifyingQuestion } from './agent/clarify';
import { structurePlanSteps, formatStructuredSteps, extractPlanFromProse, repairPlanSteps } from './agent/planStructurer';
import { deriveTitleFrom, extractSubjectTerms, looksLikeActionablePlan, looksLikeGroundedAnswer, offTopicCorrection, sanitizeTitle, planStepsToTodos } from './session/titles';

import { loadSkills } from './context/skills';

interface ChatDeps {
  secrets: SecretStore;
  settings: SettingsStore;
  catalog: Catalog;
  usage: UsageTracker;
  usageStore: UsageStore;
  router: Router;
  mcp: McpManager;
  modelStats: ModelStatsStore;
  slowModels: SlowModelStore;
  workspaceState: vscode.Memento;
  /** Global (per-user) state — announcement seen/notified tracking lives here, alongside the catalog cache. */
  globalState: vscode.Memento;
  generateCommitMessage: () => Promise<void>;
  profiler?: import('./profiler/profilerService').IProfilerService;
  /** Re-attempt the OC engine startup (binary resolve/download + launch). Wired from
   *  extension.ts; invoked by the webview's onboarding "Retry" button. */
  retryEngine?: () => void;
}

function tokenToAbortSignal(token: import('vscode').CancellationToken): AbortSignal {
  const ctrl = new AbortController();
  if (token.isCancellationRequested) ctrl.abort();
  else token.onCancellationRequested(() => ctrl.abort());
  return ctrl.signal;
}

const SESSIONS_KEY = 'tiermux.sessions';
const CURRENT_KEY = 'tiermux.currentSession';
const AUTO_APPROVE_KEY = 'tiermux.autoApprove';
const MAX_SESSIONS = 50;
/** Tool calls that count as "Modifications" for a session's tab activity badge (see `Session.liveActivity`). */
const WRITE_TOOL_NAMES = new Set(['writeFile', 'createFile', 'editFile', 'deleteFile', 'runCommand']);
/** Of those, the ones that touch a single identifiable file path (excludes runCommand). */
const FILE_WRITE_TOOL_NAMES = new Set(['writeFile', 'createFile', 'editFile', 'deleteFile']);

/** Pull a file path out of a write/edit/create/delete tool call's args, tolerant of the
 *  several key names OC's tools have used (see media/src/ui/tool/ToolCard.ts's own copy of
 *  this same tolerance for rendering tool-card titles). */
function extractToolFilePath(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  const v = a.path ?? a.file ?? a.filePath ?? a.filename ?? a.relativePath;
  return typeof v === 'string' && v ? v : undefined;
}

/** Build an AI Elements Plan payload from the agent's flat `TodoItem[]` list. The plan is a
 *  single section (the agent's todos are flat; sections exist for richer future sources) and
 *  mirrors the running/completed/pending state 1:1. */
function planDataFromTodos(title: string, todos: TodoItem[]): PlanDataPayload {
  const tasks = todos.map((t, i) => ({
    id: `task-${i + 1}`,
    title: t.content,
    completed: t.status === 'completed',
    running: t.status === 'in_progress',
    pending: t.status === 'pending',
  }));
  return {
    id: `plan-${Date.now()}`,
    title,
    createdAt: Date.now(),
    sections: [{ id: 'plan-steps', title: 'Steps', tasks }],
    totalTasks: tasks.length,
    completedTasks: tasks.filter((t) => t.completed).length,
  };
}

/** Deterministic end-of-turn footer built directly from todo state, not trusted to the model's
 *  self-report. Surfaces whenever the turn ends (stop-guardrail, round-cap, or plain completion)
 *  while the plan written THIS send still has unfinished items, so the user isn't left assuming
 *  the task actually finished. */
function incompleteTodosNote(allTodos: TodoItem[], remainingTodos: TodoItem[]): string {
  const doneCount = allTodos.length - remainingTodos.length;
  const list = remainingTodos
    .map((t) => `- ${t.content}${t.status === 'in_progress' ? ' (in progress)' : ''}`)
    .join('\n');
  return `\n\n---\n**Stopped with unfinished work — ${doneCount}/${allTodos.length} steps done.** Remaining:\n${list}`;
}

/** Companion to {@link incompleteTodosNote}: a short deterministic brief for the success case,
 *  built the same way (from todo state, not the model's self-report) so a finished plan always
 *  ends with an explicit "here's what got done" recap instead of relying on the model to
 *  volunteer one. */
function completedTodosNote(allTodos: TodoItem[]): string {
  const list = allTodos.map((t) => `- ${t.content}`).join('\n');
  return `\n\n---\n**Completed all ${allTodos.length} steps:**\n${list}`;
}

/** A short, bare "keep going" message — NOT a fresh task. Weak free models often re-plan from
 *  scratch on such a message (worse if history was compacted), redoing finished work. We detect it
 *  to splice in explicit resume context (see resumeContextBlock). Kept intentionally narrow: only
 *  a message that is ESSENTIALLY just a continuation word, so a real instruction like "continue but
 *  use TypeScript" is left untouched. */
const CONTINUATION_RE = /^(continue|keep going|go on|carry on|proceed|resume|go ahead|carry on then|finish it|finish|next|keep going please|continue please|yes continue)\b[\s!.]*$/i;
function isBareContinuation(text: string): boolean {
  const t = (text || '').trim();
  return t.length > 0 && t.split(/\s+/).length <= 4 && CONTINUATION_RE.test(t);
}

/** Resume context spliced into the MODEL-facing copy of a bare "continue" message (the displayed
 *  transcript still shows only what the user typed). Names the still-unfinished plan items so the
 *  model picks up exactly where it left off instead of restarting. */
function resumeContextBlock(remainingTodos: TodoItem[]): string {
  const list = remainingTodos
    .map((t) => `- ${t.content}${t.status === 'in_progress' ? ' (in progress)' : ''}`)
    .join('\n');
  return '[Resume context: the previous turn left the plan below unfinished. Continue from the work '
    + 'already done earlier in this conversation — do NOT restart or repeat completed steps. Update '
    + `the todo list as you finish each item.]\n\nRemaining items:\n${list}`;
}

/** Append a context block to a user message's content, preserving any attachment blocks. */
function withContextBlock(content: ChatContent, block: string): ChatContent {
  if (typeof content === 'string' || content == null) return `${content ?? ''}\n\n${block}`.trim();
  return [...content, { type: 'text', text: block }];
}

/** Append resume context to a user message's content, preserving any attachment blocks. */
function withResumeContext(content: ChatContent, remainingTodos: TodoItem[]): ChatContent {
  return withContextBlock(content, resumeContextBlock(remainingTodos));
}

/**
 * Tag a user turn with the mode that governs it, but only when the mode CHANGED.
 *
 * Mode reaches the model only through the system prompt and the tool set, and both are swapped
 * silently. The transcript, meanwhile, is one shared history: switch Agent → Ask and the model
 * still sees its own `editFile`/`writeFile` calls sitting a few messages back, with nothing
 * saying those powers are gone. It then tries an edit, gets denied, and burns a turn — or worse,
 * narrates as though it had made the change. Cline tags every user message for exactly this
 * reason ("the newest message's mode is what governs right now, regardless of what earlier
 * messages allowed").
 *
 * Only on change, not every message: an unchanged mode is already implied by the system prompt,
 * and repeating a tag on every turn spends context on free-tier models to say nothing new.
 */
function withModeTag(content: ChatContent, mode: AgentMode, previousMode: AgentMode | undefined): ChatContent {
  if (previousMode === undefined || previousMode === mode) return content;
  const can = mode === 'agent'
    ? 'You can edit files and run commands again.'
    : mode === 'plan'
      ? 'You can read and run read-only commands, but NOT edit files. Produce a plan, do not implement it.'
      : 'You can read and run read-only commands, but NOT edit files. Answer the question.';
  return withContextBlock(
    content,
    `[Mode changed: ${previousMode} → ${mode}. This mode governs from now on, whatever earlier `
    + `messages in this conversation did. ${can}]`,
  );
}

/** A short follow-up that leans on a pronoun ("it", "that") or opens with a correction ("no",
 *  "don't", "wait") without naming what it's about — e.g. "no fix it", "make it faster", "undo
 *  that". Unlike {@link isBareContinuation} these aren't a fixed phrase, so weak models (and
 *  sometimes strong ones) read them as a fresh, contextless request instead of tying them back
 *  to the last thing the agent did. Kept to short messages only: a longer sentence usually spells
 *  out its own context ("that error you mentioned in api.ts is still happening"). */
const AMBIGUOUS_FOLLOWUP_REF_RE = /\b(it|that|this|those|same|again|instead)\b/i;
const AMBIGUOUS_FOLLOWUP_START_RE = /^(no|nope|nah|don'?t|actually|wait|hm+|not (quite|really))\b/i;
function isAmbiguousFollowup(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  if (t.split(/\s+/).length > 10) return false;
  return AMBIGUOUS_FOLLOWUP_START_RE.test(t) || AMBIGUOUS_FOLLOWUP_REF_RE.test(t);
}

/** Find the most recent tool action(s) in history to anchor an ambiguous follow-up to. Prefers
 *  the last run of assistant tool_calls plus their tool results (what "it"/"that" almost always
 *  means right after a command); falls back to the last assistant text reply if no tool has run
 *  yet this session. */
function lastActionSummary(history: ChatMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i] as any;
    if (msg?.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const results = new Map<string, string>();
      for (let j = i + 1; j < history.length; j++) {
        const m2 = history[j] as any;
        if (m2?.role !== 'tool' || !m2.tool_call_id) break;
        results.set(m2.tool_call_id, typeof m2.content === 'string' ? m2.content : JSON.stringify(m2.content ?? ''));
      }
      const lines = msg.tool_calls.slice(0, 4).map((tc: any) => {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* leave empty */ }
        const argSummary = Object.entries(args).slice(0, 2).map(([k, v]) => `${k}=${String(v).slice(0, 80)}`).join(', ');
        const out = (results.get(tc.id) || '').slice(0, 400);
        return `- ${tc.function?.name}(${argSummary})${out ? ` → ${out}` : ''}`;
      });
      return lines.join('\n') || null;
    }
    if (msg?.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim()) {
      return msg.content.trim().slice(0, 400);
    }
  }
  return null;
}

/** Companion to {@link resumeContextBlock}: names the last action instead of the remaining plan,
 *  so a short pronoun-y follow-up resolves against what the agent just did rather than being read
 *  as a brand-new, unrelated request. */
function ambiguousFollowupBlock(summary: string): string {
  return '[Context note: the previous action in this conversation was:\n' + summary
    + '\n\nThe message below is a short follow-up and most likely refers to that action or its '
    + 'result — interpret it in that context rather than asking what "it"/"that" refers to, unless '
    + 'it is genuinely unrelated.]';
}

/**
 * One chat session's full state — both the persisted conversation (history/transcript/title)
 * and the never-persisted runtime (the in-flight run, approvals, checkpoints, votes). Promoting
 * all of this off the provider onto a per-session object is what lets multiple agents run at
 * once: each session owns its own run, and the provider just tracks which one is viewed.
 */
interface Session {
  id: string;
  history: ChatMessage[];
  transcript: TranscriptMessage[];
  title?: string;
  titleGenerated: boolean;
  /** Set when the user manually renamed this session — suppresses auto-title overrides
   *  from OC's `session.updated` so a user-chosen name sticks. */
  userRenamedTitle?: boolean;
  createdAt: number;
  updatedAt: number;

  activeRequestId?: string;
  cancel?: vscode.CancellationTokenSource;
  pendingApprovals: Map<string, (approved: boolean) => void>;
  pendingPermissions: Map<string, (response: 'once' | 'always' | 'reject') => void>;
  /** Tool kinds (e.g. `editFile`, `runCommand`) the user chose "Always" for this session — future
   *  calls to a listed tool auto-approve without re-asking. Session-scoped and in-memory (resets on
   *  reload). A dangerous command is NEVER added here, so it keeps prompting even after an "Always". */
  alwaysAllowTools: Set<string>;
  /** Mode the previous user turn in this session ran under, so a switch can be announced to the
   *  model in the transcript itself — see withModeTag. Undefined until the first turn. */
  lastMode?: AgentMode;
  approvalSeq: number;
  /** Ephemeral interactive cards (approvals / plan / clarifying) awaiting a click, cached so
   *  they re-render when the user switches back to a session whose run is blocked on them. */
  cards: OutMessage[];
  voteCtx: Map<string, { taskKind: string; platform: string; model: string; last: Vote }>;
  pendingPlanUser?: ChatContent;
  /** URI of the plan MD file saved at proposal time — updated if the user edits steps before approving. */
  pendingPlanFile?: { uri: vscode.Uri; title: string };
  pendingClarify?: { requestId: string; userContent: ChatContent; prompt: string; questions: ClarifyingQuestion[]; mode: 'plan' | 'agent' };
  /** In-flight `askUser` tool calls, keyed by OpenAI tool_call_id, awaiting a webview answer. */
  pendingAskUser: Map<string, (answer: string) => void>;
  /** True while an approved plan is being executed in Agent mode — drives the "Following the approved plan" header. */
  executingPlan?: boolean;
  /** First-class plan execution state (see core/planRunner.ts). Present while an approved plan
   *  is running or paused; persisted with the session so a reload can resume from currentStep. */
  planRun?: PlanRunState;
  checkpoints: CheckpointManager;
  lastWindow: number;

  livePlatform?: string;
  liveModel?: string;
  liveRuntimeName?: string;
  lastStepLabel?: string;
  lastTodos?: TodoItem[];
  /** Coarse "what's it doing right now" label shown next to this session's title in the tab
   *  list — 'Text change' while the model is streaming an answer, 'Modifications' while it's
   *  writing/editing/deleting a file or running a command. Cleared (via setStatus) once the
   *  run leaves 'running'/'queued', so a finished/idle session shows no activity badge. */
  liveActivity?: string;
  /** Tool steps accumulated per active requestId, attached to the assistant transcript entry at
   *  turn completion so a re-rendered message (e.g. after "Revert to here") keeps its step list. */
  liveSteps: Map<string, TranscriptStep[]>;
  /** Last selection rationale reported for each in-flight requestId, so pushAssistantTurn can
   *  persist it on the transcript entry (the (?) popover must survive a reload). Same
   *  keyed-by-requestId lifecycle as liveSteps: set while running, drained at turn end. */
  liveRationale: Map<string, SelectionRationale>;
  /** git-status snapshot (porcelain lines) captured just BEFORE each agent shell command runs,
   *  keyed by toolCallId — diffed against a just-after snapshot to attribute workspace edits to
   *  the agent's commands (see onTool in agentCallbacks). Edit-tool writes don't need this;
   *  they're attributed via CheckpointManager.record(). */
  commandBaselines: Map<string, Promise<Map<string, string>>>;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** How many `@mentions` resolved into context on the most recent send — carried through to
   *  AgentOpts.mentionCount so routing (classifyTaskCore) can tell "content already supplied"
   *  turns apart from ambiguous ones without re-parsing the message text. Persists across a
   *  retry of the same turn (only overwritten by the next fresh send). */
  lastMentionCount?: number;
  /** Set by the `watchdogAction` handler ('restartRequest'/'switchModel'), consumed by the send
   *  handler's retry loop right after the aborted run settles — reusing the same in-flight
   *  request instead of pushing a new user turn. Cleared once consumed. */
  pendingWatchdogRetry?: 'restart' | 'switch';
  /** Incremental snapshot of the CURRENTLY RUNNING turn's tool transcript, updated after every
   *  tool completion (see agentCallbacks' onTool) and persisted immediately so a crash mid-turn
   *  (extension host restart) doesn't lose in-progress work. Cleared by clearInProgressTurn()
   *  once the run finishes normally — persistAgentTurn() has already committed the authoritative
   *  transcript into `history` by then, so this is purely a crash-recovery fallback. */
  inProgressTurn?: { requestId: string; workMessages: ChatMessage[] };
}

interface StoredSession {
  id: string;
  title: string;
  ts: number;
  transcript: TranscriptMessage[];
  model?: string;
  reasoningEffort?: string;
  /** The user renamed this session by hand — its title is locked against all auto-titling,
   *  persisted so the protection survives a reload (see maybeGenerateTitle/hydrateSession). */
  userRenamedTitle?: boolean;
  /** Full model-facing conversation history. Persisted (in addition to `transcript`, the UI
   *  display log) so the model's actual memory of the conversation survives a VSCode/extension
   *  restart — without this, every session reload wiped the LLM-facing history back to empty
   *  even though the user still saw their past messages onscreen. */
  history?: ChatMessage[];
  /** Present only if the last run for this session never finished (e.g. the extension host
   *  crashed mid-turn). Recovered into `history` on the next hydrate — see hydrateSession(). */
  inProgressTurn?: { requestId: string; workMessages: ChatMessage[] };
  /** The last todo list this session showed, persisted so a "continue" after a reload can still
   *  splice the remaining items into the resume message (see withResumeContext). */
  lastTodos?: TodoItem[];
  /** Tool kinds the user chose "Always" for, persisted so the per-tool allowlist survives a reload
   *  instead of re-prompting. Stored as an array (Set isn't JSON-serializable). */
  alwaysAllowTools?: string[];
  /** Per-turn edit checkpoints, persisted so "Revert to here" / "Undo all" still restore real
   *  file content after an extension host restart. Without this, CheckpointManager was rebuilt
   *  empty on every hydrate — the revert button stayed visible and the confirm dialog still
   *  fired, but silently restored 0 files, quietly breaking a promise the UI kept making. */
  checkpoints?: SerializedCheckpoint[];
  /** Plan-execution state for the first-class plan runner — persisted so an interrupted plan
   *  survives a reload. A stored `running` state is demoted to `paused` on hydrate (the run
   *  itself died with the window) and the webview offers Resume. */
  planRun?: PlanRunState;
}

/**
 * Discover the model list for an OpenAI-compatible endpoint.
 */
async function fetchOpenAICompatModels(
  baseUrl: string,
  key: string | undefined,
  extraHeaders?: Record<string, string>,
): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { Accept: 'application/json', ...(extraHeaders ?? {}) };
  if (key) headers.Authorization = `Bearer ${key}`;

  const tryFetch = async (url: string): Promise<{ ok: boolean; status: number; body: unknown }> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
      const body = res.ok ? await res.json().catch(() => undefined) : undefined;
      return { ok: res.ok, status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await tryFetch(`${base}/models`);
  if (!res.ok && res.status === 404 && !/\/v1$/i.test(base)) {
    res = await tryFetch(`${base}/v1/models`);
  }
  if (!res.ok) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? 'Unauthorized — check the API key for this endpoint.'
        : `Endpoint returned HTTP ${res.status} for /models.`,
    );
  }

  const raw = res.body as { data?: unknown; models?: unknown } | unknown[] | undefined;
  const list = Array.isArray(raw) ? raw
    : Array.isArray((raw as { data?: unknown })?.data) ? (raw as { data: unknown[] }).data
    : Array.isArray((raw as { models?: unknown })?.models) ? (raw as { models: unknown[] }).models
    : [];
  const ids = list
    .map((entry) => typeof entry === 'string' ? entry : String((entry as { id?: unknown })?.id ?? '').trim())
    .filter((id): id is string => !!id);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** Helper to resolve the display name for a custom endpoint (or built-in platform). */
function displayNameForEntry(entry: { platform: string; modelId: string }, deps: ChatDeps): string {
  if (entry.platform === 'custom') {
    const epId = entry.modelId.split('::')[0];
    const endpoint = deps.settings.getCustomEndpoint(epId);
    return endpoint?.name ?? 'Custom';
  }
  return entry.platform;
}

/**
 * Source-of-truth provider label for a turn's footer. Prefers the name the router reported for
 * the run; falls back to the pinned model's platform when the run produced no metadata (empty
 * or errored turn) so the footer never goes blank as `/modelId` — the user always sees which
 * provider their pinned selection targeted, even when it failed to respond.
 */
function turnPlatformLabel(pinnedModel: string | undefined, reported: { runtimeName?: string; platform?: string } | undefined, deps: ChatDeps): string {
  if (reported?.runtimeName) return reported.runtimeName;
  if (reported?.platform) {
    if (reported.platform === 'custom') return 'Custom';
    return getPlatformInfo(reported.platform as import('./shared/types').Platform)?.name ?? reported.platform;
  }
  // No run metadata — use the pinned platform (the model the user actually picked).
  const pinned = pinnedModel && pinnedModel !== 'auto' ? pinnedModel.split('::')[0] : undefined;
  if (!pinned) return '';
  if (pinned === 'custom') {
    const epId = (pinnedModel!.split('::')[1] || '').split('::')[0];
    return deps.settings.getCustomEndpoint(epId)?.name ?? 'Custom';
  }
  return getPlatformInfo(pinned as import('./shared/types').Platform)?.name ?? pinned;
}

/**
 * Bare modelId for a turn's footer. When the user pinned a specific model (not Auto), strip the
 * `platform::` prefix so the footer's `${platform}/${model}` never double-prefixes (e.g.
 * "poolside/poolside::poolside/laguna-xs-2.1"). Falls back to whatever the run reported when
 * Auto picked the model itself.
 */
function turnModelLabel(pinnedModel: string | undefined, reportedModel: string | undefined): string | undefined {
  return (pinnedModel && pinnedModel !== 'auto')
    ? pinnedModel.includes('::') ? pinnedModel.split('::').slice(1).join('::') : pinnedModel
    : reportedModel;
}

/**
 * If the agent's response ends with a question or an invitation for user input, extract the
 * last paragraph as the prompt text. Covers both `?`-terminated questions and common
 * conversational forms that don't end with a question mark (e.g. "Let me know which step",
 * "Please tell me", "Which one would you prefer").
 */

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'tiermux.chat';
  private view?: vscode.WebviewView;
  private sessions = new Map<string, Session>();
  /** The session currently displayed in the webview (runs in OTHER sessions keep going). */
  private viewedSessionId: string;
  /** Per-session tab status (idle/queued/running/needsApproval/finished). */
  private statusOf = new Map<string, SessionStatus>();
  private ready = false;
  private outQueue: OutMessage[] = [];
  private mcpRegistry?: McpRegistryItem[];
  /** Concurrency cap state: sessions with a live agent run + the FIFO of waiting starts. */
  private runningSessions = new Set<string>();
  private runQueue: Array<{ sessionId: string; resolve: () => void }> = [];
  /** One background-approval notification per (sessionId, requestId). */
  private approvalNotified = new Set<string>();
  private approvalSeqGlobal = 0;
  /**
   * Session Auto-approve: when true, the command/edit gates skip the inline prompt and run
   * unattended (dangerous commands still confirm). Read live by both gates; persisted per workspace.
   * Shared across all sessions — a workspace-level preference.
   *
   * Defaults to true so the agent runs commands/edits autonomously like other coding agents
   * (Claude Code, Cursor): only commands matching the DANGEROUS list (rm -rf, git push --force,
   * sudo...) still prompt. Users who want per-action confirmation can turn it off in the composer.
   */
  autoApprove = true;

  constructor(private readonly extensionUri: vscode.Uri, private readonly deps: ChatDeps) {
    this.autoApprove = deps.workspaceState.get<boolean>(AUTO_APPROVE_KEY, true);
    const stored = this.loadSessions();

    for (const s of stored) this.sessions.set(s.id, this.hydrateSession(s));
    this.viewedSessionId = this.createSession().id;
    deps.secrets.onDidChange(() => void this.sendConfig());
    deps.settings.onDidChange(() => void this.sendConfig());
  }

  /**
   * Slash-command skills loaded from `.tiermux/skills/*.md` (bundled defaults, overridable
   * per-workspace). loadSkills() caches in-memory and invalidates via fs.watch, so an edited
   * skill file still takes effect on the next `/name` without paying disk I/O on every call.
   */
  private skills() {
    return loadSkills(this.extensionUri.fsPath, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  }

  private newSessionId(): string {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** Build a fresh, empty session (for New chat). */
  private createSession(): Session {
    const now = Date.now();
    const s: Session = {
      id: this.newSessionId(),
      history: [],
      transcript: [],
      title: undefined,
      titleGenerated: false,
      createdAt: now,
      updatedAt: now,
      pendingApprovals: new Map(),
      pendingPermissions: new Map(),
      alwaysAllowTools: new Set(),
      approvalSeq: 0,
      voteCtx: new Map(),
      cards: [],
      pendingAskUser: new Map(),
      checkpoints: new CheckpointManager(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
      lastWindow: 0,
      liveSteps: new Map(),
      liveRationale: new Map(),
      commandBaselines: new Map(),
      model: undefined,
      reasoningEffort: undefined,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  /** Rehydrate a persisted session with empty runtime state. If the last run never finished
   *  (an `inProgressTurn` was left behind — a crash mid-turn), its partial tool transcript is
   *  merged into `history` so the agent's memory of that work isn't silently lost, and a visible
   *  transcript note tells the user what happened. */
  private hydrateSession(s: StoredSession): Session {
    const recovered = s.inProgressTurn?.workMessages;
    const transcript = s.transcript ?? [];
    if (recovered?.length) {
      transcript.push({
        role: 'assistant',
        text: `⚠️ The previous run in this chat didn't finish (the extension likely restarted mid-task). Recovered ${recovered.length} tool step(s) from before the interruption — you can continue from here.`,
        ts: Date.now(),
      });
    }
    return {
      id: s.id,
      history: recovered?.length ? [...(s.history ?? []), ...recovered] : (s.history ?? []),
      transcript,
      title: s.title,
      // The 'Starting Conversation' stand-in is NOT a generated title — a session that only
      // ever saw small talk still gets its one-shot real title on its first real message.
      titleGenerated: !!(s.title && s.title.trim() !== 'Starting Conversation') || !!s.userRenamedTitle,
      pendingApprovals: new Map(),
      pendingPermissions: new Map(),
      alwaysAllowTools: new Set(s.alwaysAllowTools ?? []),
      lastTodos: s.lastTodos,
      approvalSeq: 0,
      voteCtx: new Map(),
      cards: [],
      pendingAskUser: new Map(),
      checkpoints: new CheckpointManager(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, s.checkpoints),
      lastWindow: 0,
      liveSteps: new Map(),
      liveRationale: new Map(),
      commandBaselines: new Map(),
      createdAt: s.ts ?? Date.now(),
      updatedAt: s.ts ?? Date.now(),
      model: s.model,
      reasoningEffort: s.reasoningEffort as ReasoningEffort | undefined,
      // A stored 'running' plan died with the window — demote to 'paused' so the webview can
      // offer Resume instead of showing a plan that claims to still be executing.
      planRun: s.planRun ? (s.planRun.status === 'running' ? { ...s.planRun, status: 'paused' } : s.planRun) : undefined,
    };
  }

  /** The session currently displayed in the webview. User-action entry points operate on it. */
  private current(): Session {
    const s = this.sessions.get(this.viewedSessionId);
    if (s) return s;

    return this.createSession();
  }

  private loadSessions(): StoredSession[] {
    return this.deps.workspaceState.get<StoredSession[]>(SESSIONS_KEY, []);
  }

  private deriveTitle(s: Session): string {
    const firstUser = s.transcript.find((t) => t.role === 'user');
    const base = (firstUser?.text ?? '').trim().replace(/\s+/g, ' ');
    return base ? base.slice(0, 60) : 'New chat';
  }

  /** Push the current session's title into the webview header; the chrome shows just the brand. */
  private updateViewTitle(): void {
    if (this.view) this.view.title = PRODUCT_NAME;

    const s = this.sessions.get(this.viewedSessionId);
    if (s) this.post({ type: 'sessionTitle', sessionId: s.id, title: s.title?.trim() || this.deriveTitle(s) || PRODUCT_NAME });
  }

  /** Save one session's conversation into the session list (most-recent first). */
  private persist(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const others = this.loadSessions().filter((x) => x.id !== sessionId);
    if (s.transcript.length) {
      others.unshift({
        id: s.id, title: s.title ?? this.deriveTitle(s), ts: Date.now(), transcript: s.transcript,
        model: s.model, reasoningEffort: s.reasoningEffort, history: s.history, inProgressTurn: s.inProgressTurn,
        userRenamedTitle: s.userRenamedTitle,
        lastTodos: s.lastTodos, alwaysAllowTools: s.alwaysAllowTools.size ? [...s.alwaysAllowTools] : undefined,
        checkpoints: s.checkpoints.toJSON(),
        planRun: s.planRun,
      });
    }
    void this.deps.workspaceState.update(SESSIONS_KEY, others.slice(0, MAX_SESSIONS));
    if (sessionId === this.viewedSessionId) void this.deps.workspaceState.update(CURRENT_KEY, sessionId);
    this.updateViewTitle();
    this.postSessionList();
  }

  /** Mark a run as in-progress right before invoking the agent runner, so a crash mid-turn can
   *  be recovered on next load (see hydrateSession()). Every call site pairs this with
   *  clearInProgressTurn() once the run settles normally. */
  private beginInProgressTurn(s: Session, requestId: string): void {
    s.inProgressTurn = { requestId, workMessages: [] };
  }

  /** Drop the crash-recovery snapshot once a run finishes normally — persistAgentTurn() has
   *  already committed the authoritative transcript into `history` by this point, so the
   *  snapshot would otherwise just be redundant (and stale on the NEXT run if left set). Keyed
   *  on requestId so a superseded/abandoned run's late finally can't clear a newer run's snapshot. */
  private clearInProgressTurn(s: Session, requestId: string): void {
    if (s.inProgressTurn?.requestId === requestId) s.inProgressTurn = undefined;
  }

  private setStatus(sessionId: string, status: SessionStatus): void {
    this.statusOf.set(sessionId, status);

    if (status !== 'running' && status !== 'queued') {
      const s = this.sessions.get(sessionId);
      if (s) s.liveActivity = undefined;
    }
    this.postSessionList();
  }

  private postSessionList(): void {
    const sessions = Array.from(this.sessions.values())
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .map((s) => ({
        id: s.id,
        title: s.title?.trim() || this.deriveTitle(s) || 'New session',
        status: this.statusOf.get(s.id) ?? 'idle',
        activity: s.liveActivity,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }));
    this.post({ type: 'sessionList', sessions });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((m: InMessage) => {
      this.onMessage(m).catch((e) => {
        // A throw anywhere in a handler (e.g. checkpoints.begin() shelling out to git and
        // failing) would otherwise become a silent unhandled rejection, leaving the webview's
        // busy/loading state stuck forever with no way for the user to recover but reloading.
        console.error('[tiermux] onMessage handler failed', m.type, e);
        const s = this.current();
        this.post({ type: 'busy', sessionId: s.id, busy: false });
        this.post({ type: 'error', sessionId: s.id, message: e instanceof Error ? e.message : String(e) });
      });
    });
    this.updateViewTitle();
  }

  /** First-run engine onboarding progress (download %, verify, ready/error) — see
   *  the 'engineStatus' OutMessage variant. Queues like any other post() if the
   *  webview isn't open yet. */
  postEngineStatus(status: { state: 'downloading' | 'starting' | 'verifying' | 'ready' | 'error'; message?: string; percent?: number }): void {
    this.post({ type: 'engineStatus', ...status });
  }

  /** Dismissible "new models added" banner above the composer, mirroring the
   *  native toast in extension.ts's notifyNewModels(). */
  postNewModels(message: string): void {
    this.post({ type: 'newModelsAvailable', message });
  }

  /** Dismissible "new providers available" banner above the composer, mirroring
   *  postNewModels — fires when a brand-new provider is registered from the catalog. */
  postNewProviders(message: string): void {
    this.post({ type: 'newProvidersAvailable', message });
  }

  /** Operator tips/announcements. Served by the catalog worker's `/announcements` endpoint
   *  (URL derived from `tiermux.catalog.url`), newest-first — see catalog/announcements.ts.
   *  Failures are swallowed — tips are non-critical and must never block the panel. */
  private lastAnnouncements: AnnouncementItem[] = [];
  private lastAnnouncementsUpdated: string | undefined;
  async fetchAnnouncements(): Promise<void> {
    const base = vscode.workspace.getConfiguration('tiermux').get<string>('catalog.url', '');
    const res = await fetchWorkerAnnouncements(base);
    if (res) this.postAnnouncements(res.items, res.lastUpdated);
  }

  /** Push an announcements snapshot (already newest-first) to the webview with the current
   *  unseen count. Public so the extension's background catalog tick can refresh the feed and
   *  the dot without waiting for the webview to become visible. */
  postAnnouncements(items: AnnouncementItem[], lastUpdated?: string): void {
    this.lastAnnouncements = items;
    this.lastAnnouncementsUpdated = lastUpdated;
    this.post({ type: 'announcements', items, lastUpdated, unseen: unseenAnnouncementCount(this.deps.globalState, items) });
  }

  private post(msg: OutMessage): void {
    if (!this.view || !this.ready) { this.outQueue.push(msg); return; }
    void this.view.webview.postMessage(msg);
  }

  /** Post an ephemeral interactive card (approval/plan/clarify) AND cache it on the session,
   *  so it re-renders if the user switches away and back while it's still pending. */
  private postCard(s: Session, msg: OutMessage): void {
    s.cards.push(msg);
    if (this.viewedSessionId === s.id) this.post(msg);
  }

  /** Drop cached cards matching a predicate (e.g. once an approval is resolved). */
  private removeCards(s: Session, pred: (m: OutMessage) => boolean): void {
    s.cards = s.cards.filter((m) => !pred(m));
  }

  /**
   * Ask the user to approve a `runCommand` call inline in the chat view, in the run's OWN
   * session. If that session isn't viewed, the card still renders in its (hidden) container
   * and we fire a one-time notification + flip its tab to "needs approval". Wired into the
   * CommandGate via the per-run RunContext (see runContext).
   */
  requestCommandApproval(sessionId: string, requestId: string, command: string, cwd?: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!this.view || !s) return Promise.resolve(false); // nowhere to ask → deny rather than hang
    try { this.view.show?.(true); } catch { /* reveal is best-effort */ }
    const id = `cmd-${++this.approvalSeqGlobal}`;
    return new Promise<boolean>((resolve) => {
      s.pendingApprovals.set(id, resolve);
      this.postCard(s, { type: 'commandApproval', sessionId, requestId, id, command, cwd });
      this.maybeNotifyApproval(sessionId, requestId, s);
    });
  }

  /**
   * Ask the user to approve a file edit/deletion inline in the chat view (the diff editor
   * still opens for review), in the run's OWN session. `undefined` (no-session overload) defers
   * to the native modal — used by the inline editor chat which has no chat thread.
   */
  requestEditApproval(req: { path: string; title: string; kind: 'write' | 'delete' }): Promise<boolean | undefined>;
  requestEditApproval(sessionId: string, requestId: string, req: { path: string; title: string; kind: 'write' | 'delete' }): Promise<boolean | undefined>;
  requestEditApproval(sessionIdOrReq: string | { path: string; title: string; kind: 'write' | 'delete' }, requestId?: string, req?: { path: string; title: string; kind: 'write' | 'delete' }): Promise<boolean | undefined> {

    if (typeof sessionIdOrReq !== 'string') return Promise.resolve(undefined);
    const sessionId = sessionIdOrReq;
    const s = this.sessions.get(sessionId);
    if (!this.view || !s || !requestId || !req) return Promise.resolve(undefined);
    try { this.view.show?.(true); } catch { /* reveal is best-effort */ }
    const id = `edit-${++this.approvalSeqGlobal}`;
    return new Promise<boolean | undefined>((resolve) => {
      s.pendingApprovals.set(id, resolve);
      this.postCard(s, { type: 'editApproval', sessionId, requestId, id, path: req.path, title: req.title, kind: req.kind });
      this.maybeNotifyApproval(sessionId, requestId, s);
    });
  }

  /**
   * Ask the user to approve/deny an OC tool call paused on an `ask` permission rule
   * (e.g. `bash: 'ask'` in ocConfig.ts) inline in the chat view, in the run's OWN session.
   * Mirrors requestCommandApproval/requestEditApproval's map+card+resolve pattern, but
   * carries OC's own three-way response (`once`/`always`/`reject`) instead of a boolean.
   */
  requestPermissionAsk(sessionId: string, requestId: string, title: string, pattern?: string | string[]): Promise<'once' | 'always' | 'reject'> {
    const s = this.sessions.get(sessionId);
    if (!this.view || !s) return Promise.resolve('reject'); // nowhere to ask → deny rather than hang
    try { this.view.show?.(true); } catch { /* reveal is best-effort */ }
    const id = `perm-${++this.approvalSeqGlobal}`;
    return new Promise<'once' | 'always' | 'reject'>((resolve) => {
      s.pendingPermissions.set(id, resolve);
      this.postCard(s, { type: 'permissionAsk', sessionId, requestId, id, title, pattern });
      this.maybeNotifyApproval(sessionId, requestId, s);
    });
  }

  /** One background-approval notification per run, plus flipping the tab to "needs approval". */
  private maybeNotifyApproval(sessionId: string, requestId: string, s: Session): void {
    if (sessionId === this.viewedSessionId) return;
    const key = `${sessionId}:${requestId}`;
    if (this.approvalNotified.has(key)) return;
    this.approvalNotified.add(key);
    this.setStatus(sessionId, 'needsApproval');
    const name = s.title?.trim() || 'A session';
    void vscode.window.showInformationMessage(`${name} needs your approval to continue.`, 'Switch to it')
      .then((choice) => { if (choice === 'Switch to it') this.openSession(sessionId); });
  }

  /**
   * Resolve every outstanding approval in a session (e.g. on cancel / stop / a watchdog-forced
   * finish) so the agent never hangs. Must also pull the card off the webview here — otherwise
   * it stays rendered as a live, clickable Allow/Reject button whose backing promise is already
   * gone, so a later click on it silently does nothing (the id is no longer in the map) and the
   * user has no idea the run already ended.
   */
  private settlePendingApprovals(s: Session, approved: boolean): void {
    const approvalIds = new Set(s.pendingApprovals.keys());
    for (const resolve of s.pendingApprovals.values()) resolve(approved);
    s.pendingApprovals.clear();

    const permissionIds = new Set(s.pendingPermissions.keys());
    for (const resolve of s.pendingPermissions.values()) resolve('reject');
    s.pendingPermissions.clear();
    if (approvalIds.size) {
      this.removeCards(s, (c) => (c.type === 'commandApproval' || c.type === 'editApproval') && approvalIds.has(c.id));
    }
    if (permissionIds.size) {
      this.removeCards(s, (c) => c.type === 'permissionAsk' && permissionIds.has(c.id));
    }
    for (const id of approvalIds) this.post({ type: 'approvalDismissed', sessionId: s.id, id });
    for (const id of permissionIds) this.post({ type: 'approvalDismissed', sessionId: s.id, id });
  }

  /** Resolve every in-flight in-chat `askUser` prompt with '' so the agent loop never hangs.
   *  Also posts a dismissed message per entry so the webview can disable the card (otherwise
   *  the card stays interactive even though the agent loop has already moved on). */
  private settlePendingAskUser(s: Session): void {
    if (s.pendingAskUser.size === 0) return;

    const callIds = Array.from(s.pendingAskUser.keys());
    const requestId = s.activeRequestId ?? '';
    for (const callId of callIds) {
      this.removeCards(s, (c) => c.type === 'askUserPrompt' && c.callId === callId);
      this.post({ type: 'askUserDismissed', sessionId: s.id, requestId, callId });
    }
    for (const resolve of s.pendingAskUser.values()) resolve('');
    s.pendingAskUser.clear();
  }

  /**
   * In-chat backing for the agent's `askUser` tool (Plan + Agent modes only). Posts an
   * `askUserPrompt` card to the webview and resolves with the user's answer (or '' on cancel).
   * The callId is the OpenAI tool_call_id, so the resolved string lands as the observation
   * for the right tool call when the agent loop resumes.
   */
  private requestAskUser(s: Session, requestId: string, callId: string, question: string, options?: string[]): Promise<string> {
    if (!this.view) return Promise.resolve('');
    try { this.view.show?.(true); } catch { /* reveal is best-effort */ }
    return new Promise<string>((resolve) => {
      s.pendingAskUser.set(callId, resolve);
      this.postCard(s, { type: 'askUserPrompt', sessionId: s.id, requestId, callId, question, options });
    });
  }

  private flushQueue(): void {
    const queued = this.outQueue.splice(0);
    for (const m of queued) void this.view?.webview.postMessage(m);
  }

  private maxConcurrent(): number {
    return Math.max(1, vscode.workspace.getConfiguration('tiermux.agent').get<number>('maxConcurrentRuns', 3));
  }

  /**
   * Acquire one of the limited concurrent-run slots, queueing (and marking the tab "queued")
   * if the cap is reached. The returned function releases the slot and starts the next queued
   * run, skipping any whose session was deleted while waiting.
   */
  private async acquireRunSlot(sessionId: string): Promise<() => void> {
    if (!this.runningSessions.has(sessionId) && this.runningSessions.size >= this.maxConcurrent()) {
      this.setStatus(sessionId, 'queued');
      await new Promise<void>((resolve) => this.runQueue.push({ sessionId, resolve }));
    }
    this.runningSessions.add(sessionId);
    this.setStatus(sessionId, 'running');
    return () => {
      this.runningSessions.delete(sessionId);
      while (this.runQueue.length) {
        const next = this.runQueue.shift()!;
        if (this.sessions.has(next.sessionId)) { next.resolve(); break; }
      }
    };
  }

  /** Reveal the chat and submit a prompt programmatically (editor commands). */
  async submitExternal(text: string, mode: Mode): Promise<void> {
    await vscode.commands.executeCommand('tiermux.chat.focus');

    await new Promise((r) => setTimeout(r, 150));
    const requestId = `ext-${Date.now()}`;
    const s = this.current();
    this.post({ type: 'userEcho', sessionId: s.id, requestId, text });
    await this.handleSend({ type: 'sendMessage', requestId, text, mode, model: 'auto', reasoningEffort: 'off' });
  }

  newChat(): void {

    const s = this.createSession();
    this.viewedSessionId = s.id;
    void this.deps.workspaceState.update(CURRENT_KEY, s.id);
    this.postSessionList();
    this.post({ type: 'switchSession', sessionId: s.id, messages: [] });
    this.post({ type: 'busy', sessionId: s.id, busy: false }); // reset the composer if a run was in flight
    void this.sendConfig();
    this.updateViewTitle();
  }

  /** Re-push config to the webview (e.g. after an external settings change). */
  refresh(): void {
    void this.sendConfig();
  }

  /** Open the Models/settings panel (from the native title-bar gear). */
  async toggleSettingsPanel(): Promise<void> {
    await vscode.commands.executeCommand('tiermux.chat.focus');
    this.post({ type: 'toggleSettings' });
  }

  /** Open the Tips & Announcements page (from the new-announcement toast's View button). */
  async showAnnouncements(): Promise<void> {
    await vscode.commands.executeCommand('tiermux.chat.focus');
    this.post({ type: 'openAnnouncements' });
  }

  /** Compact the conversation (from the native title bar). */
  async compact(): Promise<void> {
    await vscode.commands.executeCommand('tiermux.chat.focus');
    await this.handleCompact(this.current());
  }

  /** Write a standalone handoff note for the current session and copy it to the clipboard
   *  (from the native title bar) — read-only, unlike compact(); the session is untouched. */
  async handoff(): Promise<void> {
    await vscode.commands.executeCommand('tiermux.chat.focus');
    await this.handleHandoff(this.current());
  }

  /** Browse past chats and reopen one (native QuickPick). */
  async showHistory(): Promise<void> {
    await vscode.commands.executeCommand('tiermux.chat.focus');
    this.persist(this.viewedSessionId);
    this.postSessionList();
    this.post({ type: 'toggleHistory' });
  }

  /** Rename a stored session (also updates the live title if it's a live session). */
  private renameSession(id: string, title: string): void {
    const s = this.sessions.get(id);
    if (s) {
      s.title = title;
      s.userRenamedTitle = true; // user-chosen name sticks — don't let OC's title override it
      this.persist(id);
      return;
    }

    const stored = this.loadSessions();
    const x = stored.find((u) => u.id === id);
    if (x) { x.title = title; void this.deps.workspaceState.update(SESSIONS_KEY, stored); }
  }

  /** Inline rename of the current session from the webview header. */
  private handleRenameSession(title: string): void {
    const t = title.trim();
    const s = this.current();
    if (!t || t === (s.title ?? this.deriveTitle(s))) return;
    s.title = t;
    s.userRenamedTitle = true; // user-chosen name sticks — auto-titling never overrides it
    this.persist(s.id); // saves + pushes the new title to chrome and webview header
  }

  /** Switch the viewed session. Does NOT cancel the session we're leaving — its run keeps going. */
  openSession(id: string): void {
    if (id === this.viewedSessionId) return;
    const s = this.sessions.get(id);
    if (!s) return;
    this.viewedSessionId = id;
    void this.deps.workspaceState.update(CURRENT_KEY, id);
    this.postSessionList();
    this.post({ type: 'switchSession', sessionId: id, messages: s.transcript });
    this.post({ type: 'busy', sessionId: id, busy: !!s.activeRequestId });

    this.postLiveRunState(s);
    this.postCheckpoints(s);
    void this.sendConfig();
    this.updateViewTitle();
  }

  /**
   * Re-send everything needed to reconstruct the currently-viewed session's live UI state: a
   * still-running turn's assistantStart/step/todos, and any pending interactive cards (plan
   * proposal, clarifying questions, approvals). The extension host's in-memory `Session`
   * survives both a tab switch (openSession) AND a webview-only reload (the 'ready' handler,
   * e.g. Cmd+R) — only the *rendered* webview is gone in the latter case — so both paths need
   * this same resync or a mid-run reload silently drops the plan/clarify card and live status.
   */
  private postLiveRunState(s: Session): void {
    if (s.activeRequestId) {
      const rid = s.activeRequestId;
      this.post({ type: 'assistantStart', sessionId: s.id, requestId: rid, platform: s.livePlatform ?? '', model: s.liveModel ?? '' });
      if (s.lastStepLabel) this.post({ type: 'agentStep', sessionId: s.id, requestId: rid, phase: 'thinking', label: s.lastStepLabel });
      if (s.lastTodos && s.lastTodos.length) this.post({ type: 'todos', sessionId: s.id, requestId: rid, todos: s.lastTodos, followingPlan: !!s.executingPlan });
    }
    for (const card of s.cards) this.post(card);
  }

  /**
   * Deleting a chat also discards any code it changed that was never committed — same as
   * Cursor/Claude Code. "Not committed" here means no real git commit has landed since (a
   * real commit already clears every session's checkpoints via clearAllCheckpoints(), so if
   * commits happened, `list()` is empty and this is a no-op). Confirms first since this is
   * destructive; the webview has already optimistically removed the row, so a decline needs
   * `postSessionList()` to bring it back.
   */
  private async deleteSession(id: string): Promise<void> {
    const wasViewed = id === this.viewedSessionId;
    const s = this.sessions.get(id);
    if (s) {
      const cps = s.checkpoints.list();
      if (cps.length) {
        const files = await s.checkpoints.changedFiles(cps[0].id);
        if (files.length) {
          const plural = files.length > 1;
          const choice = await vscode.window.showWarningMessage(
            `Delete this chat? ${files.length} uncommitted file change${plural ? 's' : ''} it made will also be reverted.`,
            { modal: true },
            'Delete && Revert',
          );
          if (choice !== 'Delete && Revert') { this.postSessionList(); return; }
          await s.checkpoints.restore(cps[0].id);
        }
      }
    }
    this.stopRun(id); // cancel only this session's run — it's about to be deleted
    this.sessions.delete(id);
    this.statusOf.delete(id);
    this.deps.router.clearSessionPin(id); // don't leave the sticky-Auto pin behind
    clearFindings(id); // the findings note must not outlive the conversation it describes
    void this.deps.workspaceState.update(SESSIONS_KEY, this.loadSessions().filter((s) => s.id !== id));
    if (wasViewed) {

      const next = this.loadSessions()[0]?.id;
      if (next && this.sessions.has(next)) this.openSession(next);
      else this.newChat();
    }
    this.postSessionList();
  }

  private async onMessage(m: InMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.flushQueue();
        await this.sendConfig();
        this.postSessionList();
        {
          const s = this.current();
          this.post({ type: 'switchSession', sessionId: s.id, messages: s.transcript });
          this.post({ type: 'busy', sessionId: s.id, busy: !!s.activeRequestId });
          this.postLiveRunState(s);
          this.postCheckpoints(s);
        }
        // Fire-and-forget: surface operator tips/announcements once the view is up.
        void this.fetchAnnouncements();
        break;
      case 'switchSession':
        this.openSession(m.sessionId);
        break;
      case 'requestConfig':
        await this.sendConfig();
        break;
      case 'getAnnouncements':
        void this.fetchAnnouncements();
        break;
      case 'resumePlan': {
        // Resume a plan run that was paused by a window reload (or an aborted run): the
        // persisted planRun state carries the step statuses; executePlanRun continues from
        // currentStep with the session's persisted history as context.
        const s = this.current();
        if (s.planRun && s.planRun.status === 'paused') {
          const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          s.executingPlan = true;
          this.post({ type: 'planExecuting', sessionId: s.id, requestId, executing: true });
          await this.executePlanRun(s, requestId);
        }
        break;
      }
      case 'markAnnouncementsSeen':
        await markAnnouncementsSeen(this.deps.globalState, this.lastAnnouncements);
        this.postAnnouncements(this.lastAnnouncements, this.lastAnnouncementsUpdated);
        break;
      case 'retryEngine':
        this.deps.retryEngine?.();
        break;
      case 'sendMessage':
        await this.handleSend(m);
        break;
      case 'approvePlan':
        await this.handleApprovePlan(m);
        break;
      case 'executePlan':
        await this.handleExecutePlan(m);
        break;
      case 'deferPlan':
        this.handleDeferPlan(m);
        break;
      case 'resume':
        await this.handleResume(m);
        break;
      case 'answerClarifying':
        await this.handleAnswerClarifying(m);
        break;
      case 'askUserResponse': {
        const s = this.sessions.get(m.sessionId ?? this.viewedSessionId);
        const resolve = s?.pendingAskUser.get(m.callId);
        if (s && resolve) {
          s.pendingAskUser.delete(m.callId);
          this.removeCards(s, (c) => c.type === 'askUserPrompt' && c.callId === m.callId);
          resolve(m.cancelled ? '' : (m.answer ?? ''));
        }
        break;
      }
      case 'renameSession':
        this.handleRenameSession(m.title);
        break;
      case 'renameSessionById':
        if (m.sessionId && m.title) this.renameSession(m.sessionId, m.title);
        break;
      case 'deleteSessionById':
        if (m.sessionId) await this.deleteSession(m.sessionId);
        break;
      case 'cancel':
        this.stopRun(m.sessionId ?? this.viewedSessionId);
        break;
      case 'commandApprovalResponse':
      case 'editApprovalResponse': {
        const s = this.sessions.get(m.sessionId ?? this.viewedSessionId);
        const resolve = s?.pendingApprovals.get(m.id);
        if (s && resolve) {
          s.pendingApprovals.delete(m.id);
          this.removeCards(s, (c) => (c.type === 'commandApproval' || c.type === 'editApproval') && c.id === m.id);
          resolve(m.approved);
          this.approvalNotified.delete(`${s.id}:${s.activeRequestId ?? ''}`);
          if (s.activeRequestId) this.setStatus(s.id, 'running');
        }
        break;
      }
      case 'permissionAskResponse': {
        const s = this.sessions.get(m.sessionId ?? this.viewedSessionId);
        const resolve = s?.pendingPermissions.get(m.id);
        if (s && resolve) {
          s.pendingPermissions.delete(m.id);
          this.removeCards(s, (c) => c.type === 'permissionAsk' && c.id === m.id);
          resolve(m.response);
          this.approvalNotified.delete(`${s.id}:${s.activeRequestId ?? ''}`);
          if (s.activeRequestId) this.setStatus(s.id, 'running');
        }
        break;
      }
      case 'watchdogAction': {
        // Watchdog itself is one-way (observability only) — this is where the UI's chosen
        // action actually happens, reusing existing capabilities rather than new SDK plumbing.
        const s = this.sessions.get(m.sessionId ?? this.viewedSessionId);
        if (!s || s.activeRequestId !== m.requestId) break; // stale click — run already moved on
        console.log(`[tiermux][watchdog] action=${m.action} sessionId=${s.id} requestId=${m.requestId}`);
        if (m.action === 'continueWaiting') break; // purely informational — nothing to do
        if (m.action === 'acceptCurrentOutput') {
          s.cancel?.cancel(); // aborts the in-flight OC call only; finalizes with whatever streamed so far
          break;
        }
        // restartRequest / switchModel: abort the current attempt; the send handler's retry
        // loop picks `pendingWatchdogRetry` up once the abort settles. The engine holds no
        // server-side session to drop (opts.messages + workMessages is the sole state), so a
        // restart just re-runs the turn fresh.
        s.pendingWatchdogRetry = m.action === 'switchModel' ? 'switch' : 'restart';
        s.cancel?.cancel();
        break;
      }
      case 'openPlanFile': {
        await vscode.window.showTextDocument(vscode.Uri.parse(m.uri));
        break;
      }
      case 'vote': {
        const s = this.current();
        const ctx = s.voteCtx.get(m.requestId);
        if (ctx) {
          this.deps.modelStats.recordVote(ctx.taskKind, ctx.platform, ctx.model, m.vote, ctx.last);
          ctx.last = m.vote;
        }
        break;
      }
      case 'setFallbackConfig':
        await this.deps.settings.setFallback(m.entries);
        break;
      case 'setEndpoint':
        await this.deps.settings.setEndpoint(m.platform, m.url);
        break;
      case 'resetEndpoint':
        await this.deps.settings.resetEndpoint(m.platform);
        break;
      case 'setKey':
        await vscode.commands.executeCommand('tiermux.setApiKey', m.platform);
        break;
      case 'setProviderEnabled':
        await this.deps.settings.setProviderEnabled(m.platform, m.enabled);
        break;
      case 'addKey': {
        const info = getPlatformInfo(m.platform);
        const key = await vscode.window.showInputBox({
          prompt: `Add another API key for ${info?.name ?? m.platform} (it will be added to the rotation pool)`,
          password: true,
          ignoreFocusOut: true,
          placeHolder: 'Paste key here',
        });
        if (key?.trim()) {
          await this.deps.secrets.addKey(m.platform, key.trim());
          void this.sendConfig();
        }
        break;
      }
      case 'removeKeyAt': {
        const keys = await this.deps.secrets.getKeys(m.platform);
        const target = keys[m.index];
        if (target) {
          await this.deps.secrets.removeKey(m.platform, target);
          void this.sendConfig();
        }
        break;
      }
      case 'setModelKey': {
        const ok = await this.deps.secrets.setModelKey(m.platform, m.modelId, m.key);
        if (!ok) void vscode.window.showWarningMessage('TierMux: API key was empty — nothing saved.');
        void this.sendConfig();
        break;
      }
      case 'clearModelKey': {
        await this.deps.secrets.clearModelKey(m.platform, m.modelId);
        void this.sendConfig();
        break;
      }
      case 'setCloudflareAccountId': {
        await this.deps.secrets.setCloudflareAccountId(m.accountId);
        void this.sendConfig();
        break;
      }
      case 'clearCloudflareAccountId': {
        await this.deps.secrets.clearCloudflareAccountId();
        void this.sendConfig();
        break;
      }
      case 'attachFromWorkspace':
        await this.attachFromWorkspace();
        break;
      case 'attachFromDataUrl':
        await this.attachFromDataUrl(m);
        break;
      case 'addSelection':
        await this.addSelectionToChat();
        break;
      case 'mentionQuery':
        await this.handleMentionQuery(m);
        break;
      case 'grepQuery':
        await this.handleGrepQuery(m);
        break;
      case 'openGrepResult':
        await this.openGrepResult(m.path, m.line);
        break;
      case 'compact':
        await this.handleCompact(this.current());
        break;
      case 'editMcp':
        await vscode.commands.executeCommand('workbench.action.openSettingsJson');
        break;
      case 'reconnectMcp':
        await this.deps.mcp.reconnect();
        await this.sendConfig();
        break;
      case 'addMcpServer':
        await this.addMcpServer(m.item);
        break;
      case 'removeMcpServer':
        await this.removeMcpServer(m.name);
        break;
      case 'saveMcpServer':
        await this.saveMcpServer(m.name, m.config, m.originalName);
        break;
      case 'setMcpServerEnabled':
        await this.setMcpServerEnabled(m.name, m.enabled);
        break;
      case 'searchMcpRegistry':
        try {
          const items = await searchRemoteMcp(m.query);
          this.post({ type: 'mcpRegistryResults', queryId: m.queryId, items });
        } catch (e) {
          this.post({ type: 'mcpRegistryResults', queryId: m.queryId, items: [], error: e instanceof Error ? e.message : String(e) });
        }
        break;
      case 'clearUsage': {

        const clearChoice = await vscode.window.showWarningMessage(
          'Clear all lifetime usage data? This resets the persistent token and est. $ saved counters. This cannot be undone.',
          { modal: true },
          'Clear',
        );

        this.post({ type: 'usageTotals', totals: this.currentUsageTotals(this.current()) });
        if (clearChoice !== 'Clear') break;
        await this.deps.usageStore.clear();
        this.deps.usage.reset();

        this.post({ type: 'usageTotals', totals: this.currentUsageTotals(this.current()) });
        void this.sendConfig();
        this.post({ type: 'notice', sessionId: this.viewedSessionId, text: 'Usage data cleared.', icon: 'trash' });
        break;
      }
      case 'restoreCheckpoint':
        await this.handleRestoreCheckpoint(this.current(), m.id);
        break;
      case 'diffCheckpointFile': {
        // WorkReportData.changedFiles carry tool-arg paths (workspace-relative), while
        // CheckpointManager snapshots are keyed by absolute uri.toString(). Resolve bare
        // relative paths against the workspace root; real URIs pass through untouched.
        const s = this.current();
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        const uriStr = m.uri.includes('://') || !root ? m.uri : vscode.Uri.joinPath(root, m.uri).toString();
        s.checkpoints.openDiff(m.id, uriStr);
        break;
      }
      case 'verifyTurn':
        await this.runManualVerify(this.current());
        break;
      case 'revertTo':
        await this.handleRevertTo(this.current(), m.requestId);
        break;
      case 'copyText':
        await vscode.env.clipboard.writeText(m.text);
        break;
      case 'setUtilityModel':
        await vscode.workspace.getConfiguration('tiermux').update('utilityModel', m.model, vscode.ConfigurationTarget.Global);
        await this.sendConfig();
        break;
      case 'setExtensionSetting': {
        if (!SETTINGS_META.some((meta) => meta.key === m.key)) break;
        await vscode.workspace.getConfiguration('tiermux').update(m.key, m.value, vscode.ConfigurationTarget.Global);
        await this.sendConfig();
        break;
      }
      case 'openKeybinding':
        await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', m.command);
        break;
      case 'setAutoApprove':
        this.autoApprove = m.enabled;
        await this.deps.workspaceState.update(AUTO_APPROVE_KEY, m.enabled);
        break;
      case 'newChat':
        this.newChat();
        break;

      case 'addCustomEndpoint': {

        const name = m.name.trim();
        if (name.length < 1 || name.length > 40) {
          void vscode.window.showWarningMessage('Endpoint name must be 1-40 characters.');
          break;
        }
        const existing = this.deps.settings.getCustomEndpoints();
        if (existing.some((ep) => ep.name.toLowerCase() === name.toLowerCase())) {
          void vscode.window.showWarningMessage(`An endpoint named "${name}" already exists.`);
          break;
        }

        if (!/^https?:\/\/.+/i.test(m.baseUrl)) {
          void vscode.window.showWarningMessage('Base URL must start with http:// or https://');
          break;
        }

        const id = 'c_' + Math.random().toString(36).slice(2, 8);
        const endpoint: CustomEndpoint = {
          id,
          name,
          baseUrl: m.baseUrl.replace(/\/+$/, ''),
          models: [],
          createdAt: Date.now(),
        };
        await this.deps.settings.upsertCustomEndpoint(endpoint);
        void this.sendConfig();
        break;
      }
      case 'updateCustomEndpoint': {
        const endpoint = this.deps.settings.getCustomEndpoint(m.id);
        if (!endpoint) {
          void vscode.window.showWarningMessage('Endpoint not found.');
          break;
        }
        const updated = { ...endpoint };
        if (m.name !== undefined) {
          const name = m.name.trim();
          if (name.length < 1 || name.length > 40) {
            void vscode.window.showWarningMessage('Endpoint name must be 1-40 characters.');
            break;
          }
          if (name.toLowerCase() !== endpoint.name.toLowerCase() && this.deps.settings.getCustomEndpoints().some((ep) => ep.id !== m.id && ep.name.toLowerCase() === name.toLowerCase())) {
            void vscode.window.showWarningMessage(`An endpoint named "${name}" already exists.`);
            break;
          }
          updated.name = name;
        }
        if (m.baseUrl !== undefined) {
          if (!/^https?:\/\/.+/i.test(m.baseUrl)) {
            void vscode.window.showWarningMessage('Base URL must start with http:// or https://');
            break;
          }
          updated.baseUrl = m.baseUrl.replace(/\/+$/, '');
        }
        if (m.extraHeaders !== undefined) updated.extraHeaders = m.extraHeaders;
        await this.deps.settings.upsertCustomEndpoint(updated);

        const { invalidateCustomProvider } = await import('./providers/index.js');
        invalidateCustomProvider(m.id);
        void this.sendConfig();
        break;
      }
      case 'removeCustomEndpoint': {

        const endpoint = this.deps.settings.getCustomEndpoint(m.id);
        await this.deps.settings.removeCustomEndpoint(m.id);

        await this.deps.secrets.clearCustomKey(m.id);
        if (endpoint) {
          for (const model of endpoint.models) {
            await this.deps.secrets.clearCustomModelKey(m.id, model.modelId);
          }
        }

        const fallback = this.deps.settings.getFallback().filter((e) => !e.modelId.startsWith(m.id + '::'));
        await this.deps.settings.setFallback(fallback);

        const { invalidateCustomProvider } = await import('./providers/index.js');
        invalidateCustomProvider(m.id);
        void this.sendConfig();
        break;
      }
      case 'setCustomEndpointKey': {
        if (m.key === null || m.key === '') {
          await this.deps.secrets.clearCustomKey(m.id);
        } else {
          await this.deps.secrets.setCustomKey(m.id, m.key);
        }
        void this.sendConfig();
        break;
      }
      case 'addCustomModel': {
        const endpoint = this.deps.settings.getCustomEndpoint(m.endpointId);
        if (!endpoint) {
          void vscode.window.showWarningMessage('Endpoint not found.');
          break;
        }

        const modelId = m.modelId.trim();
        if (modelId.length < 1 || modelId.length > 200) {
          void vscode.window.showWarningMessage('Model ID must be 1-200 characters.');
          break;
        }
        if (/\s|::/.test(modelId)) {
          void vscode.window.showWarningMessage('Model ID cannot contain whitespace or ::');
          break;
        }
        if (endpoint.models.some((em) => em.modelId === modelId)) {
          void vscode.window.showWarningMessage(`Model "${modelId}" already exists in this endpoint.`);
          break;
        }

        endpoint.models.push({ modelId, displayName: m.displayName });
        await this.deps.settings.upsertCustomEndpoint(endpoint);

        const fallback = this.deps.settings.getFallback();
        const maxPriority = Math.max(0, ...fallback.map((e) => e.priority));
        fallback.push({
          platform: 'custom',
          modelId: `${m.endpointId}::${modelId}`,
          enabled: false,
          priority: maxPriority + 1,
        });
        await this.deps.settings.setFallback(fallback);
        void this.sendConfig();
        break;
      }
      case 'removeCustomModel': {
        const endpoint = this.deps.settings.getCustomEndpoint(m.endpointId);
        if (!endpoint) {
          void vscode.window.showWarningMessage('Endpoint not found.');
          break;
        }

        endpoint.models = endpoint.models.filter((em) => em.modelId !== m.modelId);
        await this.deps.settings.upsertCustomEndpoint(endpoint);

        const fallback = this.deps.settings.getFallback().filter((e) => !(e.platform === 'custom' && e.modelId === `${m.endpointId}::${m.modelId}`));
        await this.deps.settings.setFallback(fallback);

        await this.deps.secrets.clearCustomModelKey(m.endpointId, m.modelId);
        void this.sendConfig();
        break;
      }
      case 'fetchCustomEndpointModels': {
        const endpoint = this.deps.settings.getCustomEndpoint(m.id);
        if (!endpoint) {
          this.post({ type: 'customEndpointModels', id: m.id, models: [], error: 'Endpoint not found.' });
          break;
        }
        try {
          const key = await this.deps.secrets.getCustomKey(m.id);
          const models = await fetchOpenAICompatModels(endpoint.baseUrl, key, endpoint.extraHeaders);
          this.post({ type: 'customEndpointModels', id: m.id, models });
        } catch (e) {
          this.post({ type: 'customEndpointModels', id: m.id, models: [], error: e instanceof Error ? e.message : String(e) });
        }
        break;
      }
    }
  }

  private async attachFromWorkspace(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
      filters: ATTACHMENT_FILE_FILTERS,
    });
    if (!picked) return;
    for (const uri of picked) {
      try {
        if (!isSupportedAttachmentPath(uri.fsPath)) {
          this.post({ type: 'notice', sessionId: this.viewedSessionId, text: `Skipped ${vscode.workspace.asRelativePath(uri)} — unsupported file type. Attach images, PDFs, or documents.` });
          continue;
        }
        const attachment = await buildAttachmentFromUri(uri, 'pick');
        this.post({ type: 'attachmentAdded', attachment });
        this.warnIfPdfTextExtractionFailed(attachment);
      } catch (e) {
        this.post({ type: 'error', sessionId: this.viewedSessionId, message: `Could not read ${uri.fsPath}: ${e instanceof Error ? e.message : e}` });
      }
    }
  }

  /** PDF text extraction fails silently (extractPdfText swallows parse errors) — surface it
   *  so the user isn't left guessing why the model later refuses or answers from nothing. */
  private warnIfPdfTextExtractionFailed(attachment: Attachment): void {
    if (attachment.kind === 'pdf' && !attachment.text) {
      // Only report a real MALFUNCTION here. A genuine scan (no text layer) is not an error:
      // the webview converts its pages to images right after this and reports the outcome
      // itself, so claiming "sending the raw file" now would contradict what actually happens.
      // The library-failed-to-load case is different — it makes every PDF look like a scan and
      // must be named, because nothing else distinguishes the two.
      const why = lastPdfFailureReason();
      if (!why || why.startsWith('getText returned no text')) return;
      this.post({
        type: 'notice',
        sessionId: this.viewedSessionId,
        text: `Couldn't read text from "${attachment.name}" — the PDF reader failed (${why.slice(0, 300)}). Falling back to sending the pages as images.`,
      });
    }
  }

  /** Add the active editor's selection (or whole file) as a context chip. */
  async addSelectionToChat(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { void vscode.window.showInformationMessage('Open a file and select some code first.'); return; }
    const sel = editor.selection;
    const useWhole = sel.isEmpty;
    const code = useWhole ? editor.document.getText() : editor.document.getText(sel);
    if (!code.trim()) { void vscode.window.showInformationMessage('Nothing selected.'); return; }
    const path = vscode.workspace.asRelativePath(editor.document.uri);
    // Insert as an `@path#start-end` mention (resolved from disk at send time by
    // resolveMentions), matching how a typed/picked @-mention behaves, instead of a
    // separate attachment chip.
    const mention = useWhole ? path : `${path}#${sel.start.line + 1}-${sel.end.line + 1}`;
    await vscode.commands.executeCommand('tiermux.chat.focus');
    this.post({ type: 'insertMention', text: mention });
  }

  /**
   * Handle a file the webview captured from paste/drop (it has bytes but no
   * path). For images we accept the data URL directly; for PDF/DOCX we save
   * the bytes to a temp file in the workspace's .tiermux/attach/ folder and
   * run the same extractor the workspace picker would. The temp file is
   * kept on disk so a follow-up `readImage` / `readDocument` tool call later
   * in the conversation can re-open it.
   */
  private async attachFromDataUrl(m: Extract<InMessage, { type: 'attachFromDataUrl' }>): Promise<void> {
    if (!m || !m.dataUrl || !m.name) return;
    const dataMatch = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(m.dataUrl);
    if (!dataMatch) { this.post({ type: 'error', sessionId: this.viewedSessionId, message: 'Invalid file data.' }); return; }
    const isBase64 = Boolean(dataMatch[2]);
    const payload = dataMatch[3] ?? '';
    const bytes = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf-8');
    const kind = (m.mime || '').toLowerCase().startsWith('image/') ? 'image' : kindFromName(m.name);

    try {
      if (kind === 'image') {
        if (bytes.byteLength > IMAGE_BYTE_LIMIT) {
          this.post({ type: 'error', sessionId: this.viewedSessionId, message: `Image is too large (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; max ${IMAGE_BYTE_LIMIT / 1024 / 1024} MB).` });
          return;
        }
        const attachment: Attachment = {
          kind: 'image',
          name: m.name,
          mime: m.mime || mimeForName(m.name),
          // Forward the original data URL as-is — the webview downscales it on receipt,
          // so re-encoding the full-resolution bytes here is redundant synchronous work.
          dataUrl: m.dataUrl,
          source: m.source,
        };
        this.post({ type: 'attachmentAdded', attachment });
        return;
      }

      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) { this.post({ type: 'error', sessionId: this.viewedSessionId, message: 'Open a folder first — non-image attachments need a workspace to land in.' }); return; }
      const dir = vscode.Uri.joinPath(folder.uri, '.tiermux', 'attach');
      await vscode.workspace.fs.createDirectory(dir);
      const fileUri = vscode.Uri.joinPath(dir, m.name);
      await vscode.workspace.fs.writeFile(fileUri, bytes);
      const attachment = await buildAttachmentFromUri(fileUri, m.source ?? 'drop');
      this.post({ type: 'attachmentAdded', attachment });
      this.warnIfPdfTextExtractionFailed(attachment);
    } catch (e) {
      this.post({ type: 'error', sessionId: this.viewedSessionId, message: `Could not attach ${m.name}: ${e instanceof Error ? e.message : e}` });
    }
  }

  /** Add a server (bundled / remote-registry, stdio or HTTP): prompt for inputs, write config, reconnect. */
  private async addMcpServer(item: McpRegistryItem): Promise<void> {
    if (!item) return;
    let entry: Record<string, unknown> | undefined;

    if (item.transport === 'http' && item.url) {
      const headers: Record<string, string> = {};
      for (const h of item.headers ?? []) {
        let value = h.value || '';
        const placeholders = [...value.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
        if (placeholders.length) {
          for (const ph of placeholders) {
            const input = await vscode.window.showInputBox({ prompt: `${item.name}: ${ph}`, password: !!h.secret, ignoreFocusOut: true });
            if (input === undefined) return; // cancelled
            value = value.replace(`{${ph}}`, input);
          }
        } else if (!value) {
          const input = await vscode.window.showInputBox({ prompt: `${item.name}: ${h.name}`, password: !!h.secret, ignoreFocusOut: true });
          if (input === undefined) return;
          value = input;
        }
        if (value) headers[h.name] = value;
      }
      entry = { type: 'remote', url: item.url, enabled: true, ...(Object.keys(headers).length ? { headers } : {}) };
    } else {
      const environment: Record<string, string> = {};
      for (const e of item.env ?? []) {

        const optional = !e.password;
        const val = await vscode.window.showInputBox({
          title: `Add ${item.name}`,
          prompt: `${e.label ?? e.key}${optional ? ' — optional, leave blank to skip' : ''}`,
          password: !!e.password,
          ignoreFocusOut: true,
        });
        if (val === undefined) return; // cancelled (Esc)
        if (val) environment[e.key] = val;
      }
      entry = { type: 'local', command: [item.command, ...(item.args ?? [])], enabled: true, ...(Object.keys(environment).length ? { environment } : {}) };
    }

    const cfg = vscode.workspace.getConfiguration('tiermux');
    const servers: Record<string, unknown> = { ...(cfg.get<Record<string, unknown>>('mcpServers') ?? {}) };
    servers[item.id] = entry;
    await cfg.update('mcpServers', servers, vscode.ConfigurationTarget.Global);
    await this.deps.mcp.reconnect();
    await this.sendConfig();
    void vscode.window.showInformationMessage(`Added MCP server "${item.name}". Edit details in settings.json if needed.`);
  }

  /** Remove a configured server (by its settings.json key) after confirmation. */
  private async removeMcpServer(name: string): Promise<void> {
    if (!name) return;
    const cfg = vscode.workspace.getConfiguration('tiermux');
    const servers: Record<string, unknown> = { ...(cfg.get<Record<string, unknown>>('mcpServers') ?? {}) };
    if (!(name in servers)) return;
    const pick = await vscode.window.showWarningMessage(`Remove MCP server "${name}"?`, { modal: true }, 'Remove');
    if (pick !== 'Remove') return;
    delete servers[name];
    await cfg.update('mcpServers', servers, vscode.ConfigurationTarget.Global);

    this.deps.mcp.disconnect(name);
    await this.sendConfig();
    void vscode.window.showInformationMessage(`Removed MCP server "${name}".`);
  }

  /** Unified Add/Edit save from the MCP form — writes OpenCode's native schema directly. */
  private async saveMcpServer(name: string, config: McpServerConfig, originalName?: string): Promise<void> {
    if (!name || !config) return;
    const cfg = vscode.workspace.getConfiguration('tiermux');
    const servers: Record<string, unknown> = { ...(cfg.get<Record<string, unknown>>('mcpServers') ?? {}) };
    if (originalName && originalName !== name) delete servers[originalName];
    servers[name] = config;
    await cfg.update('mcpServers', servers, vscode.ConfigurationTarget.Global);
    await this.deps.mcp.reconnect();
    await this.sendConfig();
  }

  /** Quick enable/disable toggle from a server card, without opening the full form. */
  private async setMcpServerEnabled(name: string, enabled: boolean): Promise<void> {
    if (!name) return;
    const cfg = vscode.workspace.getConfiguration('tiermux');
    const servers: Record<string, unknown> = { ...(cfg.get<Record<string, unknown>>('mcpServers') ?? {}) };
    const existing = normalizeMcpServerConfig(servers[name]);
    if (!existing) return;
    servers[name] = { ...existing, enabled };
    await cfg.update('mcpServers', servers, vscode.ConfigurationTarget.Global);
    await this.deps.mcp.reconnect();
    await this.sendConfig();
  }

  private async registry(): Promise<McpRegistryItem[]> {
    if (!this.mcpRegistry) this.mcpRegistry = await loadMcpRegistry(this.extensionUri.fsPath);
    return this.mcpRegistry;
  }

  private async handleMentionQuery(m: Extract<InMessage, { type: 'mentionQuery' }>): Promise<void> {
    try {
      const items = await searchMentions(m.query);
      this.post({ type: 'mentionResults', queryId: m.queryId, items });
    } catch {
      this.post({ type: 'mentionResults', queryId: m.queryId, items: [] });
    }
  }

  /** Live search-as-you-type for `/grep <pattern>` — mirrors handleMentionQuery. Capped
   *  smaller than the `/grep` command's own 20-match display since this renders inline
   *  in the autocomplete popup, not a full chat message. */
  private async handleGrepQuery(m: Extract<InMessage, { type: 'grepQuery' }>): Promise<void> {
    try {
      const items = m.query.trim() ? (await findTextInWorkspace(m.query.trim())).slice(0, 8) : [];
      this.post({ type: 'grepResults', queryId: m.queryId, items });
    } catch {
      this.post({ type: 'grepResults', queryId: m.queryId, items: [] });
    }
  }

  /** Open a `/grep` autocomplete result at its matched line. Best-effort — the file may
   *  have moved/been deleted since the search ran. */
  private async openGrepResult(path: string, line: number): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return;
    try {
      const uri = vscode.Uri.joinPath(root, path);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } catch { /* file may have moved — best-effort */ }
  }

  /** Per-session auto-condense cooldown — a failed or insufficient condense must not retry on
   *  every send (each attempt is a real LLM call against rate-limited free tiers). */
  private autoCondenseAt = new Map<string, number>();
  private static readonly AUTO_CONDENSE_COOLDOWN_MS = 10 * 60_000;

  /**
   * Automatic between-turn compaction. When the session history exceeds ~80% of the routed
   * model's context window (and is long enough for condenseHistory to act on), summarize the
   * older turns in place — same mechanism as /compact, just triggered by pressure instead of
   * the user noticing slowness. Runs before the turn starts so the model begins with headroom
   * rather than discovering the wall mid-turn.
   */
  private async maybeAutoCondense(s: Session): Promise<void> {
    try {
      if (!vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('autoCondense', true)) return;
      const last = this.autoCondenseAt.get(s.id) ?? 0;
      if (Date.now() - last < ChatViewProvider.AUTO_CONDENSE_COOLDOWN_MS) return;
      if (!shouldCondense(s.history)) return;
      const profile = resolveExecutionProfile(this.deps.router.peekTopSelection('chat')?.model);
      const tokens = estimateMessagesTokens(s.history);
      if (tokens <= profile.contextWindow * 0.8) return;
      this.autoCondenseAt.set(s.id, Date.now());
      const r = await condenseHistory(
        s.history,
        this.deps.router,
        s.livePlatform && s.liveModel ? `${s.livePlatform}/${s.liveModel}` : undefined,
      );
      if (!r) return; // condense.ts already retried with a different model before giving up
      const after = estimateMessagesTokens(r.messages);
      s.history = r.messages;
      this.persist(s.id);
      this.post({
        type: 'notice', sessionId: s.id, icon: 'compress',
        text: `Context auto-compacted — ~${Math.round(tokens / 1000)}k → ~${Math.round(after / 1000)}k tokens `
          + `(was approaching the model's ~${Math.round(profile.contextWindow / 1000)}k window). `
          + 'Earlier turns summarized; recent turns kept verbatim.',
      });
    } catch {
      // Best-effort: a failed auto-condense must never block or fail the user's turn.
    }
  }

  private async handleCompact(s: Session): Promise<void> {
    if (!shouldCondense(s.history)) {
      this.post({ type: 'notice', sessionId: s.id, text: 'Not enough conversation to compact yet.' });
      return;
    }
    this.post({ type: 'busy', sessionId: s.id, busy: true });
    try {
      // condenseHistory shrinks TierMux's own local `s.history` — the sole source of truth the
      // engine re-reads every turn (opts.messages + this run's workMessages), so client-side
      // condensing is the only compaction mechanism needed.
      const r = await condenseHistory(
        s.history,
        this.deps.router,
        s.livePlatform && s.liveModel ? `${s.livePlatform}/${s.liveModel}` : undefined,
      );
      if (!r) {
        // condenseHistory already retried once with a different model before giving up (see
        // condense.ts) — reaching here means two models in a row returned an empty summary, which
        // usually means the enabled fallback chain is thin (few models, or several rate-limited).
        this.post({ type: 'notice', sessionId: s.id, text: 'Compaction produced no summary after retrying with a different model; context unchanged. Try again in a moment, or switch/enable another model.' });
        return;
      }
      // Report actual TOKEN counts, not just message counts — a session with a couple of huge
      // tool-result messages in the kept tail can shrink from e.g. 12 → 7 messages while barely
      // dropping in tokens, which reads as "compact did nothing" even though it genuinely ran.
      // Showing the real before/after (now that recapTailToolResults also shrinks oversized tool
      // results within the kept tail — see condense.ts) makes a real reduction visible and provable.
      const priorMessages = s.history.length;
      const priorTokens = estimateMessagesTokens(s.history);
      s.history = r.messages;
      const afterTokens = estimateMessagesTokens(s.history);
      this.persist(s.id);
      this.post({ type: 'usageTotals', totals: this.currentUsageTotals(s) });
      this.post({ type: 'notice', sessionId: s.id, text: `Context compacted — ~${Math.round(priorTokens / 1000)}k → ~${Math.round(afterTokens / 1000)}k tokens (${priorMessages} → ${r.messages.length} messages). Earlier turns summarized; the last few kept verbatim.`, icon: 'compress' });
    } catch (e) {
      this.post({ type: 'error', sessionId: s.id, message: `Compact failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      this.post({ type: 'busy', sessionId: s.id, busy: false });
    }
  }

  private async handleHandoff(s: Session): Promise<void> {
    if (s.history.length < 2) {
      this.post({ type: 'notice', sessionId: s.id, text: 'Not enough conversation yet to write a handoff note.' });
      return;
    }
    this.post({ type: 'busy', sessionId: s.id, busy: true });
    try {
      const note = await generateHandoff(s.history, this.deps.router);
      if (!note) {
        this.post({ type: 'notice', sessionId: s.id, text: 'Handoff note generation failed after retrying with a different model; try again in a moment.' });
        return;
      }
      await vscode.env.clipboard.writeText(note);
      this.post({ type: 'notice', sessionId: s.id, text: 'Handoff note copied to clipboard — paste it into a fresh session or share it with a teammate.', icon: 'clipboard' });
    } catch (e) {
      this.post({ type: 'error', sessionId: s.id, message: `Handoff failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      this.post({ type: 'busy', sessionId: s.id, busy: false });
    }
  }

  private buildUserContent(text: string, contextText: string, attachments: Attachment[] | undefined): ChatContent {
    const list = attachments ?? [];
    const fileBlocks = list
      .filter((a) => (a.kind === 'file' || a.kind === 'doc' || a.kind === 'pdf') && a.text)
      .map((a) => `Attached ${a.kind} \`${a.name}\`:\n\`\`\`\n${a.text}\n\`\`\``)
      .join('\n\n');
    const textParts = [text, contextText, fileBlocks].filter((s) => s && s.trim().length > 0).join('\n\n');

    const visualBlocks: ChatContentBlock[] = [];
    for (const a of list) {
      if (a.kind === 'image' && a.dataUrl) {
        visualBlocks.push({ type: 'image_url', image_url: { url: a.dataUrl, mime: a.mime, filename: a.name } });
      } else if (a.kind === 'pdf' && a.dataUrl && !a.text) {
        // Scanned PDF: prefer the page images the webview rendered (see media/src/pdfPages.ts)
        // — every vision-capable model can read `image_url` blocks, whereas raw PDF bytes (the
        // `file` block below) only Google actually forwards (BaseProvider.carriesRawPdf). Fall
        // back to the raw file when rendering failed, preserving the pre-existing Google-only
        // behavior rather than dropping the attachment entirely.
        if (a.pageImages?.length) {
          a.pageImages.forEach((url, i) => {
            // Read the mime off the data URL itself — the webview encodes JPEG, and an
            // explicit-but-wrong mime here would WIN over the URL's own header downstream
            // (see resolveMime in agent/content.ts), handing Gemini mislabelled bytes.
            const mime = /^data:([^;,]+)/.exec(url)?.[1] ?? 'image/jpeg';
            visualBlocks.push({ type: 'image_url', image_url: { url, mime, filename: `${a.name} (page ${i + 1})` } });
          });
        } else {
          visualBlocks.push({ type: 'file', file: { filename: a.name, file_data: a.dataUrl, mime: a.mime } });
        }
      }
    }
    diagLog('attach.build', `attachments=${list.length} kinds=${list.map((a) => `${a.kind}${a.dataUrl ? ':dataUrl' : ''}${a.text ? ':text' : ''}`).join(',') || '<none>'} visualBlocks=${visualBlocks.length}`);
    if (visualBlocks.length === 0) return textParts;

    return [
      { type: 'text', text: textParts },
      ...visualBlocks,
    ];
  }

  private async handleSend(m: Extract<InMessage, { type: 'sendMessage' }>): Promise<void> {
    const slash = parseSlash(m.text);
    if (slash?.name === 'commit') {
      const s = this.current();
      await this.deps.generateCommitMessage();
      this.post({ type: 'assistantMessage', sessionId: s.id, requestId: m.requestId, text: 'Generated a commit message in the Source Control input.' });
      return;
    }
    if (slash?.name === 'grep') {
      const s = this.current();
      if (!slash.rest.trim()) {
        this.post({ type: 'assistantMessage', sessionId: s.id, requestId: m.requestId, text: 'Usage: `/grep <pattern>`' });
        return;
      }
      const pattern = slash.rest.trim();
      const matches = await findTextInWorkspace(pattern);
      if (!matches.length) {
        this.post({ type: 'assistantMessage', sessionId: s.id, requestId: m.requestId, text: `No matches for \`${pattern}\`.` });
      } else {
        const CAP = 20;
        const shown = matches.slice(0, CAP);
        const byFile = new Map<string, typeof shown>();
        for (const hit of shown) {
          const list = byFile.get(hit.path);
          if (list) list.push(hit); else byFile.set(hit.path, [hit]);
        }
        const sections = Array.from(byFile.entries()).map(([file, hits]) => {
          const rows = hits.map((h) => `${h.lineNumber} | ${h.lineText.trim()}`).join('\n');
          return `**${file}**\n\`\`\`\n${rows}\n\`\`\``;
        });
        const omitted = matches.length - shown.length;
        const header = `Found ${matches.length} match${matches.length === 1 ? '' : 'es'} for \`${pattern}\`${omitted > 0 ? ` (showing first ${CAP})` : ''}:`;
        this.post({ type: 'assistantMessage', sessionId: s.id, requestId: m.requestId, text: [header, ...sections].join('\n\n') });
      }
      return;
    }
    let prompt = m.text;
    const skill = slash && this.skills().get(slash.name);
    if (slash && skill) {
      const dirNote = `(This skill's files live at: ${skill.dir}. Resolve any relative paths `
        + `referenced in the instructions below — e.g. references/, scripts/, examples/ — against that directory.)\n\n`;
      prompt = `${dirNote}${skill.prompt}\n\n${slash.rest}`;
    }
    const s = this.current();
    s.model = m.model;
    s.reasoningEffort = m.reasoningEffort;
    diagLog('sendMessage', `requestId=${m.requestId} mode=${m.mode} pinnedModel="${m.model ?? '<none>'}" reasoningEffort=${m.reasoningEffort ?? '<none>'}`);
    const mentionResult = await resolveMentions(prompt).catch(() => ({ text: '', count: 0 }));
    const contextText = mentionResult.text;
    s.lastMentionCount = mentionResult.count;
    diagLog('send.gate', `requestId=${m.requestId} · resolveMentions done (count=${mentionResult.count})`);

    // Auto-enrich: fold a hidden snapshot of the active editor (file/language/selection or an
    // ambient slice around the cursor) and its live diagnostics into the MODEL-facing context only.
    // The displayed transcript (built from `prompt` below) is unaffected, so the user sees exactly
    // what they typed. Gated by `tiermux.context.includeOpenEditors` (was a dead setting before —
    // now actually wired); the slice radius comes from `tiermux.context.ambientSliceRadius`. Skip
    // the editor block if they already @-mentioned the active file (resolveMentions already put its
    // full contents in contextText) — but keep diagnostics, which a file mention doesn't carry.
    // A greeting/small-talk turn is never ABOUT what's on screen, and enrichment is invisible in
    // the transcript, so the user has no way to see why the reply went off-topic: with a SQL dump
    // (or any large file) open, "Hello" shipped up to 8KB of it and the model answered about the
    // SQL instead of saying hello. Skipping enrichment here also keeps a greeting from parking
    // that snippet in `s.history` for the rest of the session.
    const ctxCfg = vscode.workspace.getConfiguration('tiermux.context');
    let ctx = contextText;
    if (ctxCfg.get<boolean>('includeOpenEditors', true) && classifyTask(prompt) !== 'trivial') {
      const activeRel = activeEditorRelPath();
      // Path-boundary match, not a raw substring check — a plain `ctx.includes(activeRel)` false-
      // positives whenever another @mentioned file's contents happen to contain the active path as
      // a substring (e.g. an import line), silently dropping the active-editor context block.
      const escapedActiveRel = activeRel ? activeRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
      const alreadyMentioned = !!(activeRel && new RegExp(`(^|[\\s"'\`(/])${escapedActiveRel}($|[\\s"'\`):,])`).test(ctx));
      const radius = ctxCfg.get<number>('ambientSliceRadius', 15);
      const editorBlock = alreadyMentioned ? null : buildActiveEditorContext(radius);
      const diagBlock = buildDiagnosticsContext();
      const auto = [editorBlock, diagBlock].filter(Boolean).join('\n\n');
      if (auto) ctx = ctx ? `${ctx}\n\n${auto}` : auto;
    }

    const userContent = this.buildUserContent(prompt, ctx, m.attachments);
    // Deterministic resume: a bare "continue"/"keep going" isn't a fresh task — it means "pick up
    // the unfinished work". If the agent's visible plan still has open todos, splice them into the
    // MODEL-facing copy of the message so it resumes precisely instead of re-planning from scratch
    // (a common weak-model failure, made worse when history compaction dropped the tool transcript).
    // The DISPLAYED transcript below still shows only what the user typed.
    const pendingTodos = (m.mode === 'agent' && isBareContinuation(prompt))
      ? (s.lastTodos ?? []).filter((t) => t.status !== 'completed')
      : [];
    // Same idea, wider net: a short pronoun-y or corrective follow-up ("no fix it", "make it
    // faster") that isn't the exact "continue" phrase above still needs anchoring to the last
    // thing the agent did, not a fresh read. Only kicks in when the user gave no other context
    // (no @mention, no attachment) — those already carry their own anchor.
    const lastAction = (!pendingTodos.length && m.mode === 'agent' && mentionResult.count === 0
      && !(m.attachments && m.attachments.length) && s.history.length > 0 && isAmbiguousFollowup(prompt))
      ? lastActionSummary(s.history)
      : null;
    const baseContent = pendingTodos.length
      ? withResumeContext(userContent, pendingTodos)
      : lastAction
        ? withContextBlock(userContent, ambiguousFollowupBlock(lastAction))
        : userContent;
    // Announce a mode switch in the transcript — the system prompt and tool set change silently,
    // so without this the model still sees its own edits from a previous Agent turn and assumes
    // it can keep editing. See withModeTag.
    const historyContent = withModeTag(baseContent, m.mode as AgentMode, s.lastMode);
    s.lastMode = m.mode as AgentMode;
    s.history.push({ role: 'user', content: historyContent });
    s.transcript.push({ role: 'user', text: prompt, requestId: m.requestId, ts: Date.now(), historyLen: s.history.length - 1, attachments: m.attachments });
    s.updatedAt = Date.now();
    void this.maybeGenerateTitle(s); // title from the user's message right away (e.g. "hi" -> "Greetings")

    // Cancel the previous run BEFORE replacing the token. CancellationTokenSource.dispose()
    // only drops listeners — it does NOT abort — so without cancel() a pre-empted in-flight
    // run keeps executing its model call in the background, wasting tokens and racing the
    // new run (a root cause of follow-up sends landing as silent "0 in / 0 out" turns).
    s.cancel?.cancel();
    s.cancel?.dispose();
    s.cancel = new vscode.CancellationTokenSource();
    s.activeRequestId = m.requestId;

    this.settlePendingAskUser(s);
    s.executingPlan = false;
    // A fresh user send starts a new task — a paused/finished plan run from an earlier turn
    // must not linger (Resume is only offered while no new send has happened).
    if (s.planRun && s.planRun.status !== 'running') s.planRun = undefined;
    // Snapshot the todo-list reference at send start. onTodos() reassigns s.lastTodos to a NEW
    // array on every todowrite call, so `s.lastTodos !== todosAtSendStart` is a reliable "the
    // agent wrote a plan during THIS send" signal — the autonomous continuation loop below keys
    // off it so leftover completed/pending todos from a PRIOR turn can't trigger a false continue.
    const todosAtSendStart = s.lastTodos;

    const release = await this.acquireRunSlot(s.id);
    diagLog('send.gate', `requestId=${m.requestId} · slot acquired`);

    if (s.activeRequestId !== m.requestId) { release(); diagLog('send.gate', `requestId=${m.requestId} · SUPERSEDED, aborting before runner`); if (this.sessions.has(s.id)) this.setStatus(s.id, 'idle'); return; }

    this.post({ type: 'busy', sessionId: s.id, busy: true });

    try {
      const before = this.deps.usage.get();
      await s.checkpoints.begin(m.requestId, prompt.slice(0, 60));
      diagLog('send.gate', `requestId=${m.requestId} · checkpoint begun`);
      const sentAt = Date.now();

      // Pre-flight vision check: if the user attached an image/PDF, the selected model MUST be
      // vision-capable or the AI SDK throws a raw error mid-turn ("this model does not support
      // image input"). Catch it up front with a clear, actionable message instead.
      const hasVisual = (m.attachmentKinds ?? m.attachments ?? []).some((k) => k === 'image' || k === 'pdf');
      if (hasVisual && m.model && m.model !== 'auto') {
        // Resolve the pinned model to a catalog entry to check supportsVision. The model picker
        // value is "platform::modelId" (or just modelId for the default platform).
        const [pf, mid] = m.model.includes('::') ? m.model.split('::') : ['', m.model];
        const cat = this.deps.catalog.find(pf as any, mid) ?? this.deps.catalog.all().find((mm) => mm.modelId === mid);
        if (cat && !cat.supportsVision) {
          this.post({ type: 'error', sessionId: s.id, message: `${cat.displayName || mid} doesn't support image input. Switch to a vision-capable model (e.g. Gemini, GPT-4o, Claude) in the model picker, or remove the image attachment.` });
          s.history.pop(); // undo the user turn we pushed above — nothing ran
          s.transcript.pop();
          if (this.sessions.has(s.id)) this.setStatus(s.id, 'idle');
          this.post({ type: 'busy', sessionId: s.id, busy: false });
          release();
          return;
        }
      }
      this.beginInProgressTurn(s, m.requestId);
      // Auto-condense (the /compact trigger, automatic): when the session history already
      // crowds the routed model's context window, summarize BEFORE the turn so the model
      // starts with room instead of mid-turn pruning evicting evidence. Cooldown-bounded so
      // a failed condense never retries on every send. Manual /compact is unaffected.
      await this.maybeAutoCondense(s);
      const cbk = this.agentCallbacks(s, m.requestId, m.mode as Mode);
      const sdkMode = m.mode as AgentMode;
      const runner = sdkMode === 'plan' ? runPlanStream : sdkMode === 'ask' ? runAskStream : runAgentStream;
      diagLog('send.gate', `requestId=${m.requestId} · invoking ${sdkMode} runner`);
      let result = await runner(this.deps.router, this.makeAgentOpts(s, m.requestId, sdkMode, m.reasoningEffort ?? 'medium', cbk, m.model), {});
      diagLog('send.gate', `requestId=${m.requestId} · runner returned paused=${result.paused} textLen=${result.text?.length ?? 0}`);

      // Watchdog "Restart Request" / "Switch Model": the button handler aborted the run above
      // and left `pendingWatchdogRetry` set — re-invoke the SAME request (same requestId, same
      // history — no new user turn) instead of finalizing with whatever partial text streamed.
      while (s.pendingWatchdogRetry && this.isActiveRun(s, m.requestId)) {
        const retryKind = s.pendingWatchdogRetry;
        s.pendingWatchdogRetry = undefined;
        console.log(`[tiermux][watchdog] action=${retryKind === 'switch' ? 'switchModel' : 'restartRequest'} re-invoking requestId=${m.requestId}`);
        s.cancel?.dispose();
        s.cancel = new vscode.CancellationTokenSource();
        const retryModel = retryKind === 'switch' ? 'auto' : m.model;
        result = await runner(this.deps.router, this.makeAgentOpts(s, m.requestId, sdkMode, m.reasoningEffort ?? 'medium', cbk, retryModel), {});
      }

      if (!this.isActiveRun(s, m.requestId)) return;

      // Deterministic relevance check, not just a prompt hope: a reply that never engages
      // with anything the user actually named (e.g. a generic whole-project overview when
      // a specific feature was asked about) is a known failure mode on weaker/free models
      // that ignore "answer exactly what was asked" prompt instructions. One bounded
      // corrective retry — re-run with the miss called out explicitly — before falling
      // through to whatever the model produces. `extraHistoryPushed` tracks the correction
      // message so the plan-mode "not committed yet" pop() below removes both, not just one.
      let extraHistoryPushed = 0;
      // Ask mode needs this at least as much as plan mode: "explain X" is the most common way to
      // use it, and a free model answering a codebase question from memory with ZERO tool calls
      // was measured doing exactly that in the 2026-08-09 benchmark (query E1 — 0 tool calls, a
      // plausible but generic answer the judge scored 0/0). Gating the correction to plan mode
      // left the mode where it happens most with no check at all.
      if (sdkMode === 'plan' || sdkMode === 'ask') {
        const subjectTerms = extractSubjectTerms(prompt);
        if (!looksLikeGroundedAnswer(result.text, subjectTerms)) {
          s.history.push({ role: 'user', content: offTopicCorrection(subjectTerms) });
          extraHistoryPushed = 1;
          result = await runner(this.deps.router, this.makeAgentOpts(s, m.requestId, sdkMode, m.reasoningEffort ?? 'medium', cbk, m.model), {});
          if (!this.isActiveRun(s, m.requestId)) return;
        }
      }

      // Hoisted so the fallthrough below (plan mode, neither a clarify question nor an
      // actionable plan) can reuse this instead of re-parsing the identical `result.text`.
      let planClar: ReturnType<typeof resolveClarifying> | undefined;
      if (m.mode === 'plan') {
        const clar = resolveClarifying(result.text, result.askQuestions);
        planClar = clar;
        if (clar.questions && clar.questions.length) {

          s.history.length -= 1 + extraHistoryPushed;
          s.pendingPlanUser = userContent;
          s.pendingClarify = { requestId: m.requestId, userContent, prompt, questions: clar.questions, mode: 'plan' };
          this.postCard(s, { type: 'clarifyingQuestions', sessionId: s.id, requestId: m.requestId, questions: clar.questions });
          return;
        }

        // Decide whether the reply is a runnable plan. The regex gate (looksLikeActionablePlan)
        // is the fast path, but it needs a clean numbered/bulleted list — weak free models often
        // reply in flowing prose instead, which failed the gate and left no plan card ("plan mode
        // not plan"). Fall back to extractPlanFromProse: an LLM pass that classifies whether the
        // prose is genuinely an actionable plan and lifts its steps. The isPlan discriminator
        // keeps a real Q&A/explanation reply as prose (no false plan card).
        let planStepsText: string | null = looksLikeActionablePlan(clar.text) ? clar.text : null;
        if (!planStepsText && clar.text.trim()) {
          const extracted = await extractPlanFromProse(this.deps.router, clar.text);
          if (!this.isActiveRun(s, m.requestId)) return;
          if (extracted.isPlan && extracted.steps.length) planStepsText = formatStructuredSteps(extracted.steps);
        }
        if (planStepsText) {
          s.history.length -= 1 + extraHistoryPushed; // not committed yet — re-added on approval
          s.pendingPlanUser = userContent;
          this.postCard(s, { type: 'planProposed', sessionId: s.id, requestId: m.requestId, steps: planStepsText });
          this.preparePlanFile(s, prompt);
          // Only fire-and-forget re-refine when we used the raw regex-parsed text; the extracted
          // path is already a clean numbered list.
          if (planStepsText === clar.text) this.upgradePlanSteps(s, m.requestId, clar.text);
          return;
        }

      }

      // ── Autonomous continuation loop (todo-driven) ───────────────────────────────────
      // Turns the engine from single-response into goal-pursuing: the agent writes a plan via the
      // `todowrite` tool, and this loop keeps re-invoking the model until every planned item is
      // `completed` (the "visible plan" IS the completion contract — and the verify command is its
      // arbiter, see decideStepRound's step-acceptance rule). The DECISIONS live in
      // core/stepEngine.ts (decideStepRound) so headless callers and tests share this exact
      // brain; this loop owns only the UI effects around each round: persisting the finished
      // round, pushing the continuation message into history, and the per-round model routing.
      // A per-send round cap (maxAutoContinueRounds) bounds total autonomy; the Stop button
      // (isActiveRun/abort) always wins. A plain Q&A turn that never wrote a plan has no pending
      // todos → this never fires, so simple chats still return in one turn.
      const agentCfg = vscode.workspace.getConfiguration('tiermux.agent');
      const autoContinueOn = agentCfg.get<boolean>('autoContinue', true);
      const maxAutoContinueRounds = agentCfg.get<number>('maxAutoContinueRounds', 25);
      const maxBudgetContinuations = agentCfg.get<number>('maxBudgetContinuations', 1);
      const maxStuckContinuations = agentCfg.get<number>('maxStuckContinuations', 1);
      const maxUnacceptedContinuations = agentCfg.get<number>('maxUnacceptedContinuations', 2);
      if (m.mode === 'agent' && autoContinueOn) {
        // Capture the original user request so each continuation round re-injects the goal.
        // After history compaction or a small-window trim the original task can be evicted from
        // context, leaving the model working toward a summary it never saw — re-injecting it here
        // prevents that without increasing the continuation message's cost on tiny windows (kept
        // short: first 200 chars). `prompt` is the raw user text; strip attachment blocks since
        // those are separate context, not goal text.
        const originalTask = prompt.replace(/\n\{\s*"type":\s*"(image_url|file)"/g, '').trim();
        let budgetContinuations = 0;
        let stuckContinuations = 0;
        let unacceptedContinuations = 0;
        for (let ac = 0; ac < maxAutoContinueRounds && this.isActiveRun(s, m.requestId); ac++) {
          // Only todos written during THIS send count (see todosAtSendStart) — stale todos from an
          // earlier turn must not keep a fresh, unrelated turn spinning.
          const wroteTodosThisSend = s.lastTodos !== todosAtSendStart;
          const sendTodos = wroteTodosThisSend ? (s.lastTodos ?? []) : [];
          // In Auto mode, a stuck round is also given a genuinely different model, not just a
          // nudge to the same one — an explicit model pin is the user's own choice and stays
          // untouched even after a stall.
          const isAutoMode = !s.model || s.model === 'auto';
          const decision = decideStepRound({
            todos: sendTodos,
            result,
            originalTask,
            stuckContinuations,
            maxStuckContinuations,
            budgetContinuations,
            maxBudgetContinuations,
            unacceptedContinuations,
            maxUnacceptedContinuations,
            allowModelExclusion: isAutoMode,
          });
          if (decision.action === 'stop') {
            if (sendTodos.length) diagLog('send.autocontinue', `halt: ${decision.reason} after round ${ac}`);
            break;
          }
          stuckContinuations = decision.stuckContinuations;
          budgetContinuations = decision.budgetContinuations;
          unacceptedContinuations = decision.unacceptedContinuations;

          this.persistAgentTurn(s, result);
          s.history.push({ role: 'user', content: decision.message });
          if (decision.difficulty && decision.difficulty !== 'medium') {
            const stepTodo = sendTodos.find((t) => t.status !== 'completed');
            diagLog('send.steproute', `round ${ac + 1} (${decision.kind}): routing next todo as ${decision.difficulty} — "${stepTodo?.content.slice(0, 60) ?? '?'}"`);
          }
          diagLog('send.autocontinue', `round ${ac + 1}/${maxAutoContinueRounds} · ${decision.reason} · paused=${result.paused}${decision.excludeModels ? ` · excluding ${decision.excludeModels[0]}` : ''}`);
          result = await runAgentStream(this.deps.router, this.makeAgentOpts(s, m.requestId, 'agent', s.reasoningEffort ?? 'medium', cbk, s.model, decision.excludeModels, decision.difficulty), {});
          if (!this.isActiveRun(s, m.requestId)) return;
        }
      }

      console.error(`[tiermux][TRACE2] pre-failed-check: result.failed=${result.failed} result.text.length=${result.text.length} result.errorMessage="${result.errorMessage ?? '<undefined>'}" isActiveRun=${this.isActiveRun(s, m.requestId)}`);
      // The turn genuinely failed (router/provider error with no salvageable text or tool
      // calls) — onError already posted a thin error notice from inside runTurn, but that's
      // easy to miss in a chat UI. Show a real reply bubble with the failure reason instead —
      // honest text, no fake usage/footer (there was no completion to report stats for) — and
      // don't persist it into the model-context history (nothing happened for the model to
      // remember) or pop the trailing user turn so a retry isn't confused by a dangling one.
      if (result.failed) {
        if (s.history[s.history.length - 1]?.role === 'user') s.history.pop();
        const errorText = result.errorMessage || 'I wasn\'t able to produce a response. Try again, or switch to a different model.';
        this.pushAssistantTurn(s, m.requestId, { ...result, text: errorText }, sentAt);
        this.post({ type: 'assistantMessage', sessionId: s.id, requestId: m.requestId, text: errorText, platform: turnPlatformLabel(s.model, result, this.deps), model: turnModelLabel(s.model, result.model) });
        return;
      }

      const after = this.deps.usage.get();
      const usage = {
        promptTokens: after.promptTokens - before.promptTokens,
        completionTokens: after.completionTokens - before.completionTokens,
        reasoningTokens: after.reasoningTokens - before.reasoningTokens,
        totalTokens: after.totalTokens - before.totalTokens,
      };

      const agentClar = planClar ?? (!result.paused ? resolveClarifying(result.text, result.askQuestions) : { questions: null, text: result.text });

      // Final check, independent of WHY the turn ended (guardrail stop, round-cap exhaustion, or
      // plain completion): does the plan written this send still have unfinished items? Computed
      // straight from todo state rather than the model's own text, so it's always accurate.
      const wroteTodosThisSend = s.lastTodos !== todosAtSendStart;
      const finalTodos = wroteTodosThisSend ? (s.lastTodos ?? []) : [];
      const finalRemainingTodos = finalTodos.filter((t) => t.status !== 'completed');
      const todoNote = agentClar.questions ? ''
        : finalRemainingTodos.length > 0 ? (!result.paused ? incompleteTodosNote(finalTodos, finalRemainingTodos) : '')
        : finalTodos.length > 0 ? completedTodosNote(finalTodos)
        : '';

      const displayText = todoNote ? `${agentClar.text}${todoNote}` : agentClar.text;

      const persistedResult: AgentResult = displayText !== result.text ? { ...result, text: displayText } : result;
      this.persistAgentTurn(s, persistedResult);
      this.pushAssistantTurn(s, m.requestId, persistedResult, sentAt, usage);
      this.rememberWindow(s, result.platform, result.model);

      if (result.taskKind && result.platform && result.model) {
        s.voteCtx.set(m.requestId, { taskKind: result.taskKind, platform: result.platform, model: result.model, last: 'none' });
      }
      const pinned = turnModelLabel(s.model, result.model);
      const hasQuestions = !!(agentClar.questions && agentClar.questions.length);

      this.post({ type: 'assistantMessage', sessionId: s.id, requestId: m.requestId, text: displayText, reasoning: result.reasoning, usage, platform: turnPlatformLabel(s.model, result, this.deps), model: pinned, paused: result.paused, noFooter: hasQuestions });
      this.post({ type: 'usageTotals', totals: this.currentUsageTotals(s) });
      if (hasQuestions) {
        s.pendingClarify = { requestId: m.requestId, userContent, prompt, questions: agentClar.questions!, mode: m.mode as 'plan' | 'agent' };
        this.postCard(s, { type: 'clarifyingQuestions', sessionId: s.id, requestId: m.requestId, questions: agentClar.questions! });
      }
    } catch (e) {
      if (!this.isActiveRun(s, m.requestId)) return; // abandoned run — don't surface its error
      this.post({ type: 'error', sessionId: s.id, requestId: m.requestId, message: e instanceof Error ? e.message : String(e) });
      void this.maybeRecommendModels(e);

      if (s.history[s.history.length - 1]?.role === 'user') s.history.pop();
    } finally {

      release();
      if (this.isActiveRun(s, m.requestId)) {
        s.activeRequestId = undefined;
        this.clearInProgressTurn(s, m.requestId);
        this.settlePendingApprovals(s, false); // safety net: never leave a command waiting after the run ends
        this.settlePendingAskUser(s);
        await this.finishCheckpoint(s, m.requestId);
        this.persist(s.id);
        this.post({ type: 'busy', sessionId: s.id, busy: false });
        this.setStatus(s.id, 'finished');
        await this.maybeAutoCompact(s);
        void this.maybeGenerateTitle(s);
      }
    }
  }

  /**
   * A real git commit landed — the working-tree edits the pinned bar was tracking are now
   * history, not something "Undo all" should touch. Drop every session's checkpoints and
   * refresh the bar (hides it) rather than trying to reconcile which files got committed.
   */
  async clearAllCheckpoints(): Promise<void> {
    for (const s of this.sessions.values()) {
      s.checkpoints.clear();
      this.persist(s.id);
      if (s.id === this.viewedSessionId) await this.postCheckpoints(s);
    }
  }

  /** Commit the turn's checkpoint, then refresh the restore bar on every command. */
  private async finishCheckpoint(s: Session, _requestId: string): Promise<void> {
    s.checkpoints.commit();
    await this.postCheckpoints(s);
  }

  /**
   * Re-emit a checkpoint marker for every turn that captured edits. Each carries the
   * cumulative set of files that restoring "to before this message" would revert, so
   * earlier commands show a larger set than later ones (Cursor/Windsurf semantics).
   */
  private async postCheckpoints(s: Session): Promise<void> {
    for (const cp of s.checkpoints.list()) {
      const files = await s.checkpoints.changedFiles(cp.id);
      this.post({ type: 'checkpoint', sessionId: s.id, requestId: cp.requestId, id: cp.id, files });
    }
    await this.postChangedFilesBar(s);
  }

  /**
   * Feed the pinned "changed files" bar above the composer. The earliest checkpoint
   * aggregates every edit made this session (cumulative semantics), so its file set is
   * the full review list and its id is what "Undo all" restores. Empty set hides the bar.
   * agentChangedFiles() filters to what TIERMUX itself edited — the user's own concurrent
   * edits / build output don't belong in the agent's review list.
   */
  private async postChangedFilesBar(s: Session): Promise<void> {
    const cps = s.checkpoints.list();
    if (!cps.length) { this.post({ type: 'changedFiles', sessionId: s.id, id: '', files: [] }); return; }
    const id = cps[0].id;
    const files = await s.checkpoints.agentChangedFiles(id);
    this.post({ type: 'changedFiles', sessionId: s.id, id, files });
  }

  /**
   * "Revert to here": roll the workspace back to before a command, drop that command
   * and every later turn, and put its text back in the composer (Cursor/Windsurf style).
   */
  private async handleRevertTo(s: Session, requestId: string): Promise<void> {
    const idx = s.transcript.findIndex((t) => t.role === 'user' && t.requestId === requestId);
    if (idx < 0) return;
    const removedText = s.transcript[idx].text;
    const removedAttachments = s.transcript[idx].attachments;
    const removedIds = s.transcript.slice(idx).filter((t) => t.role === 'user' && t.requestId).map((t) => t.requestId!);

    let firstCpId: string | undefined;
    for (const rid of removedIds) { const cid = s.checkpoints.idForRequest(rid); if (cid) { firstCpId = cid; break; } }
    const fileCount = firstCpId ? (await s.checkpoints.changedFiles(firstCpId)).length : 0;

    const laterTurns = s.transcript.slice(idx).filter((t) => t.role === 'user').length;
    const detail = fileCount
      ? `${fileCount} changed file${fileCount > 1 ? 's' : ''} will be restored and ${laterTurns} message${laterTurns > 1 ? 's' : ''} removed.`
      : `${laterTurns} message${laterTurns > 1 ? 's' : ''} will be removed.`;
    const choice = await vscode.window.showWarningMessage(`Revert to this point? ${detail}`, { modal: true }, 'Revert');
    if (choice !== 'Revert') return;

    this.stopRun(s.id);

    if (firstCpId) await s.checkpoints.restore(firstCpId);
    s.checkpoints.dropByRequestIds(removedIds);

    const cut = s.transcript[idx]?.historyLen;
    s.transcript = s.transcript.slice(0, idx);
    s.history = (typeof cut === 'number' && cut <= s.history.length)
      ? s.history.slice(0, cut)
      : s.transcript.map((t) => ({ role: t.role, content: t.text }));

    this.post({ type: 'switchSession', sessionId: s.id, messages: s.transcript });
    this.post({ type: 'setInput', text: removedText, attachments: removedAttachments });
    if (fileCount) this.post({ type: 'notice', sessionId: s.id, text: `Reverted ${fileCount} file${fileCount !== 1 ? 's' : ''} to this point.`, icon: 'revert' });
    this.persist(s.id);

    await this.postCheckpoints(s);
  }

  private async handleRestoreCheckpoint(s: Session, id: string): Promise<void> {
    const files = await s.checkpoints.changedFiles(id);
    if (!files.length) {
      this.post({ type: 'notice', sessionId: s.id, text: 'Nothing to restore — the workspace already matches this point.' });
      return;
    }
    const plural = files.length > 1;
    const choice = await vscode.window.showWarningMessage(
      `Restore the workspace to before this message? ${files.length} file${plural ? 's' : ''} edited since then will be reverted.`,
      { modal: true },
      'Restore',
    );
    if (choice !== 'Restore') return;
    const n = await s.checkpoints.restore(id);
    this.post({ type: 'notice', sessionId: s.id, text: `Restored ${n} file${n !== 1 ? 's' : ''} to before this message.`, icon: 'revert' });
    await this.postCheckpoints(s);
  }

  /** Compute (but do NOT write) the file this plan will be saved to if approved. Stores the
   *  URI on the session so handleApprovePlan's writePlanFile call has a stable destination —
   *  nothing touches disk until the user actually approves and runs the plan. */
  private preparePlanFile(s: Session, title: string): void {
    const cfg = vscode.workspace.getConfiguration('tiermux.plan');
    if (!cfg.get<boolean>('saveToFile', true)) return;
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return;
    const folder = (cfg.get<string>('folder', '.tiermux/plans') || '.tiermux/plans').replace(/^[\\/]+|[\\/]+$/g, '');
    const clean = (title || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'plan';
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
    const dir = vscode.Uri.joinPath(ws.uri, ...folder.split('/'));
    const fileUri = vscode.Uri.joinPath(dir, `${stamp}-${clean}.md`);
    s.pendingPlanFile = { uri: fileUri, title: title || 'Untitled' };
  }

  /** Fire-and-forget: refine a just-posted plan card's raw-prose steps into a clean, deduplicated
   *  numbered list via structurePlanSteps' schema-validated structured output, then silently
   *  re-post the SAME planProposed card to upgrade it in place. Never awaited by the caller — the
   *  card already shown used Plan.ts's own regex bullet/number parser on the raw text, so the user
   *  sees a plan instantly with no added latency; this only makes it *nicer* a moment later.
   *  Skipped entirely if the user has already acted on the plan (approved/deferred/discarded —
   *  `s.pendingPlanUser` gets cleared by all three) or moved on to a new turn, and does nothing
   *  on any failure/timeout (structurePlanSteps never throws, returns null instead). */
  private upgradePlanSteps(s: Session, requestId: string, rawText: string): void {
    const pendingAtStart = s.pendingPlanUser;
    void structurePlanSteps(this.deps.router, rawText).then((steps) => {
      if (!steps || !steps.length) return;
      if (!this.isActiveRun(s, requestId)) return;
      if (s.pendingPlanUser !== pendingAtStart) return; // already approved/deferred/discarded
      this.postCard(s, { type: 'planProposed', sessionId: s.id, requestId, steps: formatStructuredSteps(steps) });
    });
  }

  /** Write (or overwrite) the plan MD file for the session with the current steps. */
  private async writePlanFile(s: Session, steps: string): Promise<void> {
    if (!s.pendingPlanFile) return;
    const { uri, title } = s.pendingPlanFile;
    const checklist = steps.split('\n').map((line) => {
      const mm = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
      return mm ? `- [ ] ${mm[1]}` : line;
    }).join('\n');
    const body = `# Plan: ${title}\n\n_Generated by ${PRODUCT_NAME} · ${new Date().toLocaleString()}_\n\n${checklist}\n`;
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(body));
      // Pass the URI directly on the notice (not looked up via s.pendingPlanFile at click
      // time) so the click still works after approval clears pendingPlanFile.
      this.post({ type: 'notice', sessionId: this.viewedSessionId, text: `Plan saved to ${vscode.workspace.asRelativePath(uri)}`, icon: 'save', action: { kind: 'openPlanFile', uri: uri.toString() } });
    } catch (e) {
      this.post({ type: 'notice', sessionId: this.viewedSessionId, text: `Could not save plan file: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /**
   * "Keep discussing": release the plan gate without executing or discarding. The user wants to
   * refine first — so drop the pending-plan state (the next message is a clean discussion turn),
   * keep any edits they made to the steps, and mark the card so it replays without re-gating.
   * Nothing is written to disk here — the plan only touches the filesystem once approved
   * (handleApprovePlan), so an edited-but-never-run plan never leaves a stray .md behind.
   */
  private handleDeferPlan(m: Extract<InMessage, { type: 'deferPlan' }>): void {
    const s = this.current();
    s.pendingPlanUser = undefined;
    for (const c of s.cards) {
      if (c.type === 'planProposed' && c.requestId === m.requestId) {
        if (m.steps) (c as { steps?: string }).steps = m.steps;
        (c as { deferred?: boolean }).deferred = true;
      }
    }
  }

  private async handleApprovePlan(m: Extract<InMessage, { type: 'approvePlan' }>): Promise<void> {
    const s = this.current();
    this.removeCards(s, (c) => c.type === 'clarifyingQuestions');
    if (!m.approved) {
      s.pendingPlanUser = undefined;
      s.pendingPlanFile = undefined;
      for (const c of s.cards) {
        if (c.type === 'planProposed' && c.requestId === m.requestId) (c as { discarded?: boolean }).discarded = true;
      }
      this.post({ type: 'planDiscarded', sessionId: s.id, requestId: m.requestId });
      return;
    }

    // Build Plan only commits the plan to disk — it does NOT execute it. Plan mode has no
    // write/edit/run tools by design, so actually carrying it out always needs a manual switch
    // to Agent mode; auto-running here used to paper over that with an implicit mode hop the
    // user never asked for.
    //
    // No checkpoint wrapping here on purpose: checkpoints are keyed to a `s.transcript` user-turn
    // requestId (that's what the per-message revert icon looks up), and this Build click has no
    // transcript entry of its own — a synthetic checkpoint here would be unreachable from the UI.
    // The file naturally falls under whichever real turn's checkpoint is still open (the Plan
    // proposal that led here), which already has a working revert affordance — "Revert to here"
    // on that message correctly undoes the plan file along with everything after it.
    if (m.steps) await this.writePlanFile(s, m.steps);
    s.pendingPlanFile = undefined;
    this.removeCards(s, (c) => c.type === 'planProposed');
    const original = s.pendingPlanUser;
    s.pendingPlanUser = undefined;
    if (original) s.history.push({ role: 'user', content: original });
    if (m.steps) s.history.push({ role: 'assistant', content: `Approved plan:\n\n${m.steps}` });
    this.persist(s.id);
    this.post({ type: 'notice', sessionId: s.id, text: 'Plan approved — switch to Agent mode and send a message to start executing it.', icon: 'check' });
    if (this.sessions.has(s.id)) this.setStatus(s.id, 'idle');
  }

  /**
   * Execute an approved plan: write it to a file (like handleApprovePlan), switch the user's mode
   * to Agent, and AUTO-LAUNCH an agent turn seeded with the plan. This is the explicit
   * execute-or-not path the flow was missing — unlike the old implicit mode hop (removed; see the
   * comment in handleApprovePlan), this only fires on a direct Execute click. The launched turn
   * flows through the normal handleSend path, so it gets the autonomous loop, the end-of-turn
   * workspace verify, and the change recap like any agent turn.
   */
  private async handleExecutePlan(m: Extract<InMessage, { type: 'executePlan' }>): Promise<void> {
    const s = this.current();
    this.removeCards(s, (c) => c.type === 'clarifyingQuestions');
    if (!m.steps?.trim()) return;

    // 1. Persist the plan exactly like Save does (file + history), so an executed plan is also
    //    saved to disk and remembered in conversation history.
    if (m.steps) await this.writePlanFile(s, m.steps);
    s.pendingPlanFile = undefined;
    this.removeCards(s, (c) => c.type === 'planProposed');
    const original = s.pendingPlanUser;
    s.pendingPlanUser = undefined;
    if (original) s.history.push({ role: 'user', content: original });
    s.history.push({ role: 'assistant', content: `Approved plan:\n\n${m.steps}` });
    this.persist(s.id);

    // 2. Switch the user's mode to Agent (their next message also lands in Agent) and show the
    //    executing ⚡ indicator for the about-to-launch run.
    this.post({ type: 'setMode', sessionId: s.id, mode: 'agent' });

    // 3. First-class plan execution: structure the approved plan into steps and drive them
    //    through the plan runner (per-step rounds, verify acceptance, bounded same-model
    //    retries, read-only plan repair, resumable state). Degrades to the legacy single-send
    //    path when no ≥2-step structure can be extracted (weak free models).
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const structuredSteps = await structurePlanSteps(this.deps.router, m.steps)
      ?? planStepsToTodos(m.steps).map((t) => t.content);
    if (structuredSteps.length >= 2) {
      const originalTask = (original ? contentToString(original) : 'the approved plan').replace(/\n\{\s*"type":\s*"(image_url|file)"/g, '').trim().slice(0, 200);
      s.executingPlan = true;
      s.planRun = {
        id: `plan-${Date.now()}`,
        originalTask,
        steps: structuredSteps.slice(0, 20).map((text) => ({ text, status: 'pending', attempts: 0 })),
        currentStep: 0,
        status: 'running',
        repairs: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.post({ type: 'planExecuting', sessionId: s.id, requestId, executing: true });
      this.persist(s.id);
      await this.executePlanRun(s, requestId);
      return;
    }

    // Legacy fallback: unstructurable plan text runs as ONE agent turn, exactly like before.
    this.post({ type: 'planExecuting', sessionId: s.id, requestId, executing: true });
    await this.handleSend({
      type: 'sendMessage',
      requestId,
      text: `Carry out this approved plan now, step by step:\n\n${m.steps}`,
      mode: 'agent',
      model: s.model ?? 'auto',
      reasoningEffort: s.reasoningEffort ?? 'medium',
    });
  }

  /**
   * Drive a session's planRun state through the first-class plan runner (core/planRunner.ts).
   * Owns the UI lifecycle around the run the same way handleSend does for a single send:
   * run slot, busy state, checkpoints, streaming callbacks, transcript/history persistence,
   * and the finish/cleanup path. Resume-safe: called both from handleExecutePlan and from the
   * webview's Resume button after a reload (state.currentStep picks up where it stopped).
   */
  private async executePlanRun(s: Session, requestId: string): Promise<void> {
    if (!s.planRun) return;
    s.cancel?.cancel();
    s.cancel?.dispose();
    s.cancel = new vscode.CancellationTokenSource();
    s.activeRequestId = requestId;
    this.settlePendingAskUser(s);

    const release = await this.acquireRunSlot(s.id);
    if (s.activeRequestId !== requestId) { release(); return; }
    this.post({ type: 'busy', sessionId: s.id, busy: true });

    try {
      await s.checkpoints.begin(requestId, 'plan execution');
      this.beginInProgressTurn(s, requestId);
      const cbk = this.agentCallbacks(s, requestId, 'agent');
      const planState = s.planRun;
      planState.status = 'running';
      const result = await runPlan(
        this.deps.router,
        this.makeAgentOpts(s, requestId, 'agent', s.reasoningEffort ?? 'medium', cbk, s.model),
        planState,
        {
          repairSteps: (failure, remaining) => repairPlanSteps(this.deps.router, failure, remaining),
          isActive: () => this.isActiveRun(s, requestId),
          onState: (st) => {
            s.planRun = st;
            this.persist(s.id);
            this.post({ type: 'planProgress', sessionId: s.id, requestId, state: st });
          },
          onTodos: (todos) => {
            s.lastTodos = todos;
            this.post({ type: 'todos', sessionId: s.id, requestId, todos, followingPlan: true });
          },
          onHistory: (msgs) => { s.history.push(...msgs); this.persist(s.id); },
        },
      );

      if (!this.isActiveRun(s, requestId)) return;
      if (result.state.status !== 'paused') {
        s.executingPlan = false;
        // Final summary as a real transcript entry so the finished plan reads as one turn.
        s.transcript.push({ role: 'assistant', text: result.summary, requestId, ts: Date.now(), historyLen: s.history.length - 1 });
        s.history.push({ role: 'assistant', content: result.summary });
        this.post({ type: 'assistantMessage', sessionId: s.id, requestId, text: result.summary, platform: turnPlatformLabel(s.model, result.lastResult, this.deps), model: turnModelLabel(s.model, result.lastResult?.model) });
      }
    } catch (e) {
      if (!this.isActiveRun(s, requestId)) return;
      this.post({ type: 'error', sessionId: s.id, requestId, message: e instanceof Error ? e.message : String(e) });
    } finally {
      release();
      if (this.isActiveRun(s, requestId)) {
        s.activeRequestId = undefined;
        this.clearInProgressTurn(s, requestId);
        this.settlePendingApprovals(s, false);
        this.settlePendingAskUser(s);
        await this.finishCheckpoint(s, requestId);
        this.persist(s.id);
        this.post({ type: 'busy', sessionId: s.id, busy: false });
        this.setStatus(s.id, 'finished');
        await this.maybeAutoCompact(s);
      }
    }
  }

  /**
   * "Run checks" on a ResultCard: re-run the project's verify command OUTSIDE a turn and post
   * the outcome as its own bubble. Pure command execution — no model call, no edits — so it's
   * the honest answer to "is this actually done?" without asking the agent anything.
   */
  private async runManualVerify(s: Session): Promise<void> {
    if (s.activeRequestId) {
      this.post({ type: 'notice', sessionId: s.id, text: 'Skipped — a turn is still running. Try again once it finishes.' });
      return;
    }
    const cmd = resolveVerifyCommand();
    if (!cmd) {
      // Reachable only from an older card (current ones hide the action when no command
      // exists). Say it once, factually, and point at the setting — no standing request.
      this.post({ type: 'notice', sessionId: s.id, text: 'Nothing to run — no test or build command was found for this workspace\'s stack. Set `tiermux.agent.verifyCommand` to name one.' });
      return;
    }
    const requestId = `verify-${Date.now()}`;
    this.post({ type: 'notice', sessionId: s.id, text: `Running \`${cmd}\`…` });
    const run = await runVerifyCommand(cmd);
    if (!this.isActiveRun(s, requestId)) return; // superseded mid-check — drop the result
    const text = run.ok === true
      ? `✅ Verified — \`${cmd}\` passed. Your changes are in good shape.`
      : run.ok === false
        ? `❌ \`${cmd}\` fails right now:\n\`\`\`\n${run.output.slice(0, 1500)}\n\`\`\`\nAsk me to fix these failures and I'll take another pass.`
        : `⚠️ Couldn't run \`${cmd}\` (declined or timed out).`;
    this.post({ type: 'assistantMessage', sessionId: s.id, requestId, text, noFooter: true });
  }

  /**
   * Append an agent run's outcome to the conversation history. Agent/Debug runs return
   * their full working transcript (tool calls + results + final answer) as workMessages —
   * persisting that is what lets a paused/failed run resume with memory instead of redoing
   * work. Tool-less runs (chat/trivial) have no workMessages, so fall back to the final text.
   */
  private persistAgentTurn(s: Session, result: AgentResult): void {
    if (result.workMessages && result.workMessages.length) s.history.push(...result.workMessages);
    else s.history.push({ role: 'assistant', content: result.text });
  }

  /**
   * Record a finished assistant turn in the transcript WITH the details the live view showed
   * (reasoning, tool steps, usage, duration) so a re-render — e.g. after "Revert to here" or a
   * session switch — can rebuild the "Reasoning" and "Worked for Ns" disclosures instead of
   * dropping them. Drains the per-requestId step accumulator.
   */
  private pushAssistantTurn(s: Session, requestId: string, result: AgentResult, sentAt: number, usage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number; totalTokens: number }): void {
    const steps = s.liveSteps.get(requestId);
    s.liveSteps.delete(requestId);
    const rationale = s.liveRationale.get(requestId);
    s.liveRationale.delete(requestId);
    // The transcript is the durable structured representation: when the turn produced a
    // WorkReportData, it is persisted ON the entry (canonical) and posted to the webview
    // (live ResultCard). `.text` additionally carries the legacy markdown serialization so
    // transcripts written before WorkReportData keep rendering — new code renders from the
    // structured field and never parses that markdown back.
    let text = result.text;
    // The agent loop leaves `checkpointId` unset (it has no requestId); the HOST owns the turn
    // identity, so it is stamped here — before the report is posted OR persisted, so the live
    // ResultCard and its replay resolve the same immutable baseline. Without it every
    // changed-file row renders unclickable and `diffCheckpointFile` is unreachable.
    const report = result.workReport
      ? { ...result.workReport, checkpointId: s.checkpoints.idForTurn(requestId) }
      : undefined;
    if (report) {
      text += renderLegacyMarkdown(report); // LEGACY TRANSCRIPT SERIALIZATION — remove after the minimum supported transcript migration window.
      this.post({ type: 'workReport', sessionId: s.id, requestId, report });
    }
    s.transcript.push({
      role: 'assistant',
      text,
      // Carried so a replayed footer can vote (voteCtx is keyed by it). "Revert to here" only
      // ever matches role==='user' entries, so this can't be mistaken for a revert anchor.
      requestId,
      model: result.model ? `${result.runtimeName ?? result.platform}/${result.model}` : undefined,
      ts: Date.now(),
      secs: Math.max(0, Math.round((Date.now() - sentAt) / 1000)),
      reasoning: result.reasoning || undefined,
      usage: usage ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, reasoningTokens: usage.reasoningTokens } : undefined,
      steps: steps && steps.length ? steps : undefined,
      rationale: rationale && rationale.entries.length ? rationale : undefined,
      workReport: report,
    });
  }

  /**
   * True while `requestId` is still the active run in `session`. Cancelling (Stop) or
   * superseding a run within its session clears `activeRequestId`, so a run abandoned
   * mid-flight fails this check — its streaming and result are then dropped. NOTE: this is
   * about liveness WITHIN a session, not about whether the session is viewed — background
   * runs must keep streaming into their hidden container.
   */
  private isActiveRun(s: Session, requestId: string): boolean {
    return s.activeRequestId === requestId;
  }

  /** Cancel a session's in-flight run and detach it so its output can't land anywhere. Does NOT
   *  touch the webview's DOM: the abandoned turn's streamed text/tool cards/reasoning stay exactly
   *  as shown — cancelling only means no MORE output arrives, not that what already rendered should
   *  vanish. (It previously forced a `switchSession` rebuild here, which wiped the pane and replayed
   *  `s.transcript` — but a cancelled turn is never committed to `s.transcript` (see `isActiveRun`),
   *  so the rebuild replayed a transcript missing the very turn just abandoned: all partial progress
   *  visibly disappeared. Callers that DO need a rebuild — e.g. "Revert to here" — send their own
   *  `switchSession` after truncating the transcript; see revertTo below.) */
  private stopRun(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;

    const qi = this.runQueue.findIndex((q) => q.sessionId === sessionId);
    if (qi >= 0) { this.runQueue.splice(qi, 1)[0].resolve(); }
    // Capture before clearing — handleApprovePlan's own `finally` only posts
    // `planExecuting:false` when `isActiveRun` is still true, which Stop/cancel deliberately
    // breaks by nulling `activeRequestId` right below. Without this, cancelling mid-plan-
    // execution left the mode pill permanently stuck on "Agent ⚡" until some other plan
    // happened to run (which merely reassigns the stuck state, never clears it).
    const wasExecutingPlan = s.executingPlan;
    const executingRequestId = s.activeRequestId;
    s.cancel?.cancel();
    s.activeRequestId = undefined; // invalidates the run's liveness guard (isActiveRun)
    this.settlePendingApprovals(s, false); // unblock any command/edit awaiting a click
    this.settlePendingAskUser(s); // unblock any in-chat askUser card
    s.pendingClarify = undefined;
    s.pendingPlanUser = undefined;
    s.executingPlan = false;
    s.cards = [];
    this.setStatus(sessionId, 'idle');

    if (wasExecutingPlan && executingRequestId) {
      this.post({ type: 'planExecuting', sessionId, requestId: executingRequestId, executing: false });
    }

    this.post({ type: 'busy', sessionId, busy: false });
  }

  private makeAgentOpts(
    s: Session,
    _requestId: string,
    mode: AgentMode,
    effort: ReasoningEffort,
    callbacks: ReturnType<typeof this.agentCallbacks>,
    pinnedModel?: string,
    excludeModels?: string[],
    stepDifficulty?: 'easy' | 'medium' | 'hard',
  ): AgentOpts {
    return {
      messages: s.history,
      mode,
      effort,
      pinnedModel,
      excludeModels,
      stepDifficulty,
      sessionId: s.id,
      mentionCount: s.lastMentionCount,
      abortSignal: s.cancel ? tokenToAbortSignal(s.cancel.token) : undefined,
      profiler: this.deps.profiler,
      ...callbacks,
    };
  }

  /**
   * Build the streaming callbacks for a run, each gated on the run still being active IN ITS
   * SESSION. Centralizing the guard means a cancelled run goes quiet immediately instead of
   * rendering into another session. Not gated on viewed — background runs keep streaming.
   * The agent's `askUser` tool always surfaces as an in-chat card. Every mode can ask —
   * including Chat, whose web loop carries askUser to clarify time-sensitive queries.
   */
  private agentCallbacks(s: Session, requestId: string, _mode: Mode): Omit<AgentOpts, 'messages' | 'mode' | 'effort' | 'abortSignal' | 'pinnedModel' | 'taskKind'> {
    const live = (): boolean => this.isActiveRun(s, requestId);

    // Reasoning stream state — ONE block per thinking "burst", not one coalesced block per turn, so
    // the UI renders a think→tool→think→tool timeline. Each burst carries its own segment id; when a
    // tool call interrupts, the current burst is settled ('done', with a "Thought for Ns" duration)
    // and the segment id advances so the NEXT reasoning delta opens a fresh block below the tool
    // card. Each burst accumulates its own text (reset per segment) rather than the whole turn's.
    let reasoningSeg = 0;
    const reasoningId = () => `reason-${requestId}-${reasoningSeg}`;
    let reasoningText = '';
    let reasoningStart = 0;
    const flushReasoningDone = () => {
      if (!reasoningStart || !reasoningText.trim()) return;
      const durationMs = Date.now() - reasoningStart;
      this.post({ type: 'toolStatus', sessionId: s.id, requestId, toolCallId: reasoningId(), name: 'reasoning', args: undefined, state: 'done', detail: reasoningText, durationMs });
      reasoningStart = 0;
    };
    // A tool call interrupted reasoning: settle the current burst, then advance to a fresh segment
    // (new id + empty buffer) so reasoning that resumes AFTER the tool renders as its own block.
    const endReasoningSegment = () => {
      const had = !!(reasoningStart && reasoningText.trim());
      flushReasoningDone();
      if (had) { reasoningSeg++; reasoningText = ''; }
    };

    return {
      onModel: (platform, model, runtimeName) => {
        if (!live()) return;
        // Same platform-prefix stripping as sendMessage's `pinned` — s.model is the
        // picker's composite `platform::modelId` selector value when a model is pinned.
        const pinned = (s.model && s.model !== 'auto')
          ? s.model.includes('::') ? s.model.split('::').slice(1).join('::') : s.model
          : model;
        s.livePlatform = platform;
        s.liveModel = pinned;
        s.liveRuntimeName = runtimeName;
        this.post({ type: 'assistantStart', sessionId: s.id, requestId, platform: (runtimeName ?? platform) || turnPlatformLabel(s.model, undefined, this.deps), model: pinned });
      },
      onTool: (e: ToolEvent) => {
        if (!live()) return;
        endReasoningSegment(); // reasoning gave way to a tool call — settle this burst, start a new segment

        const steps = s.liveSteps.get(requestId) ?? [];
        const i = steps.findIndex((st) => st.toolCallId === e.toolCallId);
        const mappedState = e.state === 'queued' ? 'running' : e.state as 'running' | 'done' | 'error';
        const entry: TranscriptStep = { toolCallId: e.toolCallId, name: e.name, args: e.args, state: mappedState, detail: e.detail };
        if (i < 0 && FILE_WRITE_TOOL_NAMES.has(e.name)) {

          const rel = extractToolFilePath(e.args);
          const root = vscode.workspace.workspaceFolders?.[0]?.uri;
          if (rel && root) {
            const uri = vscode.Uri.joinPath(root, rel);
            void vscode.workspace.fs.readFile(uri).then(
              (buf) => s.checkpoints.record(uri, new TextDecoder().decode(buf)),
              () => s.checkpoints.record(uri, null), // doesn't exist yet — this is a create
            );
          }
        }
        if (i >= 0) steps[i] = entry; else steps.push(entry);
        s.liveSteps.set(requestId, steps);

        // Attribute shell-command workspace edits to the agent: snapshot git's dirty set just
        // before the command runs, diff just after. Files whose porcelain line appeared or
        // changed were edited BY the command → mark them TierMux-touched so the changed-files
        // overview (agentChangedFiles) includes them. The user editing a file exactly WHILE a
        // command runs would misattribute — a rare, acceptable window. Edit-tool writes don't
        // need this; record() already tags them.
        if (e.name === 'runCommand') {
          const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (cwd) {
            if (mappedState === 'running' && !s.commandBaselines.has(e.toolCallId)) {
              s.commandBaselines.set(e.toolCallId, statusLines(cwd));
            } else if (mappedState === 'done' || mappedState === 'error') {
              const before = s.commandBaselines.get(e.toolCallId);
              s.commandBaselines.delete(e.toolCallId);
              if (before) {
                void before.then(async (pre) => {
                  const post = await statusLines(cwd);
                  const changed: string[] = [];
                  for (const [p, line] of post) if (pre.get(p) !== line) changed.push(p);
                  if (changed.length) s.checkpoints.recordTouched(changed);
                });
              }
            }
          }
        }

        if (WRITE_TOOL_NAMES.has(e.name) && s.liveActivity !== 'Modifications') {
          s.liveActivity = 'Modifications';
          this.postSessionList();
        }
        this.post({ type: 'toolStatus', sessionId: s.id, requestId, toolCallId: e.toolCallId, name: e.name, args: e.args, state: mappedState, detail: e.detail });

        // Crash-recovery snapshot: append this completed/errored tool call to the in-progress
        // transcript and persist immediately, so a mid-turn extension-host crash loses at most
        // the tool call currently running, not the whole turn's work so far.
        if ((mappedState === 'done' || mappedState === 'error') && s.inProgressTurn?.requestId === requestId) {
          s.inProgressTurn.workMessages.push(
            { role: 'assistant', content: null, tool_calls: [{ id: e.toolCallId, type: 'function', function: { name: e.name, arguments: JSON.stringify(e.args ?? {}) } }] },
            { role: 'tool', content: e.detail ?? '', tool_call_id: e.toolCallId },
          );
          this.persist(s.id);
        }
      },
      onReasoning: (text) => {
        if (!live()) return;
        if (!text) return;
        if (!reasoningStart) reasoningStart = Date.now();
        // Append the raw delta — do NOT trim each fragment and join with '\n'. The old join inserted
        // a newline between EVERY streamed fragment, and since the reasoning body renders markdown
        // with breaks:true (\n → <br>), that turned each fragment into its own line and produced huge
        // vertical gaps. Concatenating raw reconstructs the model's own text exactly (mirrors loop.ts's
        // `reasoning += d`). trimStart only so a leading newline doesn't render as a blank first line.
        reasoningText = (reasoningText + text).replace(/^\s+/, '');
        // Always 'running' while the reasoning stream is live; the webview auto-opens the block
        // and shows "Thinking…". Settled to 'done' (with duration) at turn finalize below.
        this.post({ type: 'toolStatus', sessionId: s.id, requestId, toolCallId: reasoningId(), name: 'reasoning', args: undefined, state: 'running', detail: reasoningText });
      },
      onStep: (phase, label) => { if (!live()) return; s.lastStepLabel = label; this.post({ type: 'agentStep', sessionId: s.id, requestId, phase: phase as 'thinking' | 'synthesizing' | 'done', label }); },
      onTodos: (todos) => {
        if (!live()) return;
        s.lastTodos = todos;
        this.post({ type: 'todos', sessionId: s.id, requestId, todos, followingPlan: !!s.executingPlan });
        // Keep the AI Elements Plan card in lockstep with todo progress while a plan executes.
        if (s.executingPlan && todos.length) this.post({ type: 'planData', sessionId: s.id, requestId, data: planDataFromTodos('Approved plan', todos) });
      },
      onChunk: (text) => {
        if (!live()) return;
        flushReasoningDone(); // reasoning gave way to the final answer — settle the "Thought for Ns" block
        if (s.liveActivity !== 'Text change') { s.liveActivity = 'Text change'; this.postSessionList(); }
        this.post({ type: 'assistantChunk', sessionId: s.id, requestId, text });
      },
      onRetractDraft: () => {
        if (!live()) return;
        // Hand the webview the CoT segment this text is about to become. The reasoning post that
        // follows (from loop.ts's finish-step retro-route) carries the same toolCallId, so it
        // updates the converted block in place — the user sees one continuously-streamed thought,
        // not a draft that disappears and re-materializes as a finished paragraph.
        if (!reasoningStart) reasoningStart = Date.now();
        this.post({ type: 'clearDraft', sessionId: s.id, requestId, reasoningId: reasoningId() });
      },
      onAskUser: async (question, options) => {
        if (!live()) return '';

        const callId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        return this.requestAskUser(s, requestId, callId, question, options);
      },
      onPermissionAsk: async (info) => {
        if (!live()) return 'reject';

        const dangerous = !!(info.command && isDangerous(info.command));
        // Global Auto-approve toggle: everything proceeds except dangerous commands.
        if (this.autoApprove && !dangerous) return 'once';
        // Per-tool session allowlist: the user already clicked "Always" for this tool kind this
        // session — auto-approve matching calls, but NEVER a dangerous command (those keep asking).
        if (info.toolName && !dangerous && s.alwaysAllowTools.has(info.toolName)) return 'once';

        const resp = await this.requestPermissionAsk(s.id, requestId, info.title, info.pattern);
        // "Always" = remember this tool kind for the rest of the session so we stop asking for it.
        // Skip dangerous commands so a one-off "Always" on a risky command can't disable its gate.
        if (resp === 'always' && info.toolName && !dangerous) s.alwaysAllowTools.add(info.toolName);
        return resp;
      },
      onFailover: (from, reason) => {
        if (!live()) return;
        const sep = from.indexOf('::');
        const platformId = sep >= 0 ? from.slice(0, sep) : from;
        const modelId = sep >= 0 ? from.slice(sep + 2) : '';
        this.post({ type: 'failoverNotice', sessionId: s.id, requestId, from: `${displayNameForEntry({ platform: platformId, modelId }, this.deps)}/${modelId}`, reason });
      },
      onSelectionRationale: (info) => {
        if (!live()) { diagLog('chat.rationale', `requestId=${requestId} DROPPED — run no longer active`); return; }
        const toName = (key: string): string => {
          const sep = key.indexOf('::');
          const platformId = sep >= 0 ? key.slice(0, sep) : key;
          const modelId = sep >= 0 ? key.slice(sep + 2) : '';
          return `${displayNameForEntry({ platform: platformId, modelId }, this.deps)}/${modelId}`;
        };
        const rationale: SelectionRationale = {
          picked: info.picked ? toName(info.picked) : undefined,
          entries: info.entries.map((e) => ({ ...e, model: toName(e.model) })),
        };
        // Keep the latest for this turn — an agent turn routes many times, and the last report
        // describes the model that produced the final answer (the one the footer names).
        s.liveRationale.set(requestId, rationale);
        diagLog('chat.rationale', `requestId=${requestId} entries=${rationale.entries.length} picked=${rationale.picked ?? '<none>'} → posted`);
        this.post({ type: 'selectionRationale', sessionId: s.id, requestId, taskKind: info.taskKind, ...rationale });
      },
      onKeyRotated: (info) => {
        if (!live()) return;
        const name = getPlatformInfo(info.platform as Platform)?.name ?? info.platform;
        this.post({ type: 'keyRotated', sessionId: s.id, requestId, platform: info.platform, platformName: name, keyIndex: info.keyIndex, keyTotal: info.keyTotal });
      },
      onError: (message) => {
        if (!live()) return;
        this.post({ type: 'error', sessionId: s.id, requestId, message });
      },
      onWarning: (message) => {

        if (!live()) return;
        this.post({ type: 'notice', sessionId: s.id, text: message });
      },
      onWatchdogWarning: (info) => {
        if (!live()) return;
        this.post({ type: 'watchdogWarning', sessionId: s.id, requestId, elapsedMs: info.elapsedMs, lastActivityLabel: info.lastActivity?.label, lastActivityAgeMs: info.lastActivity ? Date.now() - info.lastActivity.atMs : undefined });
      },
      onWatchdogActionable: (info) => {
        if (!live()) return;
        this.post({ type: 'watchdogActionable', sessionId: s.id, requestId, elapsedMs: info.elapsedMs, lastActivityLabel: info.lastActivity?.label, lastActivityAgeMs: info.lastActivity ? Date.now() - info.lastActivity.atMs : undefined, hasPartialOutput: info.hasPartialOutput });
      },
      onWatchdogDismissed: () => {
        if (!live()) return;
        this.post({ type: 'watchdogDismissed', sessionId: s.id, requestId });
      },
    };
  }

  /**
   * When a run fails because every configured model was exhausted (escalation couldn't find a
   * stronger one either), show a plain notice and offer to manage models. No-op for any other
   * error kind.
   */
  private async maybeRecommendModels(e: unknown): Promise<void> {
    if (!(e instanceof AllModelsFailedError)) return;
    const enabledCount = this.deps.settings.enabledByPriority().length;
    const failedLine = enabledCount <= 1
      ? 'Your enabled model could not handle this request.'
      : `${enabledCount} enabled models failed to handle this request.`;
    const choice = await vscode.window.showInformationMessage(
      failedLine,
      'Manage Models',
    );
    if (choice === 'Manage Models') void vscode.commands.executeCommand('tiermux.openModelSettings');
  }

  /**
   * Resume an agent run that paused — whether it hit the step cap or a free model dropped
   * out. The prior working transcript is already in history (see persistAgentTurn), so the
   * agent picks up where it left off rather than re-planning. Always runs in Agent mode so a
   * follow-up never triggers a fresh Plan pass.
   */
  private async handleResume(m: Extract<InMessage, { type: 'resume' }>): Promise<void> {
    const s = this.current();

    s.history.push({
      role: 'user',
      content: 'Continue from where you left off. Keep going with the remaining steps using the work already done above — do not restart or repeat completed steps.',
    });
    // Cancel the previous run BEFORE replacing the token. CancellationTokenSource.dispose()
    // only drops listeners — it does NOT abort — so without cancel() a pre-empted in-flight
    // run keeps executing its model call in the background, wasting tokens and racing the
    // new run (a root cause of follow-up sends landing as silent "0 in / 0 out" turns).
    s.cancel?.cancel();
    s.cancel?.dispose();
    s.cancel = new vscode.CancellationTokenSource();
    s.activeRequestId = m.requestId;
    const release = await this.acquireRunSlot(s.id);
    if (s.activeRequestId !== m.requestId) { release(); if (this.sessions.has(s.id)) this.setStatus(s.id, 'idle'); return; }
    this.post({ type: 'busy', sessionId: s.id, busy: true });
    try {
      const before = this.deps.usage.get();
      await s.checkpoints.begin(m.requestId, 'Continue');
      const sentAt = Date.now();
      this.beginInProgressTurn(s, m.requestId);
      const cbk4 = this.agentCallbacks(s, m.requestId, 'agent');
      const result = await runAgentStream(this.deps.router, this.makeAgentOpts(s, m.requestId, 'agent', s.reasoningEffort ?? 'medium', cbk4, s.model), {});
      if (!this.isActiveRun(s, m.requestId)) return; // abandoned mid-run by a cancel
      // See the `result.failed` guard in the main send handler — show a real reply bubble with
      // the failure reason instead of a phantom blank "successful" turn.
      if (result.failed) {
        if (s.history[s.history.length - 1]?.role === 'user') s.history.pop();
        const errorText = result.errorMessage || 'I wasn\'t able to produce a response. Try again, or switch to a different model.';
        this.pushAssistantTurn(s, m.requestId, { ...result, text: errorText }, sentAt);
        this.post({ type: 'assistantMessage', sessionId: s.id, requestId: m.requestId, text: errorText, platform: turnPlatformLabel(s.model, result, this.deps), model: turnModelLabel(s.model, result.model) });
        return;
      }
      const after = this.deps.usage.get();
      const usage = {
        promptTokens: after.promptTokens - before.promptTokens,
        completionTokens: after.completionTokens - before.completionTokens,
        reasoningTokens: after.reasoningTokens - before.reasoningTokens,
        totalTokens: after.totalTokens - before.totalTokens,
      };
      this.persistAgentTurn(s, result);
      this.pushAssistantTurn(s, m.requestId, result, sentAt, usage);
      this.rememberWindow(s, result.platform, result.model);
      if (result.taskKind && result.platform && result.model) {
        s.voteCtx.set(m.requestId, { taskKind: result.taskKind, platform: result.platform, model: result.model, last: 'none' });
      }
      this.post({ type: 'assistantMessage', sessionId: s.id, requestId: m.requestId, text: result.text, reasoning: result.reasoning, usage, platform: turnPlatformLabel(s.model, result, this.deps), model: result.model, paused: result.paused });
      this.post({ type: 'usageTotals', totals: this.currentUsageTotals(s) });
    } catch (e) {
      if (!this.isActiveRun(s, m.requestId)) return;
      this.post({ type: 'error', sessionId: s.id, requestId: m.requestId, message: e instanceof Error ? e.message : String(e) });
      void this.maybeRecommendModels(e);

      if (s.history[s.history.length - 1]?.role === 'user') s.history.pop();
    } finally {
      release();
      if (this.isActiveRun(s, m.requestId)) {
        s.activeRequestId = undefined;
        this.clearInProgressTurn(s, m.requestId);
        this.settlePendingApprovals(s, false);
        this.settlePendingAskUser(s);
        await this.finishCheckpoint(s, m.requestId);
        this.persist(s.id);
        this.post({ type: 'busy', sessionId: s.id, busy: false });
        this.setStatus(s.id, 'finished');
        await this.maybeAutoCompact(s);
      }
    }
  }

  /** Resume after the user answers a clarifying-questions card (plan pre-flight or agent end-of-turn). */
  private async handleAnswerClarifying(m: Extract<InMessage, { type: 'answerClarifying' }>): Promise<void> {
    const s = this.current();
    const ctx = (s.pendingClarify && s.pendingClarify.requestId === m.requestId) ? s.pendingClarify : undefined;
    s.pendingClarify = undefined;

    this.removeCards(s, (c) => c.type === 'clarifyingQuestions' && c.requestId === m.requestId);
    if (!ctx) return;

    const qa = ctx.questions
      .map((q, i) => `Q: ${q.text}\nA: ${m.answers[i] ?? '(no answer)'}`)
      .join('\n');

    if (ctx.mode === 'agent') {
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await this.handleSend({ type: 'sendMessage', requestId, text: qa, mode: ctx.mode, model: s.model ?? 'auto', reasoningEffort: s.reasoningEffort ?? 'medium' });
      return;
    }

    const base = s.history.length;
    s.history.push({ role: 'user', content: ctx.userContent });
    s.history.push({ role: 'user', content: `Clarifications from the user:\n${qa}\n\nUsing these answers, produce the step-by-step plan now. Do not ask any further questions — through the ???QUESTIONS??? block or any tool — use your best judgment for anything still unspecified.` });

    // Cancel the previous run BEFORE replacing the token. CancellationTokenSource.dispose()
    // only drops listeners — it does NOT abort — so without cancel() a pre-empted in-flight
    // run keeps executing its model call in the background, wasting tokens and racing the
    // new run (a root cause of follow-up sends landing as silent "0 in / 0 out" turns).
    s.cancel?.cancel();
    s.cancel?.dispose();
    s.cancel = new vscode.CancellationTokenSource();
    s.activeRequestId = m.requestId;
    const release = await this.acquireRunSlot(s.id);
    if (s.activeRequestId !== m.requestId) { release(); if (this.sessions.has(s.id)) this.setStatus(s.id, 'idle'); return; }
    this.post({ type: 'busy', sessionId: s.id, busy: true });
    // Set true only by the "show as a normal answer" branch below — that reply is real
    // conversation the model needs to remember next turn, unlike the plan-proposal branches
    // (not committed until approval) or the empty/error branches (nothing happened). Gates
    // the blanket `s.history.length = base` reset in `finally` so this one case survives it.
    let committed = false;
    try {
      const sentAt = Date.now();
      const before = this.deps.usage.get();
      await s.checkpoints.begin(m.requestId, 'Plan (clarified)');
      this.beginInProgressTurn(s, m.requestId);
      const cbk5 = this.agentCallbacks(s, m.requestId, 'plan');
      let result = await runPlanStream(this.deps.router, this.makeAgentOpts(s, m.requestId, 'plan', s.reasoningEffort ?? 'medium', cbk5, s.model), {});
      if (!this.isActiveRun(s, m.requestId)) return;
      // Same deterministic relevance check as the initial propose path (handleSend) — a
      // resumed run can drift into a generic answer just as easily as the first one.
      const subjectTerms = extractSubjectTerms(ctx.prompt);
      if (!looksLikeGroundedAnswer(result.text, subjectTerms)) {
        s.history.push({ role: 'user', content: offTopicCorrection(subjectTerms) });
        result = await runPlanStream(this.deps.router, this.makeAgentOpts(s, m.requestId, 'plan', s.reasoningEffort ?? 'medium', cbk5, s.model), {});
        if (!this.isActiveRun(s, m.requestId)) return;
      }
      const clar = resolveClarifying(result.text, result.askQuestions);
      if (clar.questions && clar.questions.length) {
        // The model re-asked despite being told not to (the "do not ask any further
        // questions" instruction pushed above) — show the follow-up instead of silently
        // losing it: parseClarifying strips it out of clar.text either way, so ignoring
        // clar.questions here would otherwise fall through to the generic "didn't return a
        // plan" error with the actual question content discarded.
        s.pendingPlanUser = ctx.userContent;
        s.pendingClarify = { requestId: m.requestId, userContent: ctx.userContent, prompt: ctx.prompt, questions: clar.questions, mode: 'plan' };
        this.postCard(s, { type: 'clarifyingQuestions', sessionId: s.id, requestId: m.requestId, questions: clar.questions });
      } else {
        // Same prose→plan fallback as the initial propose path: weak models that replied to the
        // clarifying answers in prose (not a clean list) still get a plan card when the LLM
        // structurer confirms the prose is an actionable plan.
        let planStepsText: string | null = looksLikeActionablePlan(clar.text) ? clar.text : null;
        if (!planStepsText && clar.text.trim()) {
          const extracted = await extractPlanFromProse(this.deps.router, clar.text);
          if (!this.isActiveRun(s, m.requestId)) return;
          if (extracted.isPlan && extracted.steps.length) planStepsText = formatStructuredSteps(extracted.steps);
        }
        if (planStepsText) {
          this.postCard(s, { type: 'planProposed', sessionId: s.id, requestId: m.requestId, steps: planStepsText });
          this.preparePlanFile(s, ctx.prompt);
          if (planStepsText === clar.text) this.upgradePlanSteps(s, m.requestId, clar.text);
          // Not committed: a planProposed card isn't committed to history until approval, same as
          // the original looksLikeActionablePlan branch.
        } else if (clar.text.trim()) {
        // Not actionable steps — the model needs more from the user (a clarification or
        // discussion reply) rather than a plan to run. Show it as a normal answer instead of
        // squashing the whole prose into a broken one-item "plan" card (duplicating it visually
        // alongside the plain text render above).
        const after = this.deps.usage.get();
        const usage = {
          promptTokens: after.promptTokens - before.promptTokens,
          completionTokens: after.completionTokens - before.completionTokens,
          reasoningTokens: after.reasoningTokens - before.reasoningTokens,
          totalTokens: after.totalTokens - before.totalTokens,
        };
        this.persistAgentTurn(s, result);
        this.pushAssistantTurn(s, m.requestId, result, sentAt, usage);
        this.post({ type: 'assistantMessage', sessionId: s.id, requestId: m.requestId, text: clar.text, reasoning: result.reasoning, usage, platform: turnPlatformLabel(s.model, result, this.deps), model: result.model, paused: result.paused });
        committed = true;
      } else {
        // The resumed run returned nothing usable (e.g. all of result.text was consumed by a
        // stray ???QUESTIONS??? block parseClarifying stripped) — posting an empty planProposed
        // card renders as a broken "0 steps" card with nothing to run. Surface it as an error
        // instead so the user knows to retry rather than staring at an empty plan.
        this.post({ type: 'error', sessionId: s.id, requestId: m.requestId, message: "The agent didn't return a plan for those answers — try again or rephrase your request." });
      }
      }

    } catch (e) {
      if (!this.isActiveRun(s, m.requestId)) return;
      this.post({ type: 'error', sessionId: s.id, requestId: m.requestId, message: e instanceof Error ? e.message : String(e) });
      void this.maybeRecommendModels(e);
    } finally {
      release();
      if (this.isActiveRun(s, m.requestId)) {

        if (!committed) s.history.length = base;
        s.activeRequestId = undefined;
        this.clearInProgressTurn(s, m.requestId);
        this.settlePendingAskUser(s);
        await this.finishCheckpoint(s, m.requestId);
        this.persist(s.id);
        this.post({ type: 'busy', sessionId: s.id, busy: false });
        this.setStatus(s.id, 'finished');
        await this.maybeAutoCompact(s);
        void this.maybeGenerateTitle(s);
      }
    }
  }

  /** Reads `tiermux.mcpServers`, upgrading any legacy (pre-native-schema) entries on the fly. */
  private readMcpServersConfig(): Record<string, McpServerConfig> {
    const raw = vscode.workspace.getConfiguration('tiermux').get<Record<string, unknown>>('mcpServers', {}) ?? {};
    const out: Record<string, McpServerConfig> = {};
    for (const [name, entry] of Object.entries(raw)) {
      const normalized = normalizeMcpServerConfig(entry);
      if (normalized) out[name] = normalized;
    }
    return out;
  }

  private async sendConfig(): Promise<void> {
    if (!this.view) return;
    const snap = await this.deps.secrets.snapshot();
    const endpoints = this.deps.settings.getEndpoints();
    const catalog = this.deps.catalog.all();
    const modelKeys = new Set(await this.deps.secrets.modelKeySnapshot(catalog));
    const platforms: KeyStatusInfo[] = snap.map((s) => {
      const info = getPlatformInfo(s.platform);
      const hasModelKey = catalog.some((m) => m.platform === s.platform && modelKeys.has(`${m.platform}::${m.modelId}`));
      return {
        platform: s.platform,
        name: info?.name ?? s.platform,
        configured: s.configured || hasModelKey,
        keyless: s.keyless,
        status: s.status,
        keyUrl: info?.keyUrl,
        defaultBaseUrl: info?.defaultBaseUrl ?? '',
        endpoint: endpoints[s.platform],
        keyCount: s.keyCount,
        keyHints: s.keyHints,
        cloudflareAccountId: s.cloudflareAccountId,
      };
    });
    if (this.deps.mcp.hasServers()) { try { await this.deps.mcp.ensureStarted(); } catch { /* MCP optional */ } }
    const config: ConfigPayload = {
      catalog: this.deps.catalog.all(),
      fallback: this.deps.settings.getFallback(),
      platforms,
      mcp: this.deps.mcp.servers(),
      mcpServers: this.readMcpServersConfig(),
      mcpRegistry: await this.registry(),
      deprecated: this.deps.secrets.deprecatedKeys(),
      slow: this.deps.slowModels.slowKeys(),
      modelKeys: await this.deps.secrets.modelKeySnapshot(this.deps.catalog.all()),
      utilityModel: vscode.workspace.getConfiguration('tiermux').get<string>('utilityModel', 'auto'),
      settingsMeta: SETTINGS_META,
      settings: Object.fromEntries(
        SETTINGS_META.map((meta) => [meta.key, vscode.workspace.getConfiguration('tiermux').get(meta.key, defaultForSetting(meta))]),
      ),
      autoApprove: this.autoApprove,
      skills: Array.from(this.skills().values(), (sk) => ({ name: sk.name, detail: sk.description })),
      disabledProviders: this.deps.settings.getDisabledProviders(),
      remoteDisabledProviders: this.deps.catalog.getRemoteDisabledPlatforms(),
      customEndpoints: (await Promise.all(this.deps.settings.getCustomEndpoints().map(async (ep) => ({
        id: ep.id,
        name: ep.name,
        baseUrl: ep.baseUrl,
        keyless: false,
        configured: !!(await this.deps.secrets.getCustomKey(ep.id)),
        modelCount: ep.models.length,
      })))),
    };
    this.post({ type: 'config', config, usageTotals: this.currentUsageTotals(this.current()) });
  }

  /** Estimated current conversation size vs the active model's context window. */
  private computeContext(s: Session): { tokens: number; window: number } {
    const tokens = estimateMessagesTokens(s.history);
    let window = s.lastWindow;
    if (!window) {
      const top = this.deps.settings.enabledByPriority()[0];
      const m = top ? this.deps.catalog.find(top.platform, top.modelId) : undefined;
      window = m?.contextWindow ?? 32768;
    }
    return { tokens, window };
  }

  /** Session-scoped totals + persistent lifetime totals + context. Single source
   *  of truth for the footer's `usageTotals` post so the session and lifetime
   *  numbers can never drift between call sites. */
  private currentUsageTotals(s: Session) {
    const sessionTotals = this.deps.usage.get();
    const lifetime = this.deps.usageStore.getLifetime(this.deps.catalog);
    const retrieval = getRetrievalSnapshot();
    return {
      ...sessionTotals,
      context: this.computeContext(s),
      lifetime: {
        totalTokens: lifetime.totalTokens,
        totalRequests: lifetime.totalRequests,
        estimatedSavingsUsd: lifetime.estimatedSavingsUsd,
        firstRecordedAt: lifetime.firstRecordedAt,
        totalReasoningTokens: lifetime.totalReasoningTokens,
      },
      retrieval: retrieval.totalRequests >= 3 ? retrieval : undefined,
    };
  }

  private rememberWindow(s: Session, platform?: string, model?: string): void {
    if (!platform || !model) return;
    const w = this.deps.catalog.find(platform, model)?.contextWindow;
    if (w && w > 0) s.lastWindow = w;
  }

  /** Auto-summarize when the conversation passes the configured fraction of the window. */
  private async maybeAutoCompact(s: Session): Promise<void> {
    const threshold = vscode.workspace.getConfiguration('tiermux.agent').get<number>('autoCompactThreshold', 0.8);
    if (!threshold || threshold <= 0 || s.history.length < 6) return;
    const { tokens, window } = this.computeContext(s);
    if (window && tokens > window * threshold) await this.handleCompact(s);
  }

  /** Best-effort: ask a free LLM for a short title from the user's first message. */
  private async maybeGenerateTitle(s: Session): Promise<void> {
    if (s.titleGenerated || s.userRenamedTitle) return;
    // Once a REAL title exists it sticks for the session's lifetime — the only replaceable
    // state is the untitled placeholders (empty, or the trivial-first-message stand-in).
    // This is what keeps "title changes every message" from ever happening: generation is
    // a one-shot upgrade path, never an ongoing rewrite.
    const existing = (s.title ?? '').trim();
    if (existing && existing !== 'Starting Conversation') { s.titleGenerated = true; return; }
    const users = s.transcript.filter((t) => t.role === 'user');
    if (!users.length) return;

    const firstReal = users.find((u) => classifyTask(u.text ?? '') !== 'trivial');
    if (!firstReal) {
      if (s.title !== 'Starting Conversation') { s.title = 'Starting Conversation'; this.persist(s.id); this.updateViewTitle(); this.postSessionList(); }
      return; // leave titleGenerated false → re-evaluate when a real message arrives
    }

    // Show a cheap placeholder immediately (so the tab is never blank/odd), then upgrade
    // it to a real LLM-generated title below. Matches the "meaningful short title" behavior
    // of Cursor / Claude Code instead of leaving the raw message text in the tab.
    const placeholder = deriveTitleFrom(firstReal.text ?? '');
    if (placeholder && s.title !== placeholder) {
      s.title = placeholder;
      this.persist(s.id);
      this.updateViewTitle();
      this.postSessionList();
    }

    // OC's own native title (e.g. "New session - <timestamp>") is ignored entirely — always
    // generate our own meaningful LLM title so the tab never shows OC's raw placeholder.
    await this.generateTitleViaLlm(s, firstReal.text ?? '');
  }

  /** Ask a free LLM for a short, meaningful title from the user's message and write it
   *  to the session (falling back to the derived placeholder on any failure). */
  private async generateTitleViaLlm(s: Session, messageText: string): Promise<void> {
    if (s.titleGenerated || s.userRenamedTitle) return;
    s.titleGenerated = true; // guard before the call to avoid duplicate runs

    const snippet = messageText.slice(0, 800);
    const router = this.deps.router;
    const primary = await router.pickUtilityModel();
    // Same free-model fallback chain as generateCommitMessage: a single free model
    // routinely 429s or times out, so one shot at `primary` silently degrades every
    // failed session to the raw-derived placeholder title instead of a real one.
    const fallbacks = [
      'google::gemini-2.5-flash',
      'groq::llama-3.3-70b-versatile',
      'openrouter::deepseek/deepseek-chat-v3.1:free',
    ];
    const candidates = [primary, ...fallbacks].filter((m): m is string => !!m);
    const seen = new Set<string>();
    const attempts: string[] = [];
    for (const m of candidates) {
      if (seen.has(m)) continue;
      seen.add(m);
      if (!(await router.isReady(m))) continue;
      attempts.push(m);
      if (attempts.length >= 3) break;
    }

    let title = '';
    for (const model of attempts) {
      try {
        const result = await router.route(
          [
            { role: 'system', content: TITLE_SYSTEM },
            { role: 'user', content: `User's message: ${snippet}` },
          ],
          { temperature: 0.3, max_tokens: 48, model, taskKind: 'trivial', reasoningEffort: 'off' },
        );
        const raw = contentToString(result.response.choices[0]?.message.content);
        const cleaned = sanitizeTitle(raw);
        if (cleaned && !/^(starting conversation|new chat|untitled|chat)$/i.test(cleaned)) {
          title = cleaned;
          break;
        }
      } catch { /* try the next model */ }
    }

    s.title = title || deriveTitleFrom(messageText);
    this.persist(s.id);
    this.updateViewTitle();
    this.postSessionList();
  }

   private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', f));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data: blob:`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      // `${webview.cspSource}` is needed alongside the nonce for pdf.js: it is an ES module,
      // and a module's own `import` is matched against the source list, NOT the nonce (a nonce
      // only authorizes the <script> element itself). Without it the lazy pdf.js load is
      // blocked and scanned-PDF rendering silently never starts.
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
      // pdf.js runs its parser in a Web Worker loaded from our own vendor directory.
      `worker-src ${webview.cspSource} blob:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${uri('vendor/highlight.css')}" rel="stylesheet" nonce="${nonce}" />
  <link href="${uri('vendor/diff2html.min.css')}" rel="stylesheet" nonce="${nonce}" />
  <link href="${uri('styles/tokens.css')}" rel="stylesheet" nonce="${nonce}" />
  <link href="${uri('styles/components/plan.css')}" rel="stylesheet" nonce="${nonce}" />
  <link href="${uri('styles/components/tool-card.css')}" rel="stylesheet" nonce="${nonce}" />
  <link href="${uri('styles/components/reasoning.css')}" rel="stylesheet" nonce="${nonce}" />
  <link href="${uri('styles/components/approval-card.css')}" rel="stylesheet" nonce="${nonce}" />
  <link href="${uri('styles/components/result-card.css')}" rel="stylesheet" nonce="${nonce}" />
  <link href="${uri('styles/components/terminal.css')}" rel="stylesheet" nonce="${nonce}" />
  <link href="${uri('styles/components/composer.css')}" rel="stylesheet" nonce="${nonce}" />
  <link href="${uri('main.css')}" rel="stylesheet" nonce="${nonce}" />
  <title>${PRODUCT_NAME}</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">window.__PRODUCT_NAME__ = ${JSON.stringify(PRODUCT_NAME)}; window.__LOGO_URI__ = ${JSON.stringify(uri('logo-mono.png').toString())};
  // Mermaid is ~3.5 MB, so it is not loaded up front like the vendors below. markdown.ts
  // injects it on demand the first time a mermaid fence renders, using __NONCE__ to
  // satisfy the script-src/style-src CSP (which is nonce-only, so no 'unsafe-inline').
  window.__NONCE__ = ${JSON.stringify(nonce)}; window.__MERMAID_URI__ = ${JSON.stringify(uri('vendor/mermaid.min.js').toString())};
  // pdf.js, lazy-injected by pdfPages.ts the first time a scanned PDF is attached — see the
  // vendor copy in esbuild.js for why this has to render here in the webview, not host-side.
  window.__PDFJS_URI__ = ${JSON.stringify(uri('vendor/pdf.min.mjs').toString())}; window.__PDFJS_WORKER_URI__ = ${JSON.stringify(uri('vendor/pdf.worker.min.mjs').toString())};</script>
  <script nonce="${nonce}" src="${uri('vendor/marked.min.js')}"></script>
  <script nonce="${nonce}" src="${uri('vendor/highlight.min.js')}"></script>
  <script nonce="${nonce}" src="${uri('vendor/diff2html.min.js')}"></script>
  <script nonce="${nonce}" src="${uri('main.js')}"></script>
</body>
</html>`;
  }
}
