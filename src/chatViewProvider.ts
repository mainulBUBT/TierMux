import * as vscode from 'vscode';
import * as fs from 'fs';
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

import { PRODUCT_NAME } from './shared/branding';
import { SETTINGS_META, defaultForSetting } from './settingsMeta';
import { AllModelsFailedError } from './router/errors';
import { routeOnceOrUndefined, utilityModelPreference } from './agent/core/routeOnce';
import { peekTopModel } from './router/picker';
import type { McpManager } from './mcp/mcpManager';
import { CheckpointManager, type SerializedCheckpoint } from './edits/checkpoints';
import { isDangerous } from './edits/commandClassify';
import { statusLines } from './edits/gitSnapshot';
import type { ModelStatsStore, Vote } from './config/modelStats';
import { loadMcpRegistry, searchRemoteMcp } from './mcp/registry';
import type { McpRegistryItem, McpServerConfig } from './messages';
import type { AnnouncementItem, Attachment, ConfigPayload, InMessage, KeyStatusInfo, OutMessage, PlanDataPayload, SelectionRationale, SessionStatus, TranscriptMessage, TranscriptStep } from './messages';
import { renderLegacyMarkdown } from './shared/workReport';
import { fetchAnnouncements as fetchWorkerAnnouncements, markAnnouncementsSeen, unseenAnnouncementIds } from './catalog/announcements';
import { normalizeMcpServerConfig } from './mcp/mcpClient';
import { getNonce } from './util/nonce';
import { diagLog } from './util/diag';
import { getPlatformInfo } from './providers';
import { parseSlash, resolveMentions, searchMentions } from './context/mentions';
import { activeEditorRelPath, buildActiveEditorContext, buildDiagnosticsContext } from './context/activeContext';
import { contentToString } from './agent/content';
import { ATTACHMENT_FILE_FILTERS, IMAGE_BYTE_LIMIT, buildAttachmentFromUri, isSupportedAttachmentPath, kindForPath as kindFromName, lastPdfFailureReason, mimeForPath as mimeForName } from './util/extractAttachments';
import { estimateMessagesTokens } from './agent/budget';
import { TITLE_SYSTEM } from './agent/prompts';
import { condenseHistory, shouldCondense, generateHandoff } from './agent/condense';
import { resolveExecutionProfile } from './agent/executionProfile';
import { structurePlanSteps, formatStructuredSteps, formatPlanForCard, isCleanNumberedList, renderPlanMarkdown } from './agent/planStructurer';
import { deriveTitleFrom, looksLikeActionablePlan, sanitizeTitle, planStepsToTodos } from './session/titles';

import { loadSkills } from './context/skills';

