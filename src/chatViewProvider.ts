import * as vscode from 'vscode';
import type { ChatContent, ChatContentBlock, ChatMessage, Platform, TodoItem, CustomEndpoint, ReasoningEffort } from './shared/types';
import type { SecretStore } from './config/secrets';
import type { SettingsStore } from './config/settingsStore';
import type { Catalog } from './catalog/catalog';
import type { UsageTracker } from './config/usage';
import type { UsageStore } from './config/usageStore';
import type { Mode } from './shared/types';
import { runChatStream, runAgentStream, runPlanStream, getOcSessionDiff, type AgentResult, type AgentOpts, type ToolEvent } from './agent/sdk';
import { classifyTask } from './agent/routing';
import { PRODUCT_NAME } from './shared/branding';
import { SETTINGS_META, defaultForSetting } from './settingsMeta';
import type { Router } from './router/router';
import { AllModelsFailedError } from './router/router';
import type { McpManager } from './mcp/mcpManager';
import { CheckpointManager } from './edits/checkpoints';
import { openOcFileDiff } from './edits/ocSessionDiff';
import type { ModelStatsStore, Vote } from './config/modelStats';
import type { SlowModelStore } from './config/slowModel';
import { loadMcpRegistry, searchRemoteMcp } from './mcp/registry';
import type { McpRegistryItem, McpServerConfig } from './messages';
import type { Attachment, ConfigPayload, InMessage, KeyStatusInfo, OutMessage, SessionStatus, TranscriptMessage, TranscriptStep, UsagePayload } from './messages';
import { normalizeMcpServerConfig } from './mcp/mcpClient';
import { getNonce } from './util/nonce';
import { getPlatformInfo } from './providers';
import { parseSlash, resolveMentions, searchMentions } from './context/mentions';
import { contentToString } from './agent/content';
import { getSnapshot as getRetrievalSnapshot } from './context/telemetry';
import { ATTACHMENT_FILE_FILTERS, IMAGE_BYTE_LIMIT, buildAttachmentFromUri, isSupportedAttachmentPath, kindForPath as kindFromName, mimeForPath as mimeForName } from './util/extractAttachments';
import { estimateMessagesTokens } from './agent/budget';
import { TITLE_SYSTEM } from './agent/prompts';
import { condenseHistory, shouldCondense } from './agent/condense';
import { parseClarifying, type ClarifyingQuestion } from './agent/clarify';
import { deriveTitleFrom, looksLikeActionablePlan, planStepsToTodos, sanitizeTitle } from './session/titles';

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
 *  several key names OC's tools have used (see media/src/toolRendering.ts's own copy of
 *  this same tolerance for rendering tool-card titles). */
function extractToolFilePath(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  const v = a.path ?? a.file ?? a.filePath ?? a.filename ?? a.relativePath;
  return typeof v === 'string' && v ? v : undefined;
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
  createdAt: number;
  updatedAt: number;
  // runtime — NEVER persisted (a dead agent process can't resume mid-run):
  activeRequestId?: string;
  cancel?: vscode.CancellationTokenSource;
  pendingApprovals: Map<string, (approved: boolean) => void>;
  pendingPermissions: Map<string, (response: 'once' | 'always' | 'reject') => void>;
  approvalSeq: number;
  /** Ephemeral interactive cards (approvals / plan / clarifying) awaiting a click, cached so
   *  they re-render when the user switches back to a session whose run is blocked on them. */
  cards: OutMessage[];
  voteCtx: Map<string, { taskKind: string; platform: string; model: string; last: Vote }>;
  pendingPlanUser?: ChatContent;
  /** URI of the plan MD file saved at proposal time — updated if the user edits steps before approving. */
  pendingPlanFile?: { uri: vscode.Uri; title: string };
  pendingClarify?: { requestId: string; userContent: ChatContent; prompt: string; questions: ClarifyingQuestion[]; mode: 'plan' | 'agent' | 'chat' };
  /** In-flight `askUser` tool calls, keyed by OpenAI tool_call_id, awaiting a webview answer. */
  pendingAskUser: Map<string, (answer: string) => void>;
  /** True while an approved plan is being executed in Agent mode — drives the "Following the approved plan" header. */
  executingPlan?: boolean;
  checkpoints: CheckpointManager;
  lastWindow: number;
  // Cached live status for re-emitting when the user switches back to a running session
  // (the webview shows one session at a time and rebuilds on switch — see openSession).
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
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** Last token usage from an OpenCode-driven run, surfaced via SSE event. */
  lastUsage?: UsagePayload;
}

interface StoredSession {
  id: string;
  title: string;
  ts: number;
  transcript: TranscriptMessage[];
  model?: string;
  reasoningEffort?: string;
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
   */
  autoApprove = false;

