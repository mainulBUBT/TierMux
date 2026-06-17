import * as vscode from 'vscode';
import type { ChatContent, ChatMessage, Platform } from './shared/types';
import type { SecretStore } from './config/secrets';
import type { SettingsStore } from './config/settingsStore';
import type { Catalog } from './catalog/catalog';
import type { UsageTracker } from './config/usage';
import { Agent, type Mode } from './agent/agent';
import { PRODUCT_NAME } from './shared/branding';
import type { Router } from './router/router';
import type { McpManager } from './mcp/mcpManager';
import type { CodebaseIndex } from './index/codebaseIndex';
import type { CheckpointManager } from './edits/checkpoints';
import type { ModelStatsStore, Vote } from './config/modelStats';
import { loadMcpRegistry, searchRemoteMcp } from './mcp/registry';
import type { McpRegistryItem } from './messages';
import type { Attachment, ConfigPayload, InMessage, KeyStatusInfo, OutMessage, TranscriptMessage } from './messages';
import { getNonce } from './util/nonce';
import { allPlatformInfo, getPlatformInfo } from './providers';
import { parseSlash, resolveMentions, searchMentions } from './context/mentions';
import { contentToString } from './agent/content';
import { estimateMessagesTokens } from './agent/budget';
import { SUMMARY_SYSTEM, TITLE_SYSTEM } from './agent/prompts';
import { parseClarifying, type ClarifyingQuestion } from './agent/clarify';

const SLASH_PROMPTS: Record<string, string> = {
  explain: 'Explain the following / the referenced code clearly:',
  fix: 'Find and fix problems in the following / referenced code:',
  tests: 'Write unit tests for the following / referenced code:',
  doc: 'Write documentation/comments for the following / referenced code:',
};

export interface ChatDeps {
  secrets: SecretStore;
  settings: SettingsStore;
  catalog: Catalog;
  usage: UsageTracker;
  agent: Agent;
  router: Router;
  mcp: McpManager;
  index: CodebaseIndex;
  checkpoints: CheckpointManager;
  modelStats: ModelStatsStore;
  workspaceState: vscode.Memento;
  generateCommitMessage: () => Promise<void>;
}

const SESSIONS_KEY = 'tiermux.sessions';
const CURRENT_KEY = 'tiermux.currentSession';
const MAX_SESSIONS = 50;

interface ChatSession {
  id: string;
  title: string;
  ts: number;
  history: ChatMessage[];
  transcript: TranscriptMessage[];
}

interface HistoryItem extends vscode.QuickPickItem {
  sessionId: string;
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'tiermux.chat';
  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private transcript: TranscriptMessage[] = [];
  private sessionId: string;
  private cancel?: vscode.CancellationTokenSource;
  private ready = false;
  private outQueue: OutMessage[] = [];
  private lastWindow = 0;
  private mcpRegistry?: McpRegistryItem[];
  /** Per-reply context for attributing 👍/👎 feedback to (taskKind, model). */
  private voteCtx = new Map<string, { taskKind: string; platform: string; model: string; last: Vote }>();

  constructor(private readonly extensionUri: vscode.Uri, private readonly deps: ChatDeps) {
    const sessions = this.loadSessions();
    const currentId = deps.workspaceState.get<string>(CURRENT_KEY);
    const current = sessions.find((s) => s.id === currentId) ?? sessions[0];
    if (current) {
      this.sessionId = current.id;
      this.history = current.history ?? [];
      this.transcript = current.transcript ?? [];
      this.sessionTitle = current.title;
      this.titleGenerated = !!current.title;
    } else {
      this.sessionId = this.newSessionId();
    }
    deps.secrets.onDidChange(() => void this.sendConfig());
    deps.settings.onDidChange(() => void this.sendConfig());
  }