interface ChatDeps {
  secrets: SecretStore;
  settings: SettingsStore;
  catalog: Catalog;
  usage: UsageTracker;
  usageStore: UsageStore;
  mcp: McpManager;
  modelStats: ModelStatsStore;
  workspaceState: vscode.Memento;
  /** Global (per-user) state — announcement seen/notified tracking lives here, alongside the catalog cache. */
  globalState: vscode.Memento;
  generateCommitMessage: () => Promise<void>;
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
const WRITE_TOOL_NAMES = new Set(['writeFile', 'createFile' /* legacy names */, 'editFile', 'deleteFile', 'runCommand']);

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

/** Why a turn stopped when it stopped ITSELF instead of finishing — the step cap, or the
 *  no-progress guard (see `AgentResult.stopReason`). Both leave real work on the table, and
 *  until 2026-09-05 both ended the turn looking exactly like completion. The host knows the
 *  reason from the wire, so this text is deterministic — the model is never asked to explain
 *  its own stop. The Continue button is live in both cases (`resumable` keys on `paused`). */
function stopReasonNote(stopReason: NonNullable<AgentResult['stopReason']>, remaining: TodoItem[]): string {
  const list = remaining.length
    ? `\n\nRemaining:\n${remaining.map((t) => `- ${t.content}`).join('\n')}`
    : '';
  if (stopReason === 'budget') {
    return '\n\n---\n**Stopped at the step limit — this task is not finished.** Continue picks up from here '
      + 'with the full transcript, so nothing is repeated. For long unattended tasks, raise '
      + '`tiermux.agent.maxStepsPerTurn`.' + list;
  }
  if (stopReason === 'stuck') {
    return '\n\n---\n**Stopped: no progress — the same tool call failed three times in a row.** '
      + 'Continue to let it try again, or say what to do differently.' + list;
  }
  return '';
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

/** Tag a user turn with the mode that governs it, only when the mode CHANGED. The transcript is
 *  one shared history: after Agent → Ask the model still sees its own editFile calls a few
 *  messages back and tries another. Only on change, so free-tier context isn't spent saying
 *  nothing new. */
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
  /** Ephemeral interactive cards (approvals / plan / askUser) awaiting a click, cached so
   *  they re-render when the user switches back to a session whose run is blocked on them. */
  cards: OutMessage[];
  voteCtx: Map<string, { taskKind: string; platform: string; model: string; last: Vote }>;
  pendingPlanUser?: ChatContent;
  /** URI of the plan MD file saved at proposal time — updated if the user edits steps before approving. */
  pendingPlanFile?: { uri: vscode.Uri; title: string; request?: string };
  /** In-flight `askUser` tool calls, keyed by OpenAI tool_call_id, awaiting a webview answer. */
  pendingAskUser: Map<string, (answer: string) => void>;
  /** True while an approved plan is being executed in Agent mode — drives the "Following the approved plan" header. */
  executingPlan?: boolean;
  /** Plan execution state — present while an approved plan is running or paused; persisted
   *  with the session so a reload can resume. */
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
  /** Wall-clock start time per toolCallId, recorded when a call first reports 'running' —
   *  diffed against Date.now() when it settles to 'done'/'error' so the toolStatus message can
   *  carry a real durationMs (see docs/UI_POLISH_TOOL_REASONING_2026-09-02.md item 3: the
   *  status line shows `· {duration}` per step, not just the turn-level "Worked for Ns").
   *  Entries are deleted on settlement — never grows past the calls currently in flight. */
  toolStartTimes: Map<string, number>;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** How many `@mentions` resolved into context on the most recent send — carried through to
   *  AgentOpts.mentionCount so routing (classifyTaskCore) can tell "content already supplied"
   *  turns apart from ambiguous ones without re-parsing the message text. Persists across a
   *  retry of the same turn (only overwritten by the next fresh send). */
  lastMentionCount?: number;
  /** Incremental snapshot of the CURRENTLY RUNNING turn's tool transcript, updated after every
   *  tool completion (see agentCallbacks' onTool) and persisted immediately so a crash mid-turn
   *  (extension host restart) doesn't lose in-progress work. Cleared by clearInProgressTurn()
   *  once the run finishes normally — persistAgentTurn() has already committed the authoritative
   *  transcript into `history` by then, so this is purely a crash-recovery fallback. */
  inProgressTurn?: { requestId: string; workMessages: ChatMessage[] };
}

interface StoredSession {
  id: string;
  /** Undefined until the one-shot title pick commits (see maybeGenerateTitle). Persisting the
   *  UNPICKED state matters: baking a derived stand-in in here used to make hydrateSession
   *  infer "a title was already generated", so a session persisted mid-generation never got
   *  its real title after a reload. */
  title?: string;
  /** Persisted explicitly rather than inferred from `title` — the inference could not tell a
   *  real generated title apart from a derived stand-in. */
  titleGenerated?: boolean;
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
  endpointType?: CustomEndpoint['type'],
): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { Accept: 'application/json', ...(extraHeaders ?? {}) };
  // Anthropic's Messages API authenticates with x-api-key + a pinned version header, not a
  // Bearer token — using Bearer here gets a 401 even with a valid key.
  if (endpointType === 'anthropic-messages') {
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

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
  // Display name ("OpenRouter", "Kilo Gateway"), not the raw platform id — the "Why this
  // model?" popover and failover notices are user-facing, and "kilo/nvidia/…" read like a
  // different provider than the one the picker names (2026-08-31).
  return getPlatformInfo(entry.platform as import('./shared/types').Platform)?.name ?? entry.platform;
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

/** Bare modelId for a turn's footer: the model that ACTUALLY served wins; the pin (prefix
 *  stripped) is only the fallback for turns with no run metadata. */
function turnModelLabel(pinnedModel: string | undefined, reportedModel: string | undefined): string | undefined {
  if (reportedModel) return reportedModel;
  return (pinnedModel && pinnedModel !== 'auto')
    ? pinnedModel.includes('::') ? pinnedModel.split('::').slice(1).join('::') : pinnedModel
    : undefined;
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
  /** Workspace-level Auto-approve toggle (composer): when true the permission policy runs
   *  commands/edits without a prompt (dangerous commands still ask). Defaults to true. */
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
      toolStartTimes: new Map(),
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
      // Explicit flag first; the `title`-based inference is the back-compat path for sessions
      // stored before it was persisted. 'Starting Conversation' was the old small-talk stand-in
      // and is still not treated as a generated title.
      titleGenerated: s.titleGenerated
        ?? (!!(s.title && s.title.trim() !== 'Starting Conversation') || !!s.userRenamedTitle),
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
      toolStartTimes: new Map(),
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

  /** What the UI shows while a session is still untitled. Deliberately NOT derived from the
   *  first message: a derived stand-in looks like a real title, so replacing it later reads as
   *  the app changing its mind (see maybeGenerateTitle). The old `deriveTitle(session)` helper
   *  that produced that stand-in is gone with it. */
  private static readonly UNTITLED_SESSION = 'New chat';

  /** Push the current session's title into the webview header; the chrome shows just the brand. */
  private updateViewTitle(): void {
    if (this.view) this.view.title = PRODUCT_NAME;

    const s = this.sessions.get(this.viewedSessionId);
    if (s) this.post({ type: 'sessionTitle', sessionId: s.id, title: s.title?.trim() || ChatViewProvider.UNTITLED_SESSION });
  }

  /** Save one session's conversation into the session list (most-recent first). */
  private persist(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const others = this.loadSessions().filter((x) => x.id !== sessionId);
    if (s.transcript.length) {
      others.unshift({
        id: s.id, title: s.title, titleGenerated: s.titleGenerated, ts: Date.now(), transcript: s.transcript,
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
        title: s.title?.trim() || ChatViewProvider.UNTITLED_SESSION,
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
    const unseenIds = unseenAnnouncementIds(this.deps.globalState, items);
    this.post({ type: 'announcements', items, lastUpdated, unseen: unseenIds.length, unseenIds });
  }

  private post(msg: OutMessage): void {
    if (!this.view || !this.ready) { this.outQueue.push(msg); return; }
    void this.view.webview.postMessage(msg);
  }

  /** Post an ephemeral interactive card (approval/plan/askUser) AND cache it on the session,
   *  so it re-renders if the user switches away and back while it's still pending. */
  private postCard(s: Session, msg: OutMessage): void {
    s.cards.push(msg);
    if (this.viewedSessionId === s.id) this.post(msg);
  }

  /** Drop cached cards matching a predicate (e.g. once an approval is resolved). */
  private removeCards(s: Session, pred: (m: OutMessage) => boolean): void {
    s.cards = s.cards.filter((m) => !pred(m));
  }

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

  /** Ask the user to approve/deny a tool call the permission policy paused, inline in the
   *  run's own session. Three-way response: once / always / reject. */
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

  /** Resolve every outstanding approval in a session (cancel / stop) so the agent never hangs,
   *  and pull the cards off the webview so a stale click is visibly a no-op. */
  private settlePendingApprovals(s: Session, approved: boolean): void {
    const approvalIds = new Set(s.pendingApprovals.keys());
    for (const resolve of s.pendingApprovals.values()) resolve(approved);
    s.pendingApprovals.clear();

    const permissionIds = new Set(s.pendingPermissions.keys());
    for (const resolve of s.pendingPermissions.values()) resolve('reject');
    s.pendingPermissions.clear();
    if (approvalIds.size) {
      this.removeCards(s, (c) => c.type === 'editApproval' && approvalIds.has(c.id));
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

  /** A session with nothing in it yet — no messages, no in-flight run, nothing awaiting a click.
   *  activeRequestId is set at the very start of a send (before the run queue), so a
   *  queued/running session never reads as empty. */
  private static isEmptySession(s: Session): boolean {
    return s.transcript.length === 0
      && s.history.length === 0
      && !s.activeRequestId
      && !s.inProgressTurn
      && s.pendingApprovals.size === 0
      && s.pendingPermissions.size === 0
      && s.pendingAskUser.size === 0;
  }

  newChat(): void {
    // An untouched session IS the new chat: re-viewing it instead of creating another one
    // stops the + / New chat path from stacking an empty session per click.
    const cur = this.current();
    if (ChatViewProvider.isEmptySession(cur)) {
      this.post({ type: 'switchSession', sessionId: cur.id, messages: [] });
      this.post({ type: 'busy', sessionId: cur.id, busy: false });
      void this.sendConfig();
      return;
    }

    const s = this.createSession();
    this.viewedSessionId = s.id;
    void this.deps.workspaceState.update(CURRENT_KEY, s.id);
    // A real new session orphans every OTHER still-empty one — drop them so the in-memory
    // list never accumulates one empty chat per historic + press (empty sessions were never
    // persisted, so this loses nothing).
    for (const [id, other] of this.sessions) {
      if (id !== s.id && ChatViewProvider.isEmptySession(other)) {
        this.sessions.delete(id);
        this.statusOf.delete(id);
      }
    }
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
    if (!t || t === s.title) return;
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

  /** Re-send the viewed session's live UI state (a running turn's start/step/todos, pending
   *  cards). Needed on both a tab switch and a webview-only reload (Cmd+R). */
  private postLiveRunState(s: Session): void {
    if (s.activeRequestId) {
      const rid = s.activeRequestId;
      this.post({ type: 'assistantStart', sessionId: s.id, requestId: rid, platform: s.livePlatform ?? '', model: s.liveModel ?? '' });
      if (s.lastStepLabel) this.post({ type: 'agentStep', sessionId: s.id, requestId: rid, phase: 'thinking', label: s.lastStepLabel });
      if (s.lastTodos && s.lastTodos.length) this.post({ type: 'todos', sessionId: s.id, requestId: rid, todos: s.lastTodos, followingPlan: !!s.executingPlan });
    }
    for (const card of s.cards) this.post(card);
  }

  /** Deleting a chat also discards code it changed that was never committed (a real commit
   *  clears every session's checkpoints, so this is a no-op then). Confirms first; a decline
   *  re-posts the session list because the webview already removed the row. */
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
      case 'markAnnouncementsSeen': {
        // `ids` = the one tip card the user just expanded; no ids = "Mark all read".
        const ids = Array.isArray(m.ids) ? new Set(m.ids) : null;
        const target = ids ? this.lastAnnouncements.filter((a) => ids.has(a.id)) : this.lastAnnouncements;
        await markAnnouncementsSeen(this.deps.globalState, target);
        this.postAnnouncements(this.lastAnnouncements, this.lastAnnouncementsUpdated);
        break;
      }
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
      case 'editApprovalResponse': {
        const s = this.sessions.get(m.sessionId ?? this.viewedSessionId);
        const resolve = s?.pendingApprovals.get(m.id);
        if (s && resolve) {
          s.pendingApprovals.delete(m.id);
          this.removeCards(s, (c) => c.type === 'editApproval' && c.id === m.id);
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
          type: m.endpointType,
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
        if (m.endpointType !== undefined) updated.type = m.endpointType;
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

        endpoint.models.push({
          modelId,
          displayName: m.displayName,
          supportsTools: m.supportsTools,
          supportsVision: m.supportsVision,
          supportsReasoning: m.supportsReasoning,
          tags: m.tags && m.tags.length ? m.tags : undefined,
        });
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
      case 'setCustomModelCaps': {
        const endpoint = this.deps.settings.getCustomEndpoint(m.endpointId);
        if (!endpoint) { void vscode.window.showWarningMessage('Endpoint not found.'); break; }
        const model = endpoint.models.find((em) => em.modelId === m.modelId);
        if (!model) { void vscode.window.showWarningMessage(`Model "${m.modelId}" not found.`); break; }
        if (m.supportsTools !== undefined) model.supportsTools = m.supportsTools;
        if (m.supportsVision !== undefined) model.supportsVision = m.supportsVision;
        if (m.supportsReasoning !== undefined) model.supportsReasoning = m.supportsReasoning;
        await this.deps.settings.upsertCustomEndpoint(endpoint);
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
          const models = await fetchOpenAICompatModels(endpoint.baseUrl, key, endpoint.extraHeaders, endpoint.type);
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

  /** A file the webview captured from paste/drop (bytes, no path). Images: the data URL
   *  directly; PDF/DOCX: saved under .tiermux/attach/ and run through the same extractor
   *  the workspace picker uses. */
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
  /** Default working-context ceiling, independent of the model's window: 80% of a 200k window
   *  let a trivial turn ship 65k input tokens at 20-30s TTFT (2026-09-04). Past the cap, older
   *  turns are summarized. `tiermux.agent.autoCondenseTokenCap`; 0 = window-only. */
  private static readonly AUTO_CONDENSE_TOKEN_CAP_DEFAULT = 32_000;

  /** THE automatic compaction path: when history exceeds the window ratio
   *  (`autoCompactThreshold`) OR the working-context cap, summarize older turns in place — the
   *  /compact mechanism, triggered by pressure. Called before a send and after a turn settles. */
  private async maybeAutoCondense(s: Session): Promise<void> {
    try {
      const cfg = vscode.workspace.getConfiguration('tiermux.agent');
      if (!cfg.get<boolean>('autoCondense', true)) return;
      // FAILURE cooldown, not an attempt cooldown. A SUCCESSFUL compaction needs no timer: it
      // shrinks history below the threshold, so the check below is self-limiting until the
      // session regrows. Timing every attempt meant a heavy turn that blew past the cap had to
      // wait out ten minutes before the cap could be enforced again — the cap's whole promise.
      const last = this.autoCondenseAt.get(s.id) ?? 0;
      if (Date.now() - last < ChatViewProvider.AUTO_CONDENSE_COOLDOWN_MS) return;
      if (!shouldCondense(s.history)) return;
      const profile = resolveExecutionProfile(await peekTopModel('chat'));
      const tokens = estimateMessagesTokens(s.history);
      const cap = cfg.get<number>('autoCondenseTokenCap', ChatViewProvider.AUTO_CONDENSE_TOKEN_CAP_DEFAULT);
      const ratio = cfg.get<number>('autoCompactThreshold', 0.8);
      const byWindow = profile.contextWindow * (ratio > 0 ? ratio : 0.8);
      const threshold = cap > 0 ? Math.min(byWindow, cap) : byWindow;
      if (tokens <= threshold) return;
      const r = await condenseHistory(
        s.history,
        s.livePlatform && s.liveModel ? `${s.livePlatform}/${s.liveModel}` : undefined,
      );
      if (!r) {
        // Two models in a row returned nothing (condense.ts already retried). THIS is what the
        // cooldown is for — every attempt is a real call against a rate-limited free tier.
        this.autoCondenseAt.set(s.id, Date.now());
        return;
      }
      const after = estimateMessagesTokens(r.messages);
      s.history = r.messages;
      this.persist(s.id);
      // Name whichever bound ACTUALLY fired. The notice used to always blame the model's
      // window, so a 200k-window model produced "~33k → ~8k (was approaching the model's ~200k
      // window)" — 33k is nowhere near 200k, and the real trigger was the working-context cap.
      // A user reading that has no way to find the setting that caused it.
      const byCap = cap > 0 && cap < byWindow;
      const why = byCap
        ? `(passed the ~${Math.round(cap / 1000)}k working-context cap — \`tiermux.agent.autoCondenseTokenCap\`)`
        : `(was approaching the model's ~${Math.round(profile.contextWindow / 1000)}k window)`;
      this.post({
        type: 'notice', sessionId: s.id, icon: 'compress',
        text: `Context auto-compacted — ~${Math.round(tokens / 1000)}k → ~${Math.round(after / 1000)}k tokens `
          + `${why}. Earlier turns summarized; recent turns kept verbatim.`,
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
      const note = await generateHandoff(s.history);
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

    // Auto-enrich the MODEL-facing context (not the displayed transcript) with the active
    // editor's selection/ambient slice and diagnostics. Gated by `context.includeOpenEditors`;
    // skipped when the file is already @-mentioned, and on greetings — "Hello" with a SQL dump
    // open shipped 8KB of it and the model answered about the SQL.
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
    diagLog('send.token', `requestId=${m.requestId} cancelledAtCreate=${s.cancel.token.isCancellationRequested}`);
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

    // §14 turnStart: the assistant bubble appears at ENTER (0ms skeleton — "Thinking…" +
    // elapsed timer), not after the first model call. ensureTarget is get-or-create, so the
    // later onModel `assistantStart` just updates the platform/model footer label.
    this.post({ type: 'assistantStart', sessionId: s.id, requestId: m.requestId, platform: '', model: '' });

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
      let result = await runner(this.makeAgentOpts(s, m.requestId, sdkMode, m.reasoningEffort ?? 'medium', cbk, m.model), {});
      diagLog('send.gate', `requestId=${m.requestId} · runner returned paused=${result.paused} textLen=${result.text?.length ?? 0}`);

      if (!this.isActiveRun(s, m.requestId)) return;

      let replyText = result.text;
      if (m.mode === 'plan') {
        // The model declares a plan by calling `exitPlanMode` (result.plan); the regex gate
        // below is only a fallback for models too weak to call the tool. Outcome 'no-change' is
        // a FINDING, not a plan — rendering it as a card would ask the user to approve executing
        // nothing (2026-09-01) — so it falls through to the normal answer bubble.
        const noChange = result.plan?.outcome === 'no-change' ? result.plan : undefined;
        if (noChange && !replyText.trim() && noChange.finding?.trim()) replyText = noChange.finding.trim();
        const planStepsText: string | null = noChange
          ? null
          : result.plan
            ? formatPlanForCard(result.plan)
            : looksLikeActionablePlan(replyText) ? replyText : null;
        if (planStepsText) {
          s.history.length -= 1; // not committed yet — re-added on approval
          s.pendingPlanUser = userContent;
          this.postCard(s, { type: 'planProposed', sessionId: s.id, requestId: m.requestId, steps: planStepsText });
          this.preparePlanFile(s, result.plan?.title || prompt, prompt);
          // Fire-and-forget re-refine ONLY on the fallback path: a tool-declared plan is already
          // one clean step per line, so re-asking a model to restructure it is pure waste.
          if (!result.plan) this.upgradePlanSteps(s, m.requestId, replyText);
          return;
        }
      }


      // The turn genuinely failed (router/provider error with no salvageable text or tool
      // calls) — onError already posted a thin error notice from inside runTurn, but that's
      // easy to miss in a chat UI. Show a real reply bubble with the failure reason instead —
      // honest text, no fake usage/footer (there was no completion to report stats for) — and
      // don't persist it into the model-context history (nothing happened for the model to
      // remember) or pop the trailing user turn so a retry isn't confused by a dangling one.
      if (result.failed) {
        if (s.history[s.history.length - 1]?.role === 'user') s.history.pop();
        const errorText = result.errorMessage || 'I wasn\'t able to produce a response. Try again, or switch to a different model.';
        cbk.settleReasoning();
        this.pushAssistantTurn(s, m.requestId, { ...result, text: errorText }, sentAt);
        this.post({ type: 'assistantMessage', sessionId: s.id, requestId: m.requestId, text: errorText, platform: turnPlatformLabel(s.model, result, this.deps), model: turnModelLabel(s.model, result.model) });
        return;
      }

      const after = this.deps.usage.get();
      let usage = {
        promptTokens: after.promptTokens - before.promptTokens,
        completionTokens: after.completionTokens - before.completionTokens,
        reasoningTokens: after.reasoningTokens - before.reasoningTokens,
        totalTokens: after.totalTokens - before.totalTokens,
      };

      // A turn that ended with unfinished todos surfaces the Continue button below (see
      // `resumable`) — the host does NOT resume it on its own. Auto-resuming up to 3 rounds
      // lived here for a day (2026-09-04 → 09-05): it spent triple the free-tier quota on a
      // decision the user was already one click away from making, and its history bookkeeping
      // wrote every agent turn's reply twice while bypassing persistAgentTurn's Stop
      // invariant. One click beats a quota-burning guess.

      // Final check, independent of WHY the turn ended (guardrail stop, round-cap exhaustion, or
      // plain completion): does the plan written this send still have unfinished items? Computed
      // straight from todo state rather than the model's own text, so it's always accurate.
      const wroteTodosThisSend = s.lastTodos !== todosAtSendStart;
      const finalTodos = wroteTodosThisSend ? (s.lastTodos ?? []) : [];
      const finalRemainingTodos = finalTodos.filter((t) => t.status !== 'completed');
      // A self-stop (step cap / no progress) OUTRANKS the todo notes: it explains the stop
      // itself, which the todo list cannot, and it carries the remaining items anyway. Without
      // this branch a capped turn fell into the `result.paused ? ''` case below and shipped no
      // footer at all — the turn ended silently, which is the whole failure being fixed here.
      const stopNote = result.stopReason ? stopReasonNote(result.stopReason, finalRemainingTodos) : '';
      const todoNote = stopNote || (finalRemainingTodos.length > 0
          ? (!result.paused ? incompleteTodosNote(finalTodos, finalRemainingTodos) : '')
          : finalTodos.length > 0 ? completedTodosNote(finalTodos)
          : '');

      const displayText = todoNote ? `${replyText}${todoNote}` : replyText;

      const persistedResult: AgentResult = displayText !== result.text ? { ...result, text: displayText } : result;
      this.persistAgentTurn(s, persistedResult);
      this.pushAssistantTurn(s, m.requestId, persistedResult, sentAt, usage);
      this.rememberWindow(s, result.platform, result.model);

      if (result.taskKind && result.platform && result.model) {
        s.voteCtx.set(m.requestId, { taskKind: result.taskKind, platform: result.platform, model: result.model, last: 'none' });
      }
      const modelLabel = turnModelLabel(s.model, result.model);

      /** One-click Continue affordance: a turn that ended with unfinished plan items — or a
       *  step-cap pause — is resumable exactly like a paused turn (handleResume re-runs with
       *  the full transcript in memory, no work repeated). Surface the webview's existing
       *  Continue button for those stops instead of telling the user to type "continue". */
      const resumable = !result.failed && (result.paused
        || finalRemainingTodos.length > 0);

      cbk.settleReasoning();
      this.post({ type: 'assistantMessage', sessionId: s.id, requestId: m.requestId, text: displayText, reasoning: result.reasoning, finishReason: result.finishReason, usage, platform: turnPlatformLabel(s.model, result, this.deps), model: modelLabel, paused: resumable });
      diagLog('send.postAssistant', `requestId=${m.requestId} · textLen=${(displayText ?? '').length} textHead="${(displayText ?? '').slice(0, 120).replace(/\n/g, '⏎')}" reasoningLen=${(result.reasoning ?? '').length} paused=${resumable}`);
      this.post({ type: 'usageTotals', totals: this.currentUsageTotals(s) });
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
        await this.maybeAutoCondense(s);
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

  /** Feed the pinned "changed files" bar: the earliest checkpoint aggregates every edit this
   *  session, filtered to what TierMux itself edited. Empty set hides the bar. */
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
    if (idx < 0) {
      // A silent return here turned every mismatched revert click into "nothing happens" with
      // zero diagnosable surface. Say something, and leave the ids in the console for the
      // mismatch report.
      console.error('[tiermux] revertTo: requestId not in the viewed session transcript', requestId,
        'known user requestIds:', s.transcript.filter((t) => t.role === 'user').map((t) => t.requestId));
      this.post({ type: 'notice', sessionId: s.id, text: 'Revert couldn\'t find that message in the current chat — the view may be stale. Reload the panel (↻) and try again.' });
      return;
    }
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
  private preparePlanFile(s: Session, title: string, request?: string): void {
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
    s.pendingPlanFile = { uri: fileUri, title: title || 'Untitled', request };
  }

  /** Fire-and-forget: refine a prose-fallback plan card's steps via structurePlanSteps and
   *  re-post the same card. Skipped once the user has acted on the plan or moved on. */
  private upgradePlanSteps(s: Session, requestId: string, rawText: string): void {
    const pendingAtStart = s.pendingPlanUser;
    void structurePlanSteps(rawText).then((steps) => {
      if (!steps || !steps.length) return;
      if (!this.isActiveRun(s, requestId)) return;
      if (s.pendingPlanUser !== pendingAtStart) return; // already approved/deferred/discarded
      this.postCard(s, { type: 'planProposed', sessionId: s.id, requestId, steps: formatStructuredSteps(steps) });
    });
  }

  /** Write (or overwrite) the plan MD file for the session with the current steps. */
  private async writePlanFile(s: Session, steps: string, status: 'approved' | 'executing' = 'approved'): Promise<void> {
    if (!s.pendingPlanFile) return;
    const { uri, title, request } = s.pendingPlanFile;
    const body = renderPlanMarkdown(steps, {
      title,
      request,
      status,
      model: s.liveModel ? `${s.livePlatform ?? '?'}/${s.liveModel}` : undefined,
      sessionId: s.id,
    });
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

  /** "Keep discussing": release the plan gate without executing or discarding. Nothing is
   *  written to disk — the plan only touches the filesystem once approved. */
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
    if (!m.approved) {
      s.pendingPlanUser = undefined;
      s.pendingPlanFile = undefined;
      for (const c of s.cards) {
        if (c.type === 'planProposed' && c.requestId === m.requestId) (c as { discarded?: boolean }).discarded = true;
      }
      this.post({ type: 'planDiscarded', sessionId: s.id, requestId: m.requestId });
      return;
    }

    // Build Plan commits the plan to disk — it does NOT execute it (that is the explicit Execute
    // click). No checkpoint of its own: this click has no transcript entry, so the file falls
    // under the still-open Plan turn's checkpoint, whose "Revert to here" undoes it.
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

  /** Execute an approved plan: write it to a file, switch to Agent mode, and launch an agent
   *  turn seeded with the plan. Only fires on a direct Execute click. */
  private async handleExecutePlan(m: Extract<InMessage, { type: 'executePlan' }>): Promise<void> {
    const s = this.current();
    if (!m.steps?.trim()) return;

    // 1. Persist the plan exactly like Save does (file + history), so an executed plan is also
    //    saved to disk and remembered in conversation history.
    if (m.steps) await this.writePlanFile(s, m.steps, 'executing');
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
    // A plan that came from the `exitPlanMode` tool (or that the user hand-edited on the card,
    // which re-serializes to the same shape) is ALREADY one clean step per numbered line — the
    // regex parser reads it exactly right, so the structurer model call is skipped. It still
    // runs for a ragged prose plan, which is what it was written for.
    const regexSteps = planStepsToTodos(m.steps).map((t) => t.content);
    const structuredSteps = isCleanNumberedList(m.steps)
      ? regexSteps
      : (await structurePlanSteps(m.steps) ?? regexSteps);
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

  /** Execute an approved plan as ONE agent turn with the steps enumerated in the prompt. Owns
   *  the same UI lifecycle as handleSend (run slot, busy, checkpoints, persistence). Called from
   *  handleExecutePlan and from the webview's Resume button after a reload. */
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
      this.post({ type: 'planProgress', sessionId: s.id, requestId, state: planState });

      // v3: the dedicated step engine is gone — an approved plan executes as ONE agent turn
      // with the steps enumerated in the prompt. The model works the list with its tools;
      // step-level pause/resume defers to v3.1.
      const stepsText = planState.steps.map((st, i) => `${i + 1}. ${st.text}`).join('\n');
      const planPrompt = `Execute this approved plan completely, step by step, using your tools. Verify each edit before moving on. When finished, reply with a short summary of what changed.\n\n${stepsText}`;
      s.history.push({ role: 'user', content: planPrompt });
      s.transcript.push({ role: 'user', text: planPrompt, requestId, ts: Date.now(), historyLen: s.history.length - 1 });
      this.post({ type: 'userEcho', sessionId: s.id, requestId, text: planPrompt });
      const result = await runAgentStream(this.makeAgentOpts(s, requestId, 'agent', s.reasoningEffort ?? 'medium', cbk, s.model),
      );

      if (!this.isActiveRun(s, requestId)) return;
      for (const st of planState.steps) st.status = 'done';
      planState.status = 'done';
      s.executingPlan = false;
      const summary = result.text || 'Plan execution finished.';
      cbk.settleReasoning();
      // Final summary as a real transcript entry so the finished plan reads as one turn.
      s.transcript.push({ role: 'assistant', text: summary, requestId, ts: Date.now(), historyLen: s.history.length - 1 });
      s.history.push({ role: 'assistant', content: summary });
      this.post({ type: 'assistantMessage', sessionId: s.id, requestId, text: summary, platform: turnPlatformLabel(s.model, result, this.deps), model: turnModelLabel(s.model, result.model) });
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
        await this.maybeAutoCondense(s);
      }
    }
  }

  /**
   * Append an agent run's outcome to the conversation history. Agent/Debug runs return
   * their full working transcript (tool calls + results + final answer) as workMessages —
   * persisting that is what lets a paused/failed run resume with memory instead of redoing
   * work. Tool-less runs (chat/trivial) have no workMessages, so fall back to the final text.
   */
  private persistAgentTurn(s: Session, result: AgentResult): void {
    // An aborted run's working transcript must not bleed into the next turn's history — the
    // model treated an abandoned tool call as a real request ("the next hola answered against
    // the previous project"). Stop leaves a final-reply bubble, not inherited messages.
    if (s.cancel?.token.isCancellationRequested) {
      s.history.push({ role: 'assistant', content: result.text });
      return;
    }
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

  /** True while `requestId` is still the active run in `session` (Stop or supersession clears
   *  it, dropping the abandoned run's output). About liveness, not visibility — background
   *  runs keep streaming into their hidden pane. */
  private isActiveRun(s: Session, requestId: string): boolean {
    return s.activeRequestId === requestId;
  }

  /** Cancel a session's in-flight run and detach it. Does NOT touch the webview DOM: what
   *  already rendered stays (a `switchSession` rebuild here replayed a transcript missing the
   *  turn just abandoned, so all partial progress vanished). */
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
    requestId: string,
    mode: AgentMode,
    effort: ReasoningEffort,
    callbacks: ReturnType<typeof this.agentCallbacks>,
    pinnedModel?: string,
    excludeModels?: string[],
  ): AgentOpts {
    return {
      messages: s.history,
      mode,
      effort,
      pinnedModel,
      excludeModels,
      sessionId: s.id,
      requestId,
      mentionCount: s.lastMentionCount,
      abortSignal: s.cancel ? tokenToAbortSignal(s.cancel.token) : undefined,
      // Read by the engine's toolApproval policy (policyFromSettings).
      autoApprove: this.autoApprove,
      toolCompaction: (() => {
        const v = vscode.workspace.getConfiguration('tiermux.agent').get<string>('toolCompaction', 'light');
        return v === 'off' || v === 'aggressive' ? v : 'light';
      })(),
      // Declared and documented since v3, read by nothing until 2026-09-05 — the engine
      // hardcoded the same 50, so raising it in settings silently did nothing.
      maxStepsPerTurn: vscode.workspace.getConfiguration('tiermux.agent').get<number>('maxStepsPerTurn', 50),
      verifyFixRounds: vscode.workspace.getConfiguration('tiermux.agent').get<number>('verifyFixRounds', 2),
      ...callbacks,
    };
  }

  /** Build the streaming callbacks for a run, each gated on the run still being active IN ITS
   *  SESSION (a cancelled run goes quiet; background runs keep streaming). */
  private agentCallbacks(s: Session, requestId: string, _mode: Mode): Omit<AgentOpts, 'messages' | 'mode' | 'effort' | 'abortSignal' | 'pinnedModel' | 'taskKind'> & { settleReasoning(): void } {
    // A thin map of engine events onto the webview protocol: onChunk → `chunk`, onReasoning →
    // reasoning toolStatus cards, onTool → toolStatus running/done/error, onError → `error`;
    // assistantStart is posted at ENTER and assistantMessage + busy:false at finish.
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
      // `reasoningStart` being set means a 'running' block was ALREADY posted for this segment
      // (both happen in the same onReasoning call), so it must be settled here no matter what
      // the buffer ended up holding. The old guard also required non-empty text, which left a
      // block spinning "Thinking…" forever whenever the burst collapsed to nothing after the
      // leading-whitespace strip (a delta of just "\n\n" announces the block, then trims away).
      if (!reasoningStart) return;
      const durationMs = Date.now() - reasoningStart;
      this.post({ type: 'toolStatus', sessionId: s.id, requestId, toolCallId: reasoningId(), name: 'reasoning', args: undefined, state: 'done', detail: reasoningText, durationMs });
      reasoningStart = 0;
      // Advance the segment HERE, not only in endReasoningSegment: whichever flush path runs
      // first (onChunk's flush or onTool's segment end) must hand the NEXT burst a fresh id +
      // empty buffer. Live repro: onChunk flushed the burst when reply text arrived, leaving
      // reasoningText non-empty under the OLD segment id — the next step's reasoning appended
      // to the same toolCallId, and upsertTool re-opened the settled block and re-appended the
      // whole combined reasoning at the END of the flow (the "reasoning suddenly appears" bug).
      reasoningSeg++;
      reasoningText = '';
    };
    // A tool call interrupted reasoning: settle the current burst (flush now also advances the
    // segment) so reasoning that resumes AFTER the tool renders as its own block.
    const endReasoningSegment = () => {
      flushReasoningDone();
    };

    return {
      // Not an AgentOpts field — a host-side settle hook the finish paths call right before the
      // final assistantMessage: a turn that ENDED on reasoning (no trailing text) must post the
      // 'done' toolStatus or the block stays "Thinking…" forever (and the settle-time whole-CoT
      // insert in the webview never fires because a stale running block exists).
      settleReasoning: flushReasoningDone,
      // Turn usage sink — the v3 engine reports provider-measured tokens here (the old
      // loop set this itself; v3 expects the host to provide it). Without it the footer
      // shows "0 in · 0 out" even on successful turns. Feeds the UsageTracker whose
      // before/after diff handleSend reads.
      usageSink: (info) => {
        this.deps.usage.add({
          prompt_tokens: info.inputTokens,
          completion_tokens: info.outputTokens,
          total_tokens: info.inputTokens + info.outputTokens,
        });
      },
      // Checkpoint baseline: the write tools call this AFTER reading the pre-write content and
      // BEFORE mutating — the accurate capture point (the old onTool hook below ran from the
      // engine's onStepEnd, i.e. after the write landed, so "before" snapshots stored the
      // post-edit content and undo restored files to their already-edited state).
      onBeforeWrite: (uri, before) => s.checkpoints.record(uri, before),
      onModel: (platform, model, runtimeName) => {        if (!live()) return;
        // The engine reports the model that ACTUALLY serves (reportServed). Overriding it with
        // the pin's modelId here is what paired "Kilo Gateway" with an OpenRouter model id in
        // the footer when the turn failed over (2026-08-31 repro) — show what really ran.
        s.livePlatform = platform;
        s.liveModel = model;
        s.liveRuntimeName = runtimeName;
        this.post({ type: 'assistantStart', sessionId: s.id, requestId, platform: turnPlatformLabel(s.model, { runtimeName, platform }, this.deps), model });
      },
      onTool: (e: ToolEvent) => {
        if (!live()) return;
        endReasoningSegment(); // reasoning gave way to a tool call — settle this burst, start a new segment

        // Per-call timing (docs/UI_POLISH_TOOL_REASONING_2026-09-02.md item 3): record the
        // start on the first 'running' sighting, diff against it once the call settles. A
        // long-pending approval (running can sit for an arbitrary, user-controlled time — see
        // PRESENT_TENSE_WHILE_RUNNING in ToolCard.ts) is fine to include; that wait genuinely
        // is how long the call took from the model's perspective.
        const mappedState = e.state === 'queued' ? 'running' : e.state as 'running' | 'done' | 'error';
        if (mappedState === 'running') {
          if (!s.toolStartTimes.has(e.toolCallId)) s.toolStartTimes.set(e.toolCallId, Date.now());
        }
        let durationMs: number | undefined;
        if (mappedState === 'done' || mappedState === 'error') {
          const start = s.toolStartTimes.get(e.toolCallId);
          if (start != null) {
            durationMs = Date.now() - start;
            s.toolStartTimes.delete(e.toolCallId);
          }
        }

        const steps = s.liveSteps.get(requestId) ?? [];
        const i = steps.findIndex((st) => st.toolCallId === e.toolCallId);
        const entry: TranscriptStep = { toolCallId: e.toolCallId, name: e.name, args: e.args, state: mappedState, detail: e.detail, durationMs };
        // NOTE: checkpoint baselines are captured by the tools themselves (onBeforeWrite →
        // CheckpointManager.record) BEFORE the write lands. The capture used to happen here,
        // but v3 fires every tool event from the engine's onStepEnd — after the tool already
        // wrote — so the "before" snapshot held post-edit content and undo restored files to
        // their already-edited state ("Restored N files" with zero visible change).
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
        this.post({ type: 'toolStatus', sessionId: s.id, requestId, toolCallId: e.toolCallId, name: e.name, args: e.args, state: mappedState, detail: e.detail, durationMs });

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
        // Append the raw delta — joining trimmed fragments with '\n' rendered each one as its own
        // line (breaks:true) and produced huge gaps. trimStart only so a leading newline doesn't
        // render as a blank first line.
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
        // Hand the webview the reasoning segment this draft is about to become; the reasoning post
        // that follows carries the same toolCallId, so it updates the block in place.
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
      const result = await runAgentStream(this.makeAgentOpts(s, m.requestId, 'agent', s.reasoningEffort ?? 'medium', cbk4, s.model), {});
      if (!this.isActiveRun(s, m.requestId)) return; // abandoned mid-run by a cancel
      // See the `result.failed` guard in the main send handler — show a real reply bubble with
      // the failure reason instead of a phantom blank "successful" turn.
      if (result.failed) {
        if (s.history[s.history.length - 1]?.role === 'user') s.history.pop();
        const errorText = result.errorMessage || 'I wasn\'t able to produce a response. Try again, or switch to a different model.';
        cbk4.settleReasoning();
        this.pushAssistantTurn(s, m.requestId, { ...result, text: errorText }, sentAt);
        this.post({ type: 'assistantMessage', sessionId: s.id, requestId: m.requestId, text: errorText, platform: turnPlatformLabel(s.model, result, this.deps), model: turnModelLabel(s.model, result.model) });
        return;
      }
      cbk4.settleReasoning();
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
      this.post({ type: 'assistantMessage', sessionId: s.id, requestId: m.requestId, text: result.text, reasoning: result.reasoning, finishReason: result.finishReason, usage, platform: turnPlatformLabel(s.model, result, this.deps), model: result.model, paused: result.paused });
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
        await this.maybeAutoCondense(s);
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
        type: ep.type,
        models: ep.models,
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
    };
  }

  private rememberWindow(s: Session, platform?: string, model?: string): void {
    if (!platform || !model) return;
    const w = this.deps.catalog.find(platform, model)?.contextWindow;
    if (w && w > 0) s.lastWindow = w;
  }

  /** Pick this session's title ONCE: `s.title` is written one time by {@link commitTitle}. Until
   *  then the UI shows the neutral UNTITLED_SESSION label, not a regex placeholder that the LLM
   *  title then visibly replaces. */
  private async maybeGenerateTitle(s: Session): Promise<void> {
    if (s.titleGenerated || s.userRenamedTitle) return;
    const users = s.transcript.filter((t) => t.role === 'user');
    if (!users.length) return;

    // Small talk alone earns no title — stay untitled (and titleGenerated stays false) so the
    // one-shot pick still happens when a real message finally arrives.
    const firstReal = users.find((u) => classifyTask(u.text ?? '') !== 'trivial');
    if (!firstReal) return;

    await this.generateTitleViaLlm(s, firstReal.text ?? '');
  }

  /** The ONLY writer of a generated `s.title`. Idempotent by construction: `titleGenerated` is
   *  already true when this runs, so nothing can call it twice for one session. */
  private commitTitle(s: Session, title: string): void {
    s.title = title;
    this.persist(s.id);
    this.updateViewTitle();
    this.postSessionList();
  }

  /** Ask a free LLM for a short, meaningful title from the user's message and write it
   *  to the session (falling back to the derived placeholder on any failure). */
  private async generateTitleViaLlm(s: Session, messageText: string): Promise<void> {
    if (s.titleGenerated || s.userRenamedTitle) return;
    s.titleGenerated = true; // guard before the call to avoid duplicate runs

    const snippet = messageText.slice(0, 800);
    // Up to three models, skipping any whose title is empty or a generic placeholder. The
    // hardcoded free-model list and the isReady pre-filter are gone with the Router: routeOnce
    // walks the picker's `trivial` chain, which is already "enabled, keyed, not rate-limited,
    // small and fast" — the properties that list was naming by hand. A well-formed but useless
    // title is not an error, so it is the only reason left to loop.
    let title = '';
    const tried: string[] = [];
    for (let attempt = 0; attempt < 3 && !title; attempt++) {
      const r = await routeOnceOrUndefined(
        [
          { role: 'system', content: TITLE_SYSTEM },
          { role: 'user', content: `User's message: ${snippet}` },
        ],
        {
          taskKind: 'trivial', temperature: 0.3, maxTokens: 48, effort: 'off',
          ...(attempt === 0 ? { model: utilityModelPreference() } : {}),
          exclude: tried, label: 'sessionTitle',
        },
      );
      if (!r) break;
      tried.push(r.key);
      const cleaned = sanitizeTitle(r.text);
      if (cleaned && !/^(starting conversation|new chat|untitled|chat)$/i.test(cleaned)) title = cleaned;
    }

    // Always commits: every model can fail, and an untitled session forever is worse than the
    // derived fallback. Either way this is the FIRST and ONLY title the user ever sees.
    this.commitTitle(s, title || deriveTitleFrom(messageText));
  }

   private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    // asWebviewUri() returns the same vscode-webview-resource: URL for a given file path on
    // every resolveWebviewView() call, and Chromium's on-disk HTTP cache (which survives across
    // Extension Development Host restarts, since they share a profile dir) can keep serving the
    // old bytes for that URL after the file changes on disk — an F5 relaunch then shows stale
    // JS/CSS with no error. Appending the file's own mtime as a query string busts that cache.
    const uri = (f: string) => {
      const fileUri = vscode.Uri.joinPath(this.extensionUri, 'media', f);
      let v = 0;
      try { v = Math.round(fs.statSync(fileUri.fsPath).mtimeMs); } catch { /* fall through with v=0 */ }
      return `${webview.asWebviewUri(fileUri).toString()}?v=${v}`;
    };
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
      // `data:` is needed for fonts.css's inlined IBM Plex @font-face rules (base64 woff2) —
      // there's no relative-path resolution risk that way, but font-src must explicitly admit it.
      `font-src ${webview.cspSource} data:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${uri('vendor/highlight.css')}" rel="stylesheet" nonce="${nonce}" />
  <link href="${uri('vendor/diff2html.min.css')}" rel="stylesheet" nonce="${nonce}" />
  <link href="${uri('styles/fonts.css')}" rel="stylesheet" nonce="${nonce}" />
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