  // ---- OpenCode engine state ----
  constructor(private readonly extensionUri: vscode.Uri, private readonly deps: ChatDeps) {
    this.autoApprove = deps.workspaceState.get<boolean>(AUTO_APPROVE_KEY, false);
    const stored = this.loadSessions();
    const currentId = deps.workspaceState.get<string>(CURRENT_KEY);
    // Rehydrate every persisted chat as a Session with EMPTY runtime — a dead agent process
    // can't resume, so nothing starts "running" after a reload (transcripts come back intact).
    for (const s of stored) this.sessions.set(s.id, this.hydrateSession(s));
    const viewed = currentId && this.sessions.has(currentId) ? currentId : stored[0]?.id;
    this.viewedSessionId = viewed ?? this.createSession().id;
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

  // ---------- session model ----------

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
      approvalSeq: 0,
      voteCtx: new Map(),
      cards: [],
      pendingAskUser: new Map(),
      checkpoints: new CheckpointManager(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
      lastWindow: 0,
      liveSteps: new Map(),
      model: undefined,
      reasoningEffort: undefined,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  /** Rehydrate a persisted session with empty runtime state. */
  private hydrateSession(s: StoredSession): Session {
    return {
      id: s.id,
      history: [],
      transcript: s.transcript ?? [],
      title: s.title,
      titleGenerated: !!s.title || (s.transcript?.some((t) => t.role === 'user') ?? false),
      pendingApprovals: new Map(),
      pendingPermissions: new Map(),
      approvalSeq: 0,
      voteCtx: new Map(),
      cards: [],
      pendingAskUser: new Map(),
      checkpoints: new CheckpointManager(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
      lastWindow: 0,
      liveSteps: new Map(),
      createdAt: s.ts ?? Date.now(),
      updatedAt: s.ts ?? Date.now(),
      model: s.model,
      reasoningEffort: s.reasoningEffort as ReasoningEffort | undefined,
    };
  }

  /** The session currently displayed in the webview. User-action entry points operate on it. */
  private current(): Session {
    const s = this.sessions.get(this.viewedSessionId);
    if (s) return s;
    // Shouldn't happen, but never return undefined.
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
    // Only update the title field for the VIEWED session — a background session's title
    // generation must not clobber the field the user is looking at.
    const s = this.sessions.get(this.viewedSessionId);
    if (s) this.post({ type: 'sessionTitle', sessionId: s.id, title: s.title?.trim() || this.deriveTitle(s) || PRODUCT_NAME });
  }

  /** Save one session's conversation into the session list (most-recent first). */
  private persist(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const others = this.loadSessions().filter((x) => x.id !== sessionId);
    if (s.transcript.length) {
      others.unshift({ id: s.id, title: s.title ?? this.deriveTitle(s), ts: Date.now(), transcript: s.transcript, model: s.model, reasoningEffort: s.reasoningEffort });
    }
    void this.deps.workspaceState.update(SESSIONS_KEY, others.slice(0, MAX_SESSIONS));
    if (sessionId === this.viewedSessionId) void this.deps.workspaceState.update(CURRENT_KEY, sessionId);
    this.updateViewTitle();
    this.postSessionList();
  }

  // ---------- tab status + session list ----------

  private setStatus(sessionId: string, status: SessionStatus): void {
    this.statusOf.set(sessionId, status);
    // The activity badge only makes sense while a run is actually live — clear it the moment
    // the session leaves running/queued so a finished/idle tab doesn't show a stale "Modifications".
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
    view.webview.onDidReceiveMessage((m: InMessage) => this.onMessage(m));
    this.updateViewTitle();
  }

  /** First-run engine onboarding progress (download %, verify, ready/error) — see
   *  the 'engineStatus' OutMessage variant. Queues like any other post() if the
   *  webview isn't open yet. */
  postEngineStatus(status: { state: 'downloading' | 'starting' | 'verifying' | 'ready' | 'error'; message?: string; percent?: number }): void {
    this.post({ type: 'engineStatus', ...status });
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
    // No-session overload (inline editor chat) → native modal.
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

  /** Resolve every outstanding approval in a session (e.g. on cancel / stop) so the agent never hangs. */
  private settlePendingApprovals(s: Session, approved: boolean): void {
    for (const resolve of s.pendingApprovals.values()) resolve(approved);
    s.pendingApprovals.clear();
    // Permission-ask prompts don't take a boolean — always settle with 'reject' on cancel/stop
    // (same reasoning as approvals: never leave the OC-side tool call hanging).
    for (const resolve of s.pendingPermissions.values()) resolve('reject');
    s.pendingPermissions.clear();
  }

  /** Resolve every in-flight in-chat `askUser` prompt with '' so the agent loop never hangs.
   *  Also posts a dismissed message per entry so the webview can disable the card (otherwise
   *  the card stays interactive even though the agent loop has already moved on). */
  private settlePendingAskUser(s: Session): void {
    if (s.pendingAskUser.size === 0) return;
    // Snapshot the entries to avoid mutating during iteration.
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

  // ---------- concurrency cap ----------

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
    // Give the webview a moment to mount if it was just revealed.
    await new Promise((r) => setTimeout(r, 150));
    const requestId = `ext-${Date.now()}`;
    const s = this.current();
    this.post({ type: 'userEcho', sessionId: s.id, requestId, text });
    await this.handleSend({ type: 'sendMessage', requestId, text, mode, model: 'auto', reasoningEffort: 'off' });
  }

  newChat(): void {
    // Create + view a fresh session. Other sessions' runs are NOT touched.
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

  /** Compact the conversation (from the native title bar). */
  async compact(): Promise<void> {
    await vscode.commands.executeCommand('tiermux.chat.focus');
    await this.handleCompact(this.current());
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
      this.persist(id);
      return;
    }
    // Not in memory (e.g. evicted beyond MAX_SESSIONS but still listed) — update storage only.
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
    // Live signals now stream into every open session's own persistent pane regardless of
    // view (see agentCallbacks), so a pane that's already been created for this session is
    // already showing current step/todos/text — this re-emit only matters the FIRST time the
    // webview creates a pane for `id` (e.g. right after a reload, before any live event for it
    // has arrived). It's a harmless no-op resend of already-current state otherwise.
    if (s.activeRequestId) {
      const rid = s.activeRequestId;
      this.post({ type: 'assistantStart', sessionId: s.id, requestId: rid, platform: s.livePlatform ?? '', model: s.liveModel ?? '' });
      if (s.lastStepLabel) this.post({ type: 'agentStep', sessionId: s.id, requestId: rid, phase: 'thinking', label: s.lastStepLabel });
      if (s.lastTodos && s.lastTodos.length) this.post({ type: 'todos', sessionId: s.id, requestId: rid, todos: s.lastTodos, followingPlan: !!s.executingPlan });
    }
    for (const card of s.cards) this.post(card);
    this.postCheckpoints(s);
    void this.sendConfig();
    this.updateViewTitle();
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
    this.stopRun(id, false); // cancel only this session's run (no rebuild — we switch away next)
    this.sessions.delete(id);
    this.statusOf.delete(id);
    void this.deps.workspaceState.update(SESSIONS_KEY, this.loadSessions().filter((s) => s.id !== id));
    if (wasViewed) {
      // Switch to the most recent remaining session, or start a fresh one.
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
        { const s = this.current(); this.post({ type: 'switchSession', sessionId: s.id, messages: s.transcript }); this.post({ type: 'busy', sessionId: s.id, busy: !!s.activeRequestId }); this.postCheckpoints(s); }
        break;
      case 'switchSession':
        this.openSession(m.sessionId);
        break;
      case 'requestConfig':
        await this.sendConfig();
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
      case 'openOcDiff': {
        const files = await getOcSessionDiff(m.sessionId);
        const f = files.find((x) => x.file === m.file);
        if (f) await openOcFileDiff(f.file, f.before, f.after);
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
        // Confirm on the host: window.confirm() is unavailable inside the webview iframe.
        const clearChoice = await vscode.window.showWarningMessage(
          'Clear all lifetime usage data? This resets the persistent token and est. $ saved counters. This cannot be undone.',
          { modal: true },
          'Clear',
        );
        // Re-arm the button regardless (the webview left it on "Clearing…").
        this.post({ type: 'usageTotals', totals: this.currentUsageTotals(this.current()) });
        if (clearChoice !== 'Clear') break;
        await this.deps.usageStore.clear();
        this.deps.usage.reset();
        // Reflect the zeroed totals IMMEDIATELY. sendConfig() does network work (MCP
        // registry fetch, key/endpoint probes) before posting; if that is slow or
        // throws, the card never refreshed and the button sat on "Clearing…" — looking
        // broken even though the store was already cleared. This lightweight post is
        // independent of sendConfig so the UI always updates right away.
        this.post({ type: 'usageTotals', totals: this.currentUsageTotals(this.current()) });
        void this.sendConfig();
        this.post({ type: 'notice', sessionId: this.viewedSessionId, text: '🧹 Usage data cleared.' });
        break;
      }
      case 'restoreCheckpoint':
        await this.handleRestoreCheckpoint(this.current(), m.id);
        break;
      case 'diffCheckpointFile':
        this.current().checkpoints.openDiff(m.id, m.uri);
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
      case 'setAutoApprove':
        this.autoApprove = m.enabled;
        await this.deps.workspaceState.update(AUTO_APPROVE_KEY, m.enabled);
        break;
      case 'newChat':
        this.newChat();
        break;
      // Custom OpenAI-compatible endpoints
      case 'addCustomEndpoint': {
        // Validate name (1-40 chars, trimmed, unique)
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
        // Validate baseUrl
        if (!/^https?:\/\/.+/i.test(m.baseUrl)) {
          void vscode.window.showWarningMessage('Base URL must start with http:// or https://');
          break;
        }
        // Generate id (c_ + 6 random base36 chars)
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
        // Invalidate provider cache so the new URL/name is used
        const { invalidateCustomProvider } = await import('./providers/index.js');
        invalidateCustomProvider(m.id);
        void this.sendConfig();
        break;
      }
      case 'removeCustomEndpoint': {
        // Fetch models BEFORE removing the endpoint — removal clears it from storage.
        const endpoint = this.deps.settings.getCustomEndpoint(m.id);
        await this.deps.settings.removeCustomEndpoint(m.id);
        // Clear endpoint-level key and all per-model keys.
        await this.deps.secrets.clearCustomKey(m.id);
        if (endpoint) {
          for (const model of endpoint.models) {
            await this.deps.secrets.clearCustomModelKey(m.id, model.modelId);
          }
        }
        // Remove fallback entries for this endpoint
        const fallback = this.deps.settings.getFallback().filter((e) => !e.modelId.startsWith(m.id + '::'));
        await this.deps.settings.setFallback(fallback);
        // Invalidate provider cache
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
        // Validate modelId (1-200 chars, no ::, no whitespace, unique within endpoint)
        const modelId = m.modelId.trim();
        if (modelId.length < 1 || modelId.length > 200) {
          void vscode.window.showWarningMessage('Model ID must be 1-200 characters.');
          break;
        }
        if (/[\s:]/.test(modelId)) {
          void vscode.window.showWarningMessage('Model ID cannot contain whitespace or ::');
          break;
        }
        if (endpoint.models.some((em) => em.modelId === modelId)) {
          void vscode.window.showWarningMessage(`Model "${modelId}" already exists in this endpoint.`);
          break;
        }
        // Add to endpoint.models
        endpoint.models.push({ modelId, displayName: m.displayName });
        await this.deps.settings.upsertCustomEndpoint(endpoint);
        // Add fallback entry (disabled by default)
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
        // Remove from endpoint.models
        endpoint.models = endpoint.models.filter((em) => em.modelId !== m.modelId);
        await this.deps.settings.upsertCustomEndpoint(endpoint);
        // Remove fallback entry
        const fallback = this.deps.settings.getFallback().filter((e) => !(e.platform === 'custom' && e.modelId === `${m.endpointId}::${m.modelId}`));
        await this.deps.settings.setFallback(fallback);
        // Clear per-model key
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
      this.post({
        type: 'notice',
        sessionId: this.viewedSessionId,
        text: `Couldn't extract text from "${attachment.name}" (likely a scanned PDF with no text layer) — sending the raw file instead. Not all models can read raw PDFs.`,
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
    const name = useWhole ? path : `${path}:${sel.start.line + 1}-${sel.end.line + 1}`;
    await vscode.commands.executeCommand('tiermux.chat.focus');
    this.post({ type: 'attachmentAdded', attachment: { kind: 'file', name, text: code } });
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
          dataUrl: `data:${m.mime || mimeForName(m.name)};base64,${bytes.toString('base64')}`,
          source: m.source,
        };
        this.post({ type: 'attachmentAdded', attachment });
        return;
      }
      // Non-image: drop the bytes into .tiermux/attach/ and run the workspace extractor.
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
        // Only secret vars are masked and treated as required; everything else
        // is optional and can be skipped with a blank entry. This is why a
        // keyless server (no `env` at all) adds with zero prompts.
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
    // Drop just this server now so the panel updates instantly; the rest keep
    // running. (The config-change watcher reconnects + refreshes in the back.)
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

  private async handleCompact(s: Session): Promise<void> {
    if (!shouldCondense(s.history)) {
      this.post({ type: 'notice', sessionId: s.id, text: 'Not enough conversation to compact yet.' });
      return;
    }
    this.post({ type: 'busy', sessionId: s.id, busy: true });
    try {
      const r = await condenseHistory(
        s.history,
        this.deps.router,
        s.livePlatform && s.liveModel ? `${s.livePlatform}/${s.liveModel}` : undefined,
      );
      if (!r) { this.post({ type: 'notice', sessionId: s.id, text: 'Compaction produced no summary; context unchanged.' }); return; }
      const prior = s.history.length;
      s.history = r.messages;
      this.persist(s.id);
      this.post({ type: 'usageTotals', totals: this.currentUsageTotals(s) });
      this.post({ type: 'notice', sessionId: s.id, text: `🗜 Context compacted — ${prior} → ${r.messages.length} messages. Earlier turns summarized; the last few kept verbatim.` });
    } catch (e) {
      this.post({ type: 'error', sessionId: s.id, message: `Compact failed: ${e instanceof Error ? e.message : String(e)}` });
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

    // Visual blocks: images ALWAYS (no text fallback exists for them — this is the only
    // channel a model has to see one). PDFs are DIFFERENT: extracted text already carries
    // the content to every model via `fileBlocks` above, universally, so the raw file part
    // is only worth the risk when there's no text to fall back on (a scanned PDF with no
    // extractable text layer). Observed in practice: some models (e.g. Gemini's lighter
    // tiers) don't support a PDF-typed file part and refuse the WHOLE turn on seeing one —
    // "I cannot process PDF file input" — even though the same message also carried a
    // perfectly good extracted-text answer. Sending it unconditionally made working PDFs
    // (successful extraction) WORSE, not better, for exactly the models that can't use it.
    const visualBlocks: ChatContentBlock[] = [];
    for (const a of list) {
      if (a.kind === 'image' && a.dataUrl) {
        visualBlocks.push({ type: 'image_url', image_url: { url: a.dataUrl, mime: a.mime, filename: a.name } });
      } else if (a.kind === 'pdf' && a.dataUrl && !a.text) {
        visualBlocks.push({ type: 'file', file: { filename: a.name, file_data: a.dataUrl, mime: a.mime } });
      }
    }
    if (visualBlocks.length === 0) return textParts;
    // Multimodal envelope for vision models.
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
    if (slash?.name === 'ocdiff') {
      const s = this.current();
      const files = await getOcSessionDiff(s.id);
      if (!files.length) {
        this.post({ type: 'assistantMessage', sessionId: s.id, requestId: m.requestId, text: 'No OC-tracked changes in this session yet.' });
      } else {
        this.post({
          type: 'ocSessionDiffList', sessionId: s.id, requestId: m.requestId,
          files: files.map((f) => ({ file: f.file, additions: f.additions, deletions: f.deletions })),
        });
      }
      return;
    }
    let prompt = m.text;
    const skill = slash && this.skills().get(slash.name);
    if (slash && skill) prompt = `${skill.prompt}\n\n${slash.rest}`;

    const s = this.current();
    s.model = m.model;
    s.reasoningEffort = m.reasoningEffort;
    const contextText = await resolveMentions(prompt).catch(() => '');
    const userContent = this.buildUserContent(prompt, contextText, m.attachments);
    s.history.push({ role: 'user', content: userContent });
    s.transcript.push({ role: 'user', text: prompt, requestId: m.requestId, ts: Date.now(), historyLen: s.history.length - 1, attachments: m.attachments });
    s.updatedAt = Date.now();
    void this.maybeGenerateTitle(s); // title from the user's message right away (e.g. "hi" -> "Greetings")

    s.cancel?.dispose();
    s.cancel = new vscode.CancellationTokenSource();
    s.activeRequestId = m.requestId;
    // Starting a new turn drops any in-flight askUser card (the old run is being cancelled);
    // settle before the new run takes over so its first askUser doesn't collide.
    this.settlePendingAskUser(s);
    s.executingPlan = false;

    const release = await this.acquireRunSlot(s.id);
    // Cancelled (Stop) while queued → release the slot and bail before running.
    if (s.activeRequestId !== m.requestId) { release(); if (this.sessions.has(s.id)) this.setStatus(s.id, 'idle'); return; }

    this.post({ type: 'busy', sessionId: s.id, busy: true });
    const before = this.deps.usage.get();
    await s.checkpoints.begin(m.requestId, prompt.slice(0, 60));
    const sentAt = Date.now();

    try {
      const cbk = this.agentCallbacks(s, m.requestId, m.mode as Mode);
      const sdkMode = m.mode as 'chat' | 'agent' | 'plan';
      let result = sdkMode === 'chat'
        ? await runChatStream(this.deps.router, this.makeAgentOpts(s, m.requestId, sdkMode, m.reasoningEffort ?? 'medium', cbk, m.model))
        : sdkMode === 'plan'
          ? await runPlanStream(this.deps.router, this.makeAgentOpts(s, m.requestId, sdkMode, m.reasoningEffort ?? 'medium', cbk, m.model), {})
          : await runAgentStream(this.deps.router, this.makeAgentOpts(s, m.requestId, sdkMode, m.reasoningEffort ?? 'medium', cbk, m.model), {});
      // Abandoned mid-run by a cancel → drop the output entirely.
      if (!this.isActiveRun(s, m.requestId)) return;

      if (m.mode === 'plan') {
        const clar = parseClarifying(result.text);
        if (clar.questions && clar.questions.length) {
          // The planner needs clarification before it can produce a good plan: drop the user
          // turn (re-added after answers), surface the questions as an interactive card, re-plan.
          s.history.pop();
          s.pendingPlanUser = userContent;
          s.pendingClarify = { requestId: m.requestId, userContent, prompt, questions: clar.questions, mode: 'plan' };
          this.postCard(s, { type: 'clarifyingQuestions', sessionId: s.id, requestId: m.requestId, questions: clar.questions });
          return;
        }
        // Only gate an ACTUAL actionable plan with "Approve & Run". A discussion answer — e.g.
        // "give me 6 changes", "how does this work?" — stays a normal chat turn (no run button,
        // no saved file), so Plan mode supports the discuss phase instead of slapping a run gate
        // on every reply. The turn is kept in history so the conversation continues naturally.
        if (looksLikeActionablePlan(clar.text)) {
          s.history.pop(); // not committed yet — re-added on approval
          s.pendingPlanUser = userContent;
          this.postCard(s, { type: 'planProposed', sessionId: s.id, requestId: m.requestId, steps: clar.text });
          void this.savePlan(s, prompt, clar.text);
          return;
        }
        // else: fall through and render as a normal assistant answer (discuss phase).
      }

      // Auto-continue: if the agent paused after hitting its step cap, silently resume
      // instead of making the user click "Continue" every time. Works for Agent and Ask-code
      // modes. Plan mode pauses are intentional (clarification / approval gates), so skip them.
      // Cap at 3 auto-continues so a genuinely-stuck model eventually surfaces to the user.
      const autoContinueOn = vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('autoContinue', true);
      if (m.mode !== 'plan') {
        for (let ac = 0; result.paused && autoContinueOn && ac < 3 && this.isActiveRun(s, m.requestId); ac++) {
          // Persist the tool-call transcript so the next run can read what was already done.
          this.persistAgentTurn(s, result);
          s.history.push({ role: 'user', content: 'Continue from where you left off. Keep going with the remaining steps using the work already done above — do not restart or repeat completed steps.' });
          result = await runAgentStream(this.deps.router, this.makeAgentOpts(s, m.requestId, 'agent', s.reasoningEffort ?? 'medium', cbk, s.model), {});
          if (!this.isActiveRun(s, m.requestId)) return;
        }
      }

      const after = this.deps.usage.get();
      const usage = { promptTokens: after.promptTokens - before.promptTokens, completionTokens: after.completionTokens - before.completionTokens, totalTokens: after.totalTokens - before.totalTokens };
      // Check for a ???QUESTIONS??? block in the response (agent asked for user input).
      // Strip it from the displayed text and show the structured Q&A card instead.
      // All modes can ask, including Chat — a genuinely ambiguous question pauses with
      // a card instead of the model guessing or flatly refusing.
      const agentClar = !result.paused ? parseClarifying(result.text) : { questions: null, text: result.text };
      // parseClarifying's `text` is ALWAYS already sentinel-scrubbed, whether or not it found
      // well-formed questions — using `result.text` (raw) in the no-questions case left any
      // incidental/malformed `???QUESTIONS???` fragment (a model half-attempting the format,
      // or just echoing it) in what got sent to the webview, which the client's OWN blunter
      // stripper (stripClarifyBlock in main.ts) then deleted from the sentinel to the end of
      // the message with no validity check — silently truncating a real answer to nothing.
      const displayText = agentClar.text;
      // Persist the SCRUBBED text, not raw result.text — persistAgentTurn/pushAssistantTurn
      // feed s.history (conversation context) and s.transcript (rebuilt on session switch /
      // window reload via renderAssistantStatic, which never re-runs parseClarifying). Persisting
      // the raw sentinel-laden text left every re-render from persisted history showing the
      // literal ???QUESTIONS???/Q[Label]:/???END??? markup instead of the clean answer the
      // live view showed the first time.
      const persistedResult: AgentResult = displayText !== result.text ? { ...result, text: displayText } : result;
      this.persistAgentTurn(s, persistedResult);
      this.pushAssistantTurn(s, m.requestId, persistedResult, sentAt, usage);
      this.rememberWindow(s, result.platform, result.model);
      // Remember which (task kind, model) produced this reply so 👍/👎 can teach the router.
      if (result.taskKind && result.platform && result.model) {
        s.voteCtx.set(m.requestId, { taskKind: result.taskKind, platform: result.platform, model: result.model, last: 'none' });
      }
      const pinned = (s.model && s.model !== 'auto') ? s.model : result.model;
      const hasQuestions = !!(agentClar.questions && agentClar.questions.length);
      // Defer the footer to the eventual final-answer bubble (a new requestId, once the user
      // answers) rather than showing it on the question-asking turn — the task isn't done yet.
      this.post({ type: 'assistantMessage', sessionId: s.id, requestId: m.requestId, text: displayText, reasoning: result.reasoning, usage, platform: result.runtimeName ?? result.platform, model: pinned, paused: result.paused, noFooter: hasQuestions });
      this.post({ type: 'usageTotals', totals: this.currentUsageTotals(s) });
      if (hasQuestions) {
        s.pendingClarify = { requestId: m.requestId, userContent, prompt, questions: agentClar.questions!, mode: m.mode as 'plan' | 'agent' | 'chat' };
        this.postCard(s, { type: 'clarifyingQuestions', sessionId: s.id, requestId: m.requestId, questions: agentClar.questions! });
      }
    } catch (e) {
      if (!this.isActiveRun(s, m.requestId)) return; // abandoned run — don't surface its error
      this.post({ type: 'error', sessionId: s.id, requestId: m.requestId, message: e instanceof Error ? e.message : String(e) });
      void this.maybeRecommendModels(e);
      // Drop the user turn that produced no answer to keep history clean.
      if (s.history[s.history.length - 1]?.role === 'user') s.history.pop();
    } finally {
      // Only finalize if this run still owns the session; a cancelled run leaves cleanup to
      // stopRun (which already settled approvals + reset status).
      release();
      if (this.isActiveRun(s, m.requestId)) {
        s.activeRequestId = undefined;
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
   */
  private async postChangedFilesBar(s: Session): Promise<void> {
    const cps = s.checkpoints.list();
    if (!cps.length) { this.post({ type: 'changedFiles', sessionId: s.id, id: '', files: [] }); return; }
    const id = cps[0].id;
    const files = await s.checkpoints.changedFiles(id);
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
    // The earliest checkpoint among removed turns reverts everything from here onward.
    let firstCpId: string | undefined;
    for (const rid of removedIds) { const cid = s.checkpoints.idForRequest(rid); if (cid) { firstCpId = cid; break; } }
    const fileCount = firstCpId ? (await s.checkpoints.changedFiles(firstCpId)).length : 0;

    const laterTurns = s.transcript.slice(idx).filter((t) => t.role === 'user').length;
    const detail = fileCount
      ? `${fileCount} changed file${fileCount > 1 ? 's' : ''} will be restored and ${laterTurns} message${laterTurns > 1 ? 's' : ''} removed.`
      : `${laterTurns} message${laterTurns > 1 ? 's' : ''} will be removed.`;
    const choice = await vscode.window.showWarningMessage(`Revert to this point? ${detail}`, { modal: true }, 'Revert');
    if (choice !== 'Revert') return;

    // Stop any in-flight run for this session: the transcript/history we're about to
    // truncate is what that run is appending to, so leaving it going would strand it
    // (and leave the busy indicator pinned red). rebuild=false — we re-post below.
    this.stopRun(s.id, false);

    if (firstCpId) await s.checkpoints.restore(firstCpId);
    s.checkpoints.dropByRequestIds(removedIds);

    // Restore history to just before the reverted turn. We snapshot historyLen on each user
    // turn (see handleSend), so truncating to it preserves every earlier tool call/result —
    // rebuilding from transcript text alone would silently drop all of that context.
    const cut = s.transcript[idx]?.historyLen;
    s.transcript = s.transcript.slice(0, idx);
    s.history = (typeof cut === 'number' && cut <= s.history.length)
      ? s.history.slice(0, cut)
      : s.transcript.map((t) => ({ role: t.role, content: t.text }));

    this.post({ type: 'switchSession', sessionId: s.id, messages: s.transcript });
    await this.postCheckpoints(s);
    this.post({ type: 'setInput', text: removedText, attachments: removedAttachments });
    if (fileCount) this.post({ type: 'notice', sessionId: s.id, text: `⟲ Reverted ${fileCount} file${fileCount !== 1 ? 's' : ''} to this point.` });
    this.persist(s.id);
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
    this.post({ type: 'notice', sessionId: s.id, text: `⟲ Restored ${n} file${n !== 1 ? 's' : ''} to before this message.` });
    await this.postCheckpoints(s);
  }

  /** Persist a proposed plan as a visible markdown checklist file in the workspace.
   *  Stores the file URI on the session so edits before approval can overwrite it. */
  private async savePlan(s: Session, title: string, steps: string): Promise<void> {
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
    await this.writePlanFile(s, steps);
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
      this.post({ type: 'notice', sessionId: this.viewedSessionId, text: `📄 Plan saved to ${vscode.workspace.asRelativePath(uri)}` });
    } catch (e) {
      this.post({ type: 'notice', sessionId: this.viewedSessionId, text: `Could not save plan file: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /**
   * "Keep discussing": release the plan gate without executing or discarding. The user wants to
   * refine first — so drop the pending-plan state (the next message is a clean discussion turn),
   * keep any edits they made to the steps, and mark the card so it replays without re-gating. The
   * saved .md plan and the still-available "Approve & Run" let them build it when ready.
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
    // Overwrite the plan file with any edits the user made before deferring.
    if (m.steps) void this.writePlanFile(s, m.steps);
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
    // Overwrite the plan file with any edits the user made before approving.
    if (m.steps) void this.writePlanFile(s, m.steps);
    s.pendingPlanFile = undefined;
    this.removeCards(s, (c) => c.type === 'planProposed');
    const original = s.pendingPlanUser;
    s.pendingPlanUser = undefined;
    if (original) s.history.push({ role: 'user', content: original });
    s.history.push({ role: 'user', content: `Execute this plan step by step:\n\n${m.steps}` });

    s.cancel?.dispose();
    s.cancel = new vscode.CancellationTokenSource();
    s.activeRequestId = m.requestId;
    s.executingPlan = true;
    const release = await this.acquireRunSlot(s.id);
    if (s.activeRequestId !== m.requestId) { release(); if (this.sessions.has(s.id)) this.setStatus(s.id, 'idle'); return; }
    this.post({ type: 'busy', sessionId: s.id, busy: true });
    const stepCount = planStepsToTodos(m.steps).length;
    this.post({ type: 'agentStep', sessionId: s.id, requestId: m.requestId, phase: 'thinking', label: stepCount > 0 ? `▶ Executing approved plan (${stepCount} steps)` : '▶ Executing approved plan' });
    // Seed the live checklist from the approved plan so the user sees it immediately;
    // the agent then advances each item via updateTodos as it executes.
    const seeded = planStepsToTodos(m.steps);
    if (seeded.length) this.post({ type: 'todos', sessionId: s.id, requestId: m.requestId, todos: seeded, followingPlan: true });
    const before = this.deps.usage.get();
    await s.checkpoints.begin(m.requestId, 'Plan execution');
    const sentAt = Date.now();
    try {
      const cbk3 = this.agentCallbacks(s, m.requestId, 'agent');
      const result = await runAgentStream(this.deps.router, this.makeAgentOpts(s, m.requestId, 'agent', s.reasoningEffort ?? 'medium', cbk3, s.model), {});
      if (!this.isActiveRun(s, m.requestId)) return; // abandoned mid-run by a cancel
      const after = this.deps.usage.get();
      const usage = { promptTokens: after.promptTokens - before.promptTokens, completionTokens: after.completionTokens - before.completionTokens, totalTokens: after.totalTokens - before.totalTokens };
      this.persistAgentTurn(s, result);
      this.pushAssistantTurn(s, m.requestId, result, sentAt, usage);
      this.rememberWindow(s, result.platform, result.model);
      // Remember which (task kind, model) produced this reply so 👍/👎 can teach the router.
      if (result.taskKind && result.platform && result.model) {
        s.voteCtx.set(m.requestId, { taskKind: result.taskKind, platform: result.platform, model: result.model, last: 'none' });
      }
      this.post({ type: 'assistantMessage', sessionId: s.id, requestId: m.requestId, text: result.text, reasoning: result.reasoning, usage, platform: result.runtimeName ?? result.platform, model: result.model, paused: result.paused });
      this.post({ type: 'usageTotals', totals: this.currentUsageTotals(s) });
    } catch (e) {
      if (!this.isActiveRun(s, m.requestId)) return;
      this.post({ type: 'error', sessionId: s.id, requestId: m.requestId, message: e instanceof Error ? e.message : String(e) });
      void this.maybeRecommendModels(e);
    } finally {
      release();
      if (this.isActiveRun(s, m.requestId)) {
        s.activeRequestId = undefined;
        s.executingPlan = false;
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
  private pushAssistantTurn(s: Session, requestId: string, result: AgentResult, sentAt: number, usage?: { promptTokens: number; completionTokens: number; totalTokens: number }): void {
    const steps = s.liveSteps.get(requestId);
    s.liveSteps.delete(requestId);
    s.transcript.push({
      role: 'assistant',
      text: result.text,
      model: result.model ? `${result.runtimeName ?? result.platform}/${result.model}` : undefined,
      ts: Date.now(),
      secs: Math.max(0, Math.round((Date.now() - sentAt) / 1000)),
      reasoning: result.reasoning || undefined,
      usage: usage ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens } : undefined,
      steps: steps && steps.length ? steps : undefined,
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

  /** Cancel a session's in-flight run and detach it so its output can't land anywhere.
   *  `rebuild=false` skips the thread rebuild (used by deleteSession, which switches away right after). */
  private stopRun(sessionId: string, rebuild = true): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    // If it was still queued (not running yet), unblock its acquireRunSlot so the slot frees;
    // the handler's post-acquire liveness guard then bails out.
    const qi = this.runQueue.findIndex((q) => q.sessionId === sessionId);
    if (qi >= 0) { this.runQueue.splice(qi, 1)[0].resolve(); }
    s.cancel?.cancel();
    s.activeRequestId = undefined; // invalidates the run's liveness guard (isActiveRun)
    this.settlePendingApprovals(s, false); // unblock any command/edit awaiting a click
    this.settlePendingAskUser(s); // unblock any in-chat askUser card
    s.pendingClarify = undefined;
    s.pendingPlanUser = undefined;
    s.executingPlan = false;
    s.cards = [];
    this.setStatus(sessionId, 'idle');
    // If the user is watching this session, rebuild its thread clean (drops the abandoned
    // turn's live cards) and reset the composer.
    if (rebuild && this.viewedSessionId === sessionId) {
      this.post({ type: 'switchSession', sessionId, messages: s.transcript });
    }
    this.post({ type: 'busy', sessionId, busy: false });
  }

  private makeAgentOpts(
    s: Session,
    _requestId: string,
    mode: 'chat' | 'agent' | 'plan',
    effort: ReasoningEffort,
    callbacks: ReturnType<typeof this.agentCallbacks>,
    pinnedModel?: string,
  ): AgentOpts {
    return {
      messages: s.history,
      mode,
      effort,
      pinnedModel,
      sessionId: s.id,
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
    // The webview keeps a persistent DOM pane per session (not just the viewed one), so every
    // live signal below posts unconditionally once the run is live — the pane it belongs to
    // renders it whether or not that session is currently in view. `s.live*`/`s.last*` caches
    // are still kept (openSession reads them to seed a pane the very first time it's created,
    // e.g. after a reload) but are no longer the ONLY way a background run's progress reaches
    // the webview.
    return {
      onModel: (platform, model, runtimeName) => {
        if (!live()) return;
        const pinned = (s.model && s.model !== 'auto') ? s.model : model;
        s.livePlatform = platform;
        s.liveModel = pinned;
        s.liveRuntimeName = runtimeName;
        this.post({ type: 'assistantStart', sessionId: s.id, requestId, platform: runtimeName ?? platform, model: pinned });
      },
      onTool: (e: ToolEvent) => {
        if (!live()) return;
        // Accumulate every step (regardless of view) so the turn's transcript entry can be
        // rebuilt with its full step list after a re-render (e.g. "Revert to here").
        const steps = s.liveSteps.get(requestId) ?? [];
        const i = steps.findIndex((st) => st.toolCallId === e.toolCallId);
        const mappedState = e.state === 'queued' ? 'running' : e.state as 'running' | 'done' | 'error';
        const entry: TranscriptStep = { toolCallId: e.toolCallId, name: e.name, args: e.args, state: mappedState, detail: e.detail };
        if (i < 0 && FILE_WRITE_TOOL_NAMES.has(e.name)) {
          // OC (the agent engine) applies Agent/Plan-mode edits directly to the workspace,
          // bypassing TierMux's own EditGate — so record()-based checkpoints normally see
          // nothing for these edits (the git-tree snapshot in gitSnapshot.ts covers most of
          // it, but can't see gitignored files). Best-effort close that gap: on the FIRST
          // event we see for a given tool call (ideally its 'running'/'queued' state, before
          // OC has actually written anything), read the file's current on-disk content and
          // record it as this turn's baseline. record() itself dedupes by file, so later/
          // duplicate events for the same path are harmless no-ops.
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
        if (WRITE_TOOL_NAMES.has(e.name) && s.liveActivity !== 'Modifications') {
          s.liveActivity = 'Modifications';
          this.postSessionList();
        }
        this.post({ type: 'toolStatus', sessionId: s.id, requestId, toolCallId: e.toolCallId, name: e.name, args: e.args, state: mappedState, detail: e.detail });
      },
      onReasoning: (text) => {
        if (!live()) return;
        const t = (text || '').trim();
        if (!t) return;
        // A thinking block rides the same step pipeline as tool cards (a step named 'reasoning'),
        // so it persists in liveSteps and replays on re-render with zero extra plumbing.
        const steps = s.liveSteps.get(requestId) ?? [];
        const id = `reason-${steps.length}`;
        steps.push({ toolCallId: id, name: 'reasoning', state: 'done', detail: t });
        s.liveSteps.set(requestId, steps);
        this.post({ type: 'toolStatus', sessionId: s.id, requestId, toolCallId: id, name: 'reasoning', args: undefined, state: 'done', detail: t });
      },
      onStep: (phase, label) => { if (!live()) return; s.lastStepLabel = label; this.post({ type: 'agentStep', sessionId: s.id, requestId, phase: phase as 'thinking' | 'synthesizing' | 'done', label }); },
      onTodos: (todos) => { if (!live()) return; s.lastTodos = todos; this.post({ type: 'todos', sessionId: s.id, requestId, todos, followingPlan: !!s.executingPlan }); },
      onChunk: (text) => {
        if (!live()) return;
        if (s.liveActivity !== 'Text change') { s.liveActivity = 'Text change'; this.postSessionList(); }
        this.post({ type: 'assistantChunk', sessionId: s.id, requestId, text });
      },
      onAskUser: async (question, options) => {
        if (!live()) return '';
        // Mint a unique callId per prompt so the webview's response correlates back to the
        // exact pending promise. The agent loop is sequential so only one askUser can be
        // in-flight at a time per session — the callId is purely for response routing.
        const callId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        return this.requestAskUser(s, requestId, callId, question, options);
      },
      onPermissionAsk: async (info) => {
        if (!live()) return 'reject';
        return this.requestPermissionAsk(s.id, requestId, info.title, info.pattern);
      },
      onFailover: (from, reason) => {
        if (!live()) return;
        const sep = from.indexOf('::');
        const platformId = sep >= 0 ? from.slice(0, sep) : from;
        const modelId = sep >= 0 ? from.slice(sep + 2) : '';
        this.post({ type: 'failoverNotice', sessionId: s.id, requestId, from: `${displayNameForEntry({ platform: platformId, modelId }, this.deps)}/${modelId}`, reason });
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
        // Soft, non-blocking notice — used when the run delivered a usable answer despite a
        // mid-stream error, instead of a scary red error that hides the answer.
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
    s.cancel?.dispose();
    s.cancel = new vscode.CancellationTokenSource();
    s.activeRequestId = m.requestId;
    const release = await this.acquireRunSlot(s.id);
    if (s.activeRequestId !== m.requestId) { release(); if (this.sessions.has(s.id)) this.setStatus(s.id, 'idle'); return; }
    this.post({ type: 'busy', sessionId: s.id, busy: true });
    const before = this.deps.usage.get();
    await s.checkpoints.begin(m.requestId, 'Continue');
    const sentAt = Date.now();
    try {
      const cbk4 = this.agentCallbacks(s, m.requestId, 'agent');
      const result = await runAgentStream(this.deps.router, this.makeAgentOpts(s, m.requestId, 'agent', s.reasoningEffort ?? 'medium', cbk4, s.model), {});
      if (!this.isActiveRun(s, m.requestId)) return; // abandoned mid-run by a cancel
      const after = this.deps.usage.get();
      const usage = { promptTokens: after.promptTokens - before.promptTokens, completionTokens: after.completionTokens - before.completionTokens, totalTokens: after.totalTokens - before.totalTokens };
      this.persistAgentTurn(s, result);
      this.pushAssistantTurn(s, m.requestId, result, sentAt, usage);
      this.rememberWindow(s, result.platform, result.model);
      if (result.taskKind && result.platform && result.model) {
        s.voteCtx.set(m.requestId, { taskKind: result.taskKind, platform: result.platform, model: result.model, last: 'none' });
      }
      this.post({ type: 'assistantMessage', sessionId: s.id, requestId: m.requestId, text: result.text, reasoning: result.reasoning, usage, platform: result.runtimeName ?? result.platform, model: result.model, paused: result.paused });
      this.post({ type: 'usageTotals', totals: this.currentUsageTotals(s) });
    } catch (e) {
      if (!this.isActiveRun(s, m.requestId)) return;
      this.post({ type: 'error', sessionId: s.id, requestId: m.requestId, message: e instanceof Error ? e.message : String(e) });
      void this.maybeRecommendModels(e);
      // The resume nudge produced nothing — drop it so history stays clean and resumable.
      if (s.history[s.history.length - 1]?.role === 'user') s.history.pop();
    } finally {
      release();
      if (this.isActiveRun(s, m.requestId)) {
        s.activeRequestId = undefined;
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
    // Drop the card from the cache so switching sessions away and back can't re-render a
    // stale question form after the user already answered.
    this.removeCards(s, (c) => c.type === 'clarifyingQuestions' && c.requestId === m.requestId);
    if (!ctx) return;

    const qa = ctx.questions
      .map((q, i) => `Q: ${q.text}\nA: ${m.answers[i] ?? '(no answer)'}`)
      .join('\n');

    // Agent/chat end-of-turn: send answers as a new user message to continue the OC session.
    if (ctx.mode === 'agent' || ctx.mode === 'chat') {
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await this.handleSend({ type: 'sendMessage', requestId, text: qa, mode: ctx.mode, model: s.model ?? 'auto', reasoningEffort: s.reasoningEffort ?? 'medium' });
      return;
    }

    // Plan pre-flight: fold answers in and re-run Plan mode for a real plan.
    const base = s.history.length;
    s.history.push({ role: 'user', content: ctx.userContent });
    s.history.push({ role: 'user', content: `Clarifications from the user:\n${qa}\n\nUsing these answers, produce the step-by-step plan now.` });

    s.cancel?.dispose();
    s.cancel = new vscode.CancellationTokenSource();
    s.activeRequestId = m.requestId;
    const release = await this.acquireRunSlot(s.id);
    if (s.activeRequestId !== m.requestId) { release(); if (this.sessions.has(s.id)) this.setStatus(s.id, 'idle'); return; }
    this.post({ type: 'busy', sessionId: s.id, busy: true });
    await s.checkpoints.begin(m.requestId, 'Plan (clarified)');
    try {
      const cbk5 = this.agentCallbacks(s, m.requestId, 'plan');
      const result = await runPlanStream(this.deps.router, this.makeAgentOpts(s, m.requestId, 'plan', s.reasoningEffort ?? 'medium', cbk5, s.model), {});
      if (!this.isActiveRun(s, m.requestId)) return;
      const clar = parseClarifying(result.text);
      this.postCard(s, { type: 'planProposed', sessionId: s.id, requestId: m.requestId, steps: clar.text });
      void this.savePlan(s, ctx.prompt, clar.text);
      // pendingPlanUser (set in handleSend) stays for the subsequent Approve flow.
    } catch (e) {
      if (!this.isActiveRun(s, m.requestId)) return;
      this.post({ type: 'error', sessionId: s.id, requestId: m.requestId, message: e instanceof Error ? e.message : String(e) });
      void this.maybeRecommendModels(e);
    } finally {
      release();
      if (this.isActiveRun(s, m.requestId)) {
        // Drop the clarify turns we added; the user turn is re-added on approval via pendingPlanUser.
        s.history.length = base;
        s.activeRequestId = undefined;
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
    if (s.titleGenerated) return;
    const users = s.transcript.filter((t) => t.role === 'user');
    if (!users.length) return;
    // Title from the first ACTUAL request. A greeting only gets a provisional title and
    // we retry on later turns — so "Hi" followed by a real question updates the title
    // instead of staying stuck on "Starting Conversation".
    const firstReal = users.find((u) => classifyTask(u.text ?? '') !== 'trivial');
    if (!firstReal) {
      if (s.title !== 'Starting Conversation') { s.title = 'Starting Conversation'; this.persist(s.id); this.updateViewTitle(); }
      return; // leave titleGenerated false → re-evaluate when a real message arrives
    }
    s.titleGenerated = true; // guard before the call to avoid duplicate runs
    try {
      const snippet = (firstReal.text ?? '').slice(0, 800);
      let raw = '';

      if (!raw) {
        const model = await this.deps.router.pickUtilityModel();
        const result = await this.deps.router.route(
          [
            { role: 'system', content: TITLE_SYSTEM },
            { role: 'user', content: `User's message: ${snippet}` },
          ],
          { temperature: 0.3, max_tokens: 48, model, taskKind: 'trivial', reasoningEffort: 'off' },
        );
        raw = contentToString(result.response.choices[0]?.message.content);
      }

      let title = sanitizeTitle(raw);
      if (/^(starting conversation|new chat|untitled|chat)$/i.test(title)) title = '';
      s.title = title || deriveTitleFrom(firstReal.text ?? '');
      this.persist(s.id);
      this.updateViewTitle();
    } catch {
      s.title = deriveTitleFrom(firstReal.text ?? '');
      this.persist(s.id);
      this.updateViewTitle();
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', f));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
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
  <link href="${uri('main.css')}" rel="stylesheet" nonce="${nonce}" />
  <title>${PRODUCT_NAME}</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">window.__PRODUCT_NAME__ = ${JSON.stringify(PRODUCT_NAME)}; window.__LOGO_URI__ = ${JSON.stringify(uri('logo-mono.png').toString())};</script>
  <script nonce="${nonce}" src="${uri('vendor/marked.min.js')}"></script>
  <script nonce="${nonce}" src="${uri('vendor/highlight.min.js')}"></script>
  <script nonce="${nonce}" src="${uri('vendor/diff2html.min.js')}"></script>
  <script nonce="${nonce}" src="${uri('main.js')}"></script>
</body>
</html>`;
  }
}