  private newSessionId(): string {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  private loadSessions(): ChatSession[] {
    return this.deps.workspaceState.get<ChatSession[]>(SESSIONS_KEY, []);
  }

  private deriveTitle(): string {
    const firstUser = this.transcript.find((t) => t.role === 'user');
    const base = (firstUser?.text ?? '').trim().replace(/\s+/g, ' ');
    return base ? base.slice(0, 60) : 'New chat';
  }

  /** Push the current session title into the webview header; the chrome shows just the brand. */
  private updateViewTitle(): void {
    // Chrome shows only the product name; the live, editable title lives in the webview header.
    if (this.view) this.view.title = PRODUCT_NAME;
    this.post({ type: 'sessionTitle', title: this.sessionTitle?.trim() || this.deriveTitle() || PRODUCT_NAME });
  }

  /** Save the current conversation into the session list (most-recent first). */
  /** Estimated current conversation size vs the active model's context window. */
  private computeContext(): { tokens: number; window: number } {
    const tokens = estimateMessagesTokens(this.history);
    let window = this.lastWindow;
    if (!window) {
      const top = this.deps.settings.enabledByPriority()[0];
      const m = top ? this.deps.catalog.find(top.platform, top.modelId) : undefined;
      window = m?.contextWindow ?? 32768;
    }
    return { tokens, window };
  }

  private rememberWindow(platform?: string, model?: string): void {
    if (!platform || !model) return;
    const w = this.deps.catalog.find(platform, model)?.contextWindow;
    if (w && w > 0) this.lastWindow = w;
  }

  /** Auto-summarize when the conversation passes the configured fraction of the window. */
  private async maybeAutoCompact(): Promise<void> {
    const threshold = vscode.workspace.getConfiguration('tiermux.agent').get<number>('autoCompactThreshold', 0.8);
    if (!threshold || threshold <= 0 || this.history.length < 6) return;
    const { tokens, window } = this.computeContext();
    if (window && tokens > window * threshold) await this.handleCompact();
  }

  /** Best-effort: ask a free LLM for a short title once we have a first exchange. */
  /** Best-effort: ask a free LLM for a short title from the user's first message. */
  private async maybeGenerateTitle(): Promise<void> {
    if (this.titleGenerated) return;
    const firstUser = this.transcript.find((t) => t.role === 'user');
    if (!firstUser) return;
    this.titleGenerated = true; // guard before the call to avoid duplicate runs
    try {
      // Generate from the user's message alone, right when they send it (e.g. "hi" -> "Greetings").
      const snippet = `User's message: ${(firstUser.text ?? '').slice(0, 800)}`;
      const result = await this.deps.router.route(
        [
          { role: 'system', content: TITLE_SYSTEM },
          { role: 'user', content: snippet },
        ],
        { temperature: 0.3, max_tokens: 32 },
      );
      const title = contentToString(result.response.choices[0]?.message.content)
        .trim()
        .replace(/^["'`]+|["'`.]+$/g, '') // strip surrounding quotes / trailing punctuation
        .slice(0, 80);
      if (title) {
        this.sessionTitle = title;
        this.persist();
      }
    } catch {
      // Title generation is best-effort; fall back to the derived title silently.
    }
  }

  private persist(): void {
    const others = this.loadSessions().filter((s) => s.id !== this.sessionId);
    if (this.transcript.length) {
      others.unshift({ id: this.sessionId, title: this.sessionTitle ?? this.deriveTitle(), ts: Date.now(), history: this.history, transcript: this.transcript });
    }
    void this.deps.workspaceState.update(SESSIONS_KEY, others.slice(0, MAX_SESSIONS));
    void this.deps.workspaceState.update(CURRENT_KEY, this.sessionId);
    this.updateViewTitle();
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

  private post(msg: OutMessage): void {
    if (!this.view || !this.ready) { this.outQueue.push(msg); return; }
    void this.view.webview.postMessage(msg);
  }

  private flushQueue(): void {
    const queued = this.outQueue.splice(0);
    for (const m of queued) void this.view?.webview.postMessage(m);
  }

  /** Reveal the chat and submit a prompt programmatically (editor commands). */
  async submitExternal(text: string, mode: Mode): Promise<void> {
    await vscode.commands.executeCommand('tiermux.chat.focus');
    // Give the webview a moment to mount if it was just revealed.
    await new Promise((r) => setTimeout(r, 150));
    const requestId = `ext-${Date.now()}`;
    this.post({ type: 'userEcho', requestId, text });
    await this.handleSend({ type: 'sendMessage', requestId, text, mode, model: 'auto', reasoningEffort: 'off' });
  }

  newChat(): void {
    this.persist(); // save the current conversation into history first
    this.sessionId = this.newSessionId();
    this.history = [];
    this.transcript = [];
    this.sessionTitle = undefined;
    this.titleGenerated = false;
    this.deps.checkpoints.clear();
    void this.deps.workspaceState.update(CURRENT_KEY, this.sessionId);
    this.deps.usage.reset();
    this.post({ type: 'clear' });
    void this.sendConfig();
    this.updateViewTitle();
  }

  /** Re-push config to the webview (e.g. after an external settings change). */
  refresh(): void {
    void this.sendConfig();
  }

  /** Forward live index-build progress to the webview (shown only while building). */
  onIndexProgress(p: { building: boolean; done: number; total: number; phase: 'scanning' | 'embedding' | 'done' | 'error' }): void {
    this.post({ type: 'indexProgress', building: p.building, done: p.done, total: p.total, phase: p.phase });
    if (!p.building) void this.sendConfig(); // refresh the Context tab once the build settles
  }

  /** Open the Models/settings panel (from the native title-bar gear). */
  async toggleSettingsPanel(): Promise<void> {
    await vscode.commands.executeCommand('tiermux.chat.focus');
    this.post({ type: 'toggleSettings' });
  }

  /** Compact the conversation (from the native title bar). */
  async compact(): Promise<void> {
    await vscode.commands.executeCommand('tiermux.chat.focus');
    await this.handleCompact();
  }

  /** Browse past chats and reopen one (native QuickPick). */
  async showHistory(): Promise<void> {
    await vscode.commands.executeCommand('tiermux.chat.focus');
    this.persist(); // make sure the current chat is in the list
    const sessions = this.loadSessions();
    if (!sessions.length) { void vscode.window.showInformationMessage('No chat history yet.'); return; }

    const qp = vscode.window.createQuickPick<HistoryItem>();
    qp.title = 'Chat History';
    qp.placeholder = 'Select a chat to reopen';
    const edit = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Rename' };
    const trash = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete' };
    const toItems = (list: ChatSession[]): HistoryItem[] => list.map((s) => ({
      label: (s.id === this.sessionId ? '$(circle-filled) ' : '') + s.title,
      description: `${timeAgo(s.ts)} · ${s.transcript.filter((t) => t.role === 'user').length} msgs`,
      sessionId: s.id,
      buttons: [edit, trash],
    }));
    qp.items = toItems(sessions);
    qp.onDidAccept(() => { const sel = qp.selectedItems[0]; if (sel) this.openSession(sel.sessionId); qp.hide(); });
    qp.onDidTriggerItemButton(async (e) => {
      if (e.button === edit) {
        const cur = this.loadSessions().find((x) => x.id === e.item.sessionId)?.title ?? '';
        const next = await vscode.window.showInputBox({ title: 'Rename chat', prompt: 'Rename chat', value: cur });
        if (next && next.trim()) {
          this.renameSession(e.item.sessionId, next.trim());
          qp.items = toItems(this.loadSessions());
        }
        return;
      }
      this.deleteSession(e.item.sessionId);
      qp.items = toItems(this.loadSessions());
      if (!qp.items.length) qp.hide();
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  /** Rename a stored session (also updates the live title if it's the current one). */
  private renameSession(id: string, title: string): void {
    const sessions = this.loadSessions();
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    s.title = title;
    void this.deps.workspaceState.update(SESSIONS_KEY, sessions);
    if (id === this.sessionId) {
      this.sessionTitle = title;
      this.updateViewTitle();
    }
  }

  /** Inline rename of the current session from the webview header. */
  private handleRenameSession(title: string): void {
    const t = title.trim();
    if (!t || t === (this.sessionTitle ?? this.deriveTitle())) return;
    this.sessionTitle = t;
    this.persist(); // saves + pushes the new title to chrome and webview header
  }

  private openSession(id: string): void {
    if (id === this.sessionId) return;
    this.persist();
    const s = this.loadSessions().find((x) => x.id === id);
    if (!s) return;
    this.sessionId = s.id;
    this.history = s.history ?? [];
    this.transcript = s.transcript ?? [];
    this.sessionTitle = s.title;
    this.titleGenerated = true;
    void this.deps.workspaceState.update(CURRENT_KEY, this.sessionId);
    this.deps.usage.reset();
    this.post({ type: 'restore', messages: this.transcript });
    void this.sendConfig();
    this.updateViewTitle();
  }

  private deleteSession(id: string): void {
    void this.deps.workspaceState.update(SESSIONS_KEY, this.loadSessions().filter((s) => s.id !== id));
    if (id === this.sessionId) {
      this.sessionId = this.newSessionId();
      this.history = [];
      this.transcript = [];
      this.sessionTitle = undefined;
      this.titleGenerated = false;
      void this.deps.workspaceState.update(CURRENT_KEY, this.sessionId);
      this.post({ type: 'clear' });
      this.updateViewTitle();
    }
  }

  private async onMessage(m: InMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.flushQueue();
        await this.sendConfig();
        if (this.transcript.length) this.post({ type: 'restore', messages: this.transcript });
        break;
      case 'requestConfig':
        await this.sendConfig();
        break;
      case 'sendMessage':
        await this.handleSend(m);
        break;
      case 'approvePlan':
        await this.handleApprovePlan(m);
        break;
      case 'answerClarifying':
        await this.handleAnswerClarifying(m);
        break;
      case 'renameSession':
        this.handleRenameSession(m.title);
        break;
      case 'cancel':
        this.cancel?.cancel();
        this.pendingClarify = undefined;
        this.pendingPlanUser = undefined;
        break;
      case 'vote': {
        const ctx = this.voteCtx.get(m.requestId);
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
      case 'attachFromWorkspace':
        await this.attachFromWorkspace();
        break;
      case 'addSelection':
        await this.addSelectionToChat();
        break;
      case 'mentionQuery':
        await this.handleMentionQuery(m);
        break;
      case 'compact':
        await this.handleCompact();
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
      case 'searchMcpRegistry':
        try {
          const items = await searchRemoteMcp(m.query);
          this.post({ type: 'mcpRegistryResults', queryId: m.queryId, items });
        } catch (e) {
          this.post({ type: 'mcpRegistryResults', queryId: m.queryId, items: [], error: e instanceof Error ? e.message : String(e) });
        }
        break;
      case 'buildIndex':
        await this.deps.index.build();
        await this.sendConfig();
        break;
      case 'clearIndex':
        await this.deps.index.clear();
        await this.sendConfig();
        break;
      case 'restoreCheckpoint':
        await this.handleRestoreCheckpoint(m.id);
        break;
      case 'diffCheckpointFile':
        await this.deps.checkpoints.openDiff(m.id, m.uri);
        break;
      case 'revertTo':
        await this.handleRevertTo(m.requestId);
        break;
      case 'copyText':
        await vscode.env.clipboard.writeText(m.text);
        break;
      case 'setEmbeddingsEnabled':
        await vscode.workspace.getConfiguration('tiermux.embeddings').update('enabled', m.enabled, vscode.ConfigurationTarget.Global);
        await this.sendConfig();
        break;
      case 'setEmbeddingsProvider':
        await vscode.workspace.getConfiguration('tiermux.embeddings').update('provider', m.provider, vscode.ConfigurationTarget.Global);
        await this.sendConfig();
        break;
      case 'newChat':
        this.newChat();
        break;
    }
  }

  private async attachFromWorkspace(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach' });
    if (!picked) return;
    for (const uri of picked) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = new TextDecoder().decode(bytes.slice(0, 60 * 1024));
        const attachment: Attachment = { kind: 'file', name: vscode.workspace.asRelativePath(uri), text };
        this.post({ type: 'attachmentAdded', attachment });
      } catch (e) {
        this.post({ type: 'error', message: `Could not read ${uri.fsPath}: ${e instanceof Error ? e.message : e}` });
      }
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
      entry = { url: item.url, ...(Object.keys(headers).length ? { headers } : {}) };
    } else {
      const env: Record<string, string> = {};
      for (const e of item.env ?? []) {
        const val = await vscode.window.showInputBox({ prompt: `${item.name}: ${e.label ?? e.key}`, password: !!e.password, ignoreFocusOut: true });
        if (val === undefined) return; // cancelled
        if (val) env[e.key] = val;
      }
      entry = { command: item.command, args: item.args, ...(Object.keys(env).length ? { env } : {}) };
    }

    const cfg = vscode.workspace.getConfiguration('tiermux');
    const servers: Record<string, unknown> = { ...(cfg.get<Record<string, unknown>>('mcpServers') ?? {}) };
    servers[item.id] = entry;
    await cfg.update('mcpServers', servers, vscode.ConfigurationTarget.Global);
    await this.deps.mcp.reconnect();
    await this.sendConfig();
    void vscode.window.showInformationMessage(`Added MCP server "${item.name}". Edit details in settings.json if needed.`);
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

  private async handleCompact(): Promise<void> {
    if (this.history.length < 4) {
      this.post({ type: 'notice', text: 'Not enough conversation to compact yet.' });
      return;
    }
    this.post({ type: 'busy', busy: true });
    const before = this.deps.usage.get();
    try {
      const result = await this.deps.router.route(
        [
          { role: 'system', content: SUMMARY_SYSTEM },
          ...this.history,
          { role: 'user', content: 'Summarize the conversation so far so it can continue with minimal context.' },
        ],
        { temperature: 0.2, max_tokens: 1024 },
      );
      const summary = contentToString(result.response.choices[0]?.message.content).trim();
      if (!summary) { this.post({ type: 'notice', text: 'Compaction produced no summary; context unchanged.' }); return; }
      const priorTokens = this.history.length;
      this.history = [{ role: 'user', content: `Summary of the conversation so far:\n${summary}` }];
      this.persist();
      const after = this.deps.usage.get();
      this.post({ type: 'usageTotals', totals: { ...after, context: this.computeContext() } });
      this.post({ type: 'notice', text: `🗜 Context compacted — ${priorTokens} earlier messages summarized (+${after.totalTokens - before.totalTokens} tokens).` });
    } catch (e) {
      this.post({ type: 'error', message: `Compact failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      this.post({ type: 'busy', busy: false });
    }
  }

  private buildUserContent(text: string, contextText: string, attachments: Attachment[] | undefined): ChatContent {
    const fileBlocks = (attachments ?? [])
      .filter((a) => a.kind === 'file' && a.text)
      .map((a) => `Attached file \`${a.name}\`:\n\`\`\`\n${a.text}\n\`\`\``)
      .join('\n\n');
    const textParts = [text, contextText, fileBlocks].filter((s) => s && s.trim().length > 0).join('\n\n');

    const images = (attachments ?? []).filter((a) => a.kind === 'image' && a.dataUrl);
    if (images.length === 0) return textParts;
    // Multimodal envelope for vision models.
    return [
      { type: 'text', text: textParts },
      ...images.map((a) => ({ type: 'image_url', image_url: { url: a.dataUrl! } })),
    ];
  }

  private async handleSend(m: Extract<InMessage, { type: 'sendMessage' }>): Promise<void> {
    const slash = parseSlash(m.text);
    if (slash?.name === 'commit') {
      await this.deps.generateCommitMessage();
      this.post({ type: 'assistantMessage', requestId: m.requestId, text: 'Generated a commit message in the Source Control input.' });
      return;
    }
    let prompt = m.text;
    if (slash && SLASH_PROMPTS[slash.name]) prompt = `${SLASH_PROMPTS[slash.name]}\n\n${slash.rest}`;

    const contextText = await resolveMentions(prompt).catch(() => '');
    const userContent = this.buildUserContent(prompt, contextText, m.attachments);
    this.history.push({ role: 'user', content: userContent });
    this.transcript.push({ role: 'user', text: prompt, requestId: m.requestId, ts: Date.now() });
    void this.maybeGenerateTitle(); // title from the user's message right away (e.g. "hi" -> "Greetings")

    this.cancel?.dispose();
    this.cancel = new vscode.CancellationTokenSource();
    this.post({ type: 'busy', busy: true });
    const before = this.deps.usage.get();
    let announced = false;
    this.deps.checkpoints.begin(m.requestId, prompt.slice(0, 60));
    const sentAt = Date.now();

    try {
      const result = await this.deps.agent.run(this.history, m.mode as Mode, {
        model: m.model,
        reasoningEffort: m.reasoningEffort,
        token: this.cancel.token,
        onFailover: (i) => this.post({ type: 'failoverNotice', requestId: m.requestId, from: `${i.from.platform}/${i.from.modelId}`, reason: i.reason }),
      }, {
        onModel: (platform, model) => {
          if (!announced) { announced = true; this.post({ type: 'assistantStart', requestId: m.requestId, platform, model }); }
        },
        onTool: (e) => this.post({ type: 'toolStatus', requestId: m.requestId, toolCallId: e.toolCallId, name: e.name, args: e.args, state: e.state, detail: e.detail }),
        onStep: (phase, label) => this.post({ type: 'agentStep', requestId: m.requestId, phase, label }),
      });

      if (m.mode === 'plan') {
        const clar = parseClarifying(result.text);
        // Plan mode never commits the turn yet — the user turn is re-added on approval
        // (or after clarifying answers), so drop it now to avoid duplication later.
        this.history.pop();
        this.pendingPlanUser = userContent;
        if (clar.questions && clar.questions.length) {
          // The planner needs clarification before it can produce a good plan: surface
          // the questions as an interactive card, then re-plan with the answers.
          this.pendingClarify = { requestId: m.requestId, userContent, prompt, questions: clar.questions };
          this.post({ type: 'clarifyingQuestions', requestId: m.requestId, questions: clar.questions });
          return;
        }
        this.post({ type: 'planProposed', requestId: m.requestId, steps: clar.text });
        void this.savePlan(prompt, clar.text);
        return;
      }

      const after = this.deps.usage.get();
      const usage = { promptTokens: after.promptTokens - before.promptTokens, completionTokens: after.completionTokens - before.completionTokens, totalTokens: after.totalTokens - before.totalTokens };
      this.history.push({ role: 'assistant', content: result.text });
      this.transcript.push({ role: 'assistant', text: result.text, model: result.model ? `${result.platform}/${result.model}` : undefined, ts: Date.now(), secs: Math.max(0, Math.round((Date.now() - sentAt) / 1000)) });
      this.rememberWindow(result.platform, result.model);
      // Remember which (task kind, model) produced this reply so 👍/👎 can teach the router.
      if (result.taskKind && result.platform && result.model) {
        this.voteCtx.set(m.requestId, { taskKind: result.taskKind, platform: result.platform, model: result.model, last: 'none' });
      }
      this.post({ type: 'assistantMessage', requestId: m.requestId, text: result.text, reasoning: result.reasoning, usage, platform: result.platform, model: result.model });
      this.post({ type: 'usageTotals', totals: { ...after, context: this.computeContext() } });
    } catch (e) {
      this.post({ type: 'error', requestId: m.requestId, message: e instanceof Error ? e.message : String(e) });
      // Drop the user turn that produced no answer to keep history clean.
      if (this.history[this.history.length - 1]?.role === 'user') this.history.pop();
    } finally {
      await this.finishCheckpoint(m.requestId);
      this.persist();
      this.post({ type: 'busy', busy: false });
      await this.maybeAutoCompact();
      void this.maybeGenerateTitle();
    }
  }

  /** Commit the turn's checkpoint, then refresh the restore bar on every command. */
  private async finishCheckpoint(_requestId: string): Promise<void> {
    this.deps.checkpoints.commit();
    await this.postCheckpoints();
  }

  /**
   * Re-emit a checkpoint marker for every turn that captured edits. Each carries the
   * cumulative set of files that restoring "to before this message" would revert, so
   * earlier commands show a larger set than later ones (Cursor/Windsurf semantics).
   */
  private async postCheckpoints(): Promise<void> {
    for (const cp of this.deps.checkpoints.list()) {
      const files = await this.deps.checkpoints.changedFiles(cp.id);
      this.post({ type: 'checkpoint', requestId: cp.requestId, id: cp.id, files });
    }
  }

  /**
   * "Revert to here": roll the workspace back to before a command, drop that command
   * and every later turn, and put its text back in the composer (Cursor/Windsurf style).
   */
  private async handleRevertTo(requestId: string): Promise<void> {
    const idx = this.transcript.findIndex((t) => t.role === 'user' && t.requestId === requestId);
    if (idx < 0) return;
    const removedText = this.transcript[idx].text;
    const removedIds = this.transcript.slice(idx).filter((t) => t.role === 'user' && t.requestId).map((t) => t.requestId!);
    // The earliest checkpoint among removed turns reverts everything from here onward.
    let firstCpId: string | undefined;
    for (const rid of removedIds) { const cid = this.deps.checkpoints.idForRequest(rid); if (cid) { firstCpId = cid; break; } }
    const fileCount = firstCpId ? (await this.deps.checkpoints.changedFiles(firstCpId)).length : 0;

    const laterTurns = this.transcript.slice(idx).filter((t) => t.role === 'user').length;
    const detail = fileCount
      ? `${fileCount} changed file${fileCount > 1 ? 's' : ''} will be restored and ${laterTurns} message${laterTurns > 1 ? 's' : ''} removed.`
      : `${laterTurns} message${laterTurns > 1 ? 's' : ''} will be removed.`;
    const choice = await vscode.window.showWarningMessage(`Revert to this point? ${detail}`, { modal: true }, 'Revert');
    if (choice !== 'Revert') return;

    if (firstCpId) await this.deps.checkpoints.restore(firstCpId);
    this.deps.checkpoints.dropByRequestIds(removedIds);

    this.transcript = this.transcript.slice(0, idx);
    this.history = this.transcript.map((t) => ({ role: t.role, content: t.text }));

    this.post({ type: 'restore', messages: this.transcript });
    await this.postCheckpoints();
    this.post({ type: 'setInput', text: removedText });
    if (fileCount) this.post({ type: 'notice', text: `⟲ Reverted ${fileCount} file${fileCount !== 1 ? 's' : ''} to this point.` });
    this.persist();
  }

  private async handleRestoreCheckpoint(id: string): Promise<void> {
    const files = await this.deps.checkpoints.changedFiles(id);
    if (!files.length) {
      this.post({ type: 'notice', text: 'Nothing to restore — the workspace already matches this point.' });
      return;
    }
    const plural = files.length > 1;
    const choice = await vscode.window.showWarningMessage(
      `Restore the workspace to before this message? ${files.length} file${plural ? 's' : ''} edited since then will be reverted.`,
      { modal: true },
      'Restore',
    );
    if (choice !== 'Restore') return;
    const n = await this.deps.checkpoints.restore(id);
    this.post({ type: 'notice', text: `⟲ Restored ${n} file${n !== 1 ? 's' : ''} to before this message.` });
    await this.postCheckpoints();
  }

  /** Persist a proposed plan as a visible markdown checklist file in the workspace. */
  private async savePlan(title: string, steps: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('tiermux.plan');
    if (!cfg.get<boolean>('saveToFile', true)) return;
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return;
    const folder = (cfg.get<string>('folder', 'tiermux/plans') || 'tiermux/plans').replace(/^[\\/]+|[\\/]+$/g, '');
    const clean = (title || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'plan';
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
    const dir = vscode.Uri.joinPath(ws.uri, ...folder.split('/'));
    const fileUri = vscode.Uri.joinPath(dir, `${stamp}-${clean}.md`);
    // Turn list lines into a checklist so progress is trackable.
    const checklist = steps.split('\n').map((line) => {
      const mm = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
      return mm ? `- [ ] ${mm[1]}` : line;
    }).join('\n');
    const body = `# Plan: ${title || 'Untitled'}\n\n_Generated by ${PRODUCT_NAME} · ${d.toLocaleString()}_\n\n${checklist}\n`;
    try {
      await vscode.workspace.fs.createDirectory(dir);
      await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(body));
      this.post({ type: 'notice', text: `📄 Plan saved to ${vscode.workspace.asRelativePath(fileUri)}` });
    } catch (e) {
      this.post({ type: 'notice', text: `Could not save plan file: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private pendingPlanUser?: ChatContent;
  /** A Plan-mode run that paused to ask clarifying questions; resumed on answerClarifying. */
  private pendingClarify?: { requestId: string; userContent: ChatContent; prompt: string; questions: ClarifyingQuestion[] };
  /** LLM-generated title for the current session (falls back to deriveTitle until set). */
  private sessionTitle?: string;
  /** Guards a single title-generation attempt per session. */
  private titleGenerated = false;

  private async handleApprovePlan(m: Extract<InMessage, { type: 'approvePlan' }>): Promise<void> {
    if (!m.approved) {
      this.pendingPlanUser = undefined;
      this.post({ type: 'assistantMessage', requestId: m.requestId, text: '_Plan discarded._' });
      return;
    }
    const original = this.pendingPlanUser;
    this.pendingPlanUser = undefined;
    if (original) this.history.push({ role: 'user', content: original });
    this.history.push({ role: 'user', content: `Execute this plan step by step:\n\n${m.steps}` });

    this.cancel?.dispose();
    this.cancel = new vscode.CancellationTokenSource();
    this.post({ type: 'busy', busy: true });
    const before = this.deps.usage.get();
    let announced = false;
    this.deps.checkpoints.begin(m.requestId, 'Plan execution');
    const sentAt = Date.now();
    try {
      const result = await this.deps.agent.run(this.history, 'agent', {
        token: this.cancel.token,
        onFailover: (i) => this.post({ type: 'failoverNotice', requestId: m.requestId, from: `${i.from.platform}/${i.from.modelId}`, reason: i.reason }),
      }, {
        onModel: (platform, model) => { if (!announced) { announced = true; this.post({ type: 'assistantStart', requestId: m.requestId, platform, model }); } },
        onTool: (e) => this.post({ type: 'toolStatus', requestId: m.requestId, toolCallId: e.toolCallId, name: e.name, args: e.args, state: e.state, detail: e.detail }),
        onStep: (phase, label) => this.post({ type: 'agentStep', requestId: m.requestId, phase, label }),
      });
      const after = this.deps.usage.get();
      const usage = { promptTokens: after.promptTokens - before.promptTokens, completionTokens: after.completionTokens - before.completionTokens, totalTokens: after.totalTokens - before.totalTokens };
      this.history.push({ role: 'assistant', content: result.text });
      this.transcript.push({ role: 'assistant', text: result.text, model: result.model ? `${result.platform}/${result.model}` : undefined, ts: Date.now(), secs: Math.max(0, Math.round((Date.now() - sentAt) / 1000)) });
      this.rememberWindow(result.platform, result.model);
      // Remember which (task kind, model) produced this reply so 👍/👎 can teach the router.
      if (result.taskKind && result.platform && result.model) {
        this.voteCtx.set(m.requestId, { taskKind: result.taskKind, platform: result.platform, model: result.model, last: 'none' });
      }
      this.post({ type: 'assistantMessage', requestId: m.requestId, text: result.text, reasoning: result.reasoning, usage, platform: result.platform, model: result.model });
      this.post({ type: 'usageTotals', totals: { ...after, context: this.computeContext() } });
    } catch (e) {
      this.post({ type: 'error', requestId: m.requestId, message: e instanceof Error ? e.message : String(e) });
    } finally {
      await this.finishCheckpoint(m.requestId);
      this.persist();
      this.post({ type: 'busy', busy: false });
      await this.maybeAutoCompact();
      void this.maybeGenerateTitle();
    }
  }

  /** Resume a paused Plan-mode run after the user answers its clarifying questions. */
  private async handleAnswerClarifying(m: Extract<InMessage, { type: 'answerClarifying' }>): Promise<void> {
    const ctx = (this.pendingClarify && this.pendingClarify.requestId === m.requestId) ? this.pendingClarify : undefined;
    this.pendingClarify = undefined;
    if (!ctx) return; // stale submission (e.g. after a cancel) — ignore

    // Fold the answers into the prompt and re-run Plan mode for a real plan.
    const qa = ctx.questions
      .map((q, i) => `Q: ${q.text}\nA: ${m.answers[i] ?? '(no answer)'}`)
      .join('\n');
    const base = this.history.length;
    this.history.push({ role: 'user', content: ctx.userContent });
    this.history.push({ role: 'user', content: `Clarifications from the user:\n${qa}\n\nUsing these answers, produce the step-by-step plan now.` });

    this.cancel?.dispose();
    this.cancel = new vscode.CancellationTokenSource();
    this.post({ type: 'busy', busy: true });
    let announced = false;
    this.deps.checkpoints.begin(m.requestId, 'Plan (clarified)');
    try {
      const result = await this.deps.agent.run(this.history, 'plan', {
        token: this.cancel.token,
        onFailover: (i) => this.post({ type: 'failoverNotice', requestId: m.requestId, from: `${i.from.platform}/${i.from.modelId}`, reason: i.reason }),
      }, {
        onModel: (platform, model) => { if (!announced) { announced = true; this.post({ type: 'assistantStart', requestId: m.requestId, platform, model }); } },
        onStep: (phase, label) => this.post({ type: 'agentStep', requestId: m.requestId, phase, label }),
      });
      // Ignore any further questions block on this pass — go straight to a proposed plan.
      const clar = parseClarifying(result.text);
      this.post({ type: 'planProposed', requestId: m.requestId, steps: clar.text });
      void this.savePlan(ctx.prompt, clar.text);
      // pendingPlanUser (set in handleSend) stays for the subsequent Approve flow.
    } catch (e) {
      this.post({ type: 'error', requestId: m.requestId, message: e instanceof Error ? e.message : String(e) });
    } finally {
      // Drop the clarify turns we added; the user turn is re-added on approval via pendingPlanUser.
      this.history.length = base;
      await this.finishCheckpoint(m.requestId);
      this.persist();
      this.post({ type: 'busy', busy: false });
      await this.maybeAutoCompact();
      void this.maybeGenerateTitle();
    }
  }

  private async sendConfig(): Promise<void> {
    if (!this.view) return;
    const snap = await this.deps.secrets.snapshot();
    const endpoints = this.deps.settings.getEndpoints();
    const platforms: KeyStatusInfo[] = snap.map((s) => {
      const info = getPlatformInfo(s.platform);
      return {
        platform: s.platform,
        name: info?.name ?? s.platform,
        configured: s.configured,
        keyless: s.keyless,
        status: s.status,
        keyUrl: info?.keyUrl,
        defaultBaseUrl: info?.defaultBaseUrl ?? '',
        endpoint: endpoints[s.platform],
      };
    });
    // include the 'custom' platform row for advanced users
    const custom = allPlatformInfo().find((p) => p.platform === 'custom');
    if (custom) {
      platforms.push({ platform: 'custom', name: custom.name, configured: !!endpoints['custom'], keyless: false, status: 'unknown', defaultBaseUrl: custom.defaultBaseUrl, endpoint: endpoints['custom'] });
    }
    if (this.deps.mcp.hasServers()) { try { await this.deps.mcp.ensureStarted(); } catch { /* MCP optional */ } }
    await this.deps.index.load();
    const s = this.deps.index.stats();
    const embProvider = vscode.workspace.getConfiguration('tiermux.embeddings').get<string>('provider', 'google') as Platform;
    const embConfigured = !!getPlatformInfo(embProvider)?.keyless || !!(await this.deps.secrets.get(embProvider));
    const config: ConfigPayload = {
      catalog: this.deps.catalog.all(),
      fallback: this.deps.settings.getFallback(),
      platforms,
      mcp: this.deps.mcp.servers(),
      mcpRegistry: await this.registry(),
      index: { enabled: this.deps.index.isEnabled(), built: s.built, files: s.files, chunks: s.chunks, model: s.model, building: s.building, lastError: s.lastError, provider: embProvider, providerConfigured: embConfigured },
    };
    this.post({ type: 'config', config, usageTotals: { ...this.deps.usage.get(), context: this.computeContext() } });
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
  <link href="${uri('main.css')}" rel="stylesheet" nonce="${nonce}" />
  <title>${PRODUCT_NAME}</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">window.__PRODUCT_NAME__ = ${JSON.stringify(PRODUCT_NAME)};</script>
  <script nonce="${nonce}" src="${uri('vendor/marked.min.js')}"></script>
  <script nonce="${nonce}" src="${uri('vendor/highlight.min.js')}"></script>
  <script nonce="${nonce}" src="${uri('main.js')}"></script>
</body>
</html>`;
  }
}
