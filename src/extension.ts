import * as vscode from 'vscode';
import type { Platform } from './shared/types';
import { Catalog } from './catalog/catalog';
import { SecretStore } from './config/secrets';
import { SettingsStore } from './config/settingsStore';
import { UsageTracker } from './config/usage';
import { UsageStore } from './config/usageStore';
import { ModelStatsStore } from './config/modelStats';
import { Router } from './router/router';
import { EditGate } from './edits/applyEdit';
import { CommandGate, type CommandApproval } from './edits/commandGate';
import { registerCheckpointContentProvider } from './edits/checkpoints';
import { WorkspaceTools } from './agent/tools';
import { Agent } from './agent/agent';
import { McpManager } from './mcp/mcpManager';
import { CodebaseIndex } from './index/codebaseIndex';
import { ChatViewProvider } from './chatViewProvider';
import { allPlatformInfo, getPlatformInfo } from './providers';
import { registerEditorCommands } from './editor/commands';
import { registerCodeActions } from './editor/codeActions';
import { registerInlineChat } from './editor/inlineChat';
import { registerInlineCompletions } from './completions/inlineCompletion';
import { registerCommitMessage, generateCommitMessage } from './scm/commitMessage';
import { openMemoryForEdit } from './context/userMemory';
// Pre-research modules (symbolIndex, invertedIndex, bundleCache, structuralGraph, repoMap)
// removed in v7.0 — superseded by OpenCode's `grep`/`glob`/LSP tools when
// `tiermux.useOpenCodeEngine` is true (the default). The file-watcher handlers
// that used to keep the inverted index in sync are no-ops now.
import { formatTelemetryReport, resetTelemetry, getSnapshot, onTelemetryUpdate } from './context/telemetry';
import { runBenchmarkCommand } from './bench/command';

export function activate(context: vscode.ExtensionContext): void {
  console.log('[tiermux-bench-debug] activate() STARTED');
  const catalog = new Catalog(context.extensionPath);
  catalog.loadCached(context.globalState);
  const secrets = new SecretStore(context.secrets);
  const settings = new SettingsStore(context.globalState, catalog);
  const usage = new UsageTracker();
  const usageStore = new UsageStore(context.globalState);
  const modelStats = new ModelStatsStore(context.globalState);
  const router = new Router(secrets, settings, catalog, usage, modelStats, usageStore);

  const editGate = new EditGate(() =>
    vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('requireWriteConfirmation', true),
  );
  context.subscriptions.push(editGate.register());

  // One shared checkpoint content provider for every session (VS Code allows one per scheme);
  // each ChatViewProvider session owns its own CheckpointManager data on top of it.
  context.subscriptions.push(registerCheckpointContentProvider());

  const commandGate = new CommandGate(
    () => vscode.workspace.getConfiguration('tiermux.agent').get<CommandApproval>('commandApproval', 'always'),
    () => vscode.workspace.getConfiguration('tiermux.agent').get<number>('commandTimeoutMs', 120000),
    () => vscode.workspace.getConfiguration('tiermux.agent').get<string[]>('commandAllowlist', []),
  );
  const tools = new WorkspaceTools(editGate, commandGate);
  const mcp = new McpManager();
  context.subscriptions.push({ dispose: () => mcp.dispose() });
  const index = new CodebaseIndex(context.globalStorageUri, secrets);
  const agent = new Agent(router, tools, mcp, index);

  const chat = new ChatViewProvider(context.extensionUri, {
    secrets,
    settings,
    catalog,
    usage,
    usageStore,
    router,
    mcp,
    index,
    tools,
    modelStats,
    workspaceState: context.workspaceState,
    generateCommitMessage: () => generateCommitMessage(router),
  });

  // File edits that don't come from a chat run (e.g. inline editor chat, which has no
  // session) fall back to a native Apply/Reject modal — the 1-arg overload returns
  // undefined so the EditGate opens the modal. Chat-run edits go through the per-run
  // RunContext instead (see ChatViewProvider.runContext).
  editGate.setConfirmHandler((req) => chat.requestEditApproval(req));
  // Session Auto-approve toggle (composer): both gates read it live to skip prompts.
  commandGate.setAutoApprove(() => chat.autoApprove);
  editGate.setAutoApprove(() => chat.autoApprove);

  // Stream index-build progress into the chat webview (transient "Indexing…" strip).
  index.onProgress((p) => chat.onIndexProgress(p));

  // Pre-research removed — OpenCode handles code intelligence via LSP/grep/glob.

  // Retrieval quality status bar item — bottom right, always visible.
  // Shows symbol/cache hit rate. Green ≥80%, orange ≥60%, red <60%.
  // Only renders after ≥3 requests so the number is meaningful.
  const telemetryBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  telemetryBar.command = 'tiermux.showTelemetry';
  context.subscriptions.push(telemetryBar);
  context.subscriptions.push({ dispose: onTelemetryUpdate(() => {
    const s = getSnapshot();
    if (s.totalRequests < 3) return; // not meaningful yet
    const hitRate = s.symbolHitRate + s.cacheHitRate; // combined: symbol OR cache resolved it
    const icon = hitRate >= 80 ? '$(zap)' : hitRate >= 60 ? '$(warning)' : '$(error)';
    const color = hitRate >= 80
      ? new vscode.ThemeColor('charts.green')
      : hitRate >= 60
        ? new vscode.ThemeColor('charts.yellow')
        : new vscode.ThemeColor('charts.red');
    telemetryBar.text = `${icon} ${hitRate}%`;
    telemetryBar.color = color;
    telemetryBar.tooltip = [
      `TierMux — Retrieval Quality (${s.totalRequests} requests)`,
      ``,
      `Symbol index : ${s.symbolHitRate}%  ${s.symbolHitRate >= 50 ? '✓' : '✗'} (target ≥50%)`,
      `Cache hits   : ${s.cacheHitRate}%`,
      `Grep calls   : ${s.grepRate}%  ${s.grepRate <= 20 ? '✓' : '✗'} (target <20%)`,
      ``,
      `Combined (no-grep): ${hitRate}%  ${hitRate >= 80 ? '✓ GOOD' : hitRate >= 60 ? '~ OK' : '✗ POOR'}`,
      `Click to see full report`,
    ].join('\n');
    telemetryBar.show();
  }) });

  // File-watcher for the embeddings index (still used by Agent fallback path).
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      void index.updateFile(doc.uri);
    }),
    // onDidDeleteFiles / onDidRenameFiles no longer touch the removed inverted index.
  );

  // Reconnect MCP servers when their configuration changes; refresh the panel
  // when embeddings/context settings change — and auto-build the index when it's
  // turned on (Cursor-style: no manual click needed once a provider key is set).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tiermux.mcpServers')) void mcp.reconnect().then(() => chat.refresh());
      if (e.affectsConfiguration('tiermux.embeddings') || e.affectsConfiguration('tiermux.context')) {
        chat.refresh();
        void index.maybeAutoBuild();
      }
      if (e.affectsConfiguration('tiermux.catalog')) {
        void catalog.refresh(
          vscode.workspace.getConfiguration('tiermux').get<string>('catalog.url', ''),
          context.globalState,
        );
      }
    }),
  );

  // Auto-build once a relevant API key is added (e.g. the embedding provider's).
  context.subscriptions.push(secrets.onDidChange(() => { void index.maybeAutoBuild(); }));

  // Kick off an automatic build on startup when already enabled + configured.
  void index.maybeAutoBuild();

  // One-time prompt: if embeddings is disabled and the user has a workspace open,
  // ask once whether they want to enable the semantic index for faster code search.
  void (async () => {
    const ASKED_KEY = 'tiermux.indexPromptShown';
    if (context.globalState.get<boolean>(ASKED_KEY)) return;
    if (index.isEnabled()) return;
    if (!vscode.workspace.workspaceFolders?.length) return;
    // Small delay so it doesn't fire immediately on first install.
    await new Promise(r => setTimeout(r, 4000));
    const pick = await vscode.window.showInformationMessage(
      'TierMux: Enable semantic codebase indexing for faster, smarter code search?',
      'Enable & Build', 'Not Now',
    );
    await context.globalState.update(ASKED_KEY, true);
    if (pick === 'Enable & Build') {
      await vscode.workspace.getConfiguration('tiermux.embeddings').update('enabled', true, vscode.ConfigurationTarget.Workspace);
      void index.build();
    }
  })();

  // Model catalog: fetch the published list in the background on every startup;
  // when it changes, refresh the chat view. Cached + bundled lists keep it
  // working offline (see Catalog).
  context.subscriptions.push(catalog.onDidChange(() => chat.refresh()));
  void catalog.refresh(
    vscode.workspace.getConfiguration('tiermux').get<string>('catalog.url', ''),
    context.globalState,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Commands ----------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('tiermux.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('tiermux.showHistory', () => chat.showHistory()),
    vscode.commands.registerCommand('tiermux.compactChat', () => chat.compact()),
    vscode.commands.registerCommand('tiermux.openModelSettings', () => chat.toggleSettingsPanel()),
    vscode.commands.registerCommand('tiermux.setApiKey', (platformArg?: Platform) => setApiKey(secrets, platformArg)),
    vscode.commands.registerCommand('tiermux.clearApiKey', () => clearApiKey(secrets)),
    vscode.commands.registerCommand('tiermux.manageSearchProviders', () => manageSearchProviders()),
    vscode.commands.registerCommand('tiermux.addSelectionToChat', () => chat.addSelectionToChat()),
    vscode.commands.registerCommand('tiermux.reconnectMcp', async () => { await mcp.reconnect(); void vscode.window.showInformationMessage('Reconnected MCP servers.'); }),
    vscode.commands.registerCommand('tiermux.clearIndex', async () => { await index.clear(); void vscode.window.showInformationMessage('Cleared codebase index.'); }),
    vscode.commands.registerCommand('tiermux.refreshModels', async () => {
      await catalog.refresh(
        vscode.workspace.getConfiguration('tiermux').get<string>('catalog.url', ''),
        context.globalState,
      );
      chat.refresh();
      void vscode.window.showInformationMessage('TierMux: model catalog refreshed.');
    }),
    vscode.commands.registerCommand('tiermux.editMemory', () => openMemoryForEdit()),
    vscode.commands.registerCommand('tiermux.showTelemetry', () => {
      const channel = vscode.window.createOutputChannel('TierMux Telemetry');
      channel.clear();
      channel.appendLine(formatTelemetryReport());
      channel.show(true);
    }),
    vscode.commands.registerCommand('tiermux.resetTelemetry', () => {
      resetTelemetry();
      void vscode.window.showInformationMessage('TierMux: telemetry counters reset.');
    }),
    vscode.commands.registerCommand('tiermux.buildGraph', async () => {
      void vscode.window.showInformationMessage('TierMux: code graph is no longer needed (OpenCode LSP handles it). This command is a no-op in v7.0+.');
    }),
    vscode.commands.registerCommand('tiermux.buildIndex', async () => {
      void vscode.window.showInformationMessage('TierMux: inverted index is no longer needed (OpenCode grep/glob handles it). This command is a no-op in v7.0+.');
    }),
    vscode.commands.registerCommand('tiermux.bench', () => {
      console.log('[tiermux-bench-debug] bench command INVOKED');
      return runBenchmarkCommand({ agent, router, catalog, index, globalStorageUri: context.globalStorageUri });
    }),
  );
  console.log('[tiermux-bench-debug] activate() COMPLETED — all commands registered');

  // Advanced features -------------------------------------------------------
  context.subscriptions.push(
    ...registerEditorCommands(chat),
    ...registerCodeActions(chat),
    registerInlineChat(router, editGate),
    ...registerInlineCompletions(router, catalog, settings),
    registerCommitMessage(router),
  );
}

export function deactivate(): void { /* no-op */ }

async function setApiKey(secrets: SecretStore, platformArg?: Platform): Promise<void> {
  let platform = platformArg;
  if (!platform) {
    const options = allPlatformInfo()
      .filter((p) => p.platform !== 'custom' && !p.keyless)
      .map((p) => ({ label: p.name, platform: p.platform }));
    const picked = await vscode.window.showQuickPick(options, { placeHolder: 'Select a provider to set its API key' });
    if (!picked) return;
    platform = picked.platform;
  }
  const info = getPlatformInfo(platform);
  if (info?.keyless) { void vscode.window.showInformationMessage(`${info.name} is keyless — no API key needed.`); return; }
  const existing = await secrets.getKeys(platform);
  const basePrompt = platform === 'cloudflare'
    ? 'Cloudflare key as "account_id:api_token"'
    : `API key for ${info?.name ?? platform}`;
  const multiHint = 'Separate multiple keys with a comma or newline for automatic rotation on rate-limit.';
  const prompt = `${existing.length ? 'Replace' : 'Set'} ${basePrompt} (blank = clear). ${multiHint}`;
  const key = await vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true });
  if (key === undefined) return; // cancelled
  if (key.trim() === '') {
    if (existing.length) {
      await secrets.clear(platform);
      void vscode.window.showInformationMessage(`Cleared API key(s) for ${info?.name ?? platform}.`);
    }
    return;
  }
  // Parse comma- or newline-separated key list.
  const keys = key.split(/[\n,]+/).map((k) => k.trim()).filter(Boolean);
  await secrets.setKeys(platform, keys);
  const label = keys.length > 1 ? `${keys.length} keys` : 'API key';
  void vscode.window.showInformationMessage(`Saved ${label} for ${info?.name ?? platform}.`);
}

async function clearApiKey(secrets: SecretStore): Promise<void> {
  const options = allPlatformInfo()
    .filter((p) => p.platform !== 'custom' && !p.keyless)
    .map((p) => ({ label: p.name, platform: p.platform }));
  const picked = await vscode.window.showQuickPick(options, { placeHolder: 'Select a provider to clear its API key' });
  if (!picked) return;
  await secrets.clear(picked.platform);
  void vscode.window.showInformationMessage(`Cleared API key for ${picked.label}.`);
}

// ---- Web search provider management (Exa, Brave, custom endpoint) ----

interface SearchProviderInfo {
  id: 'exa' | 'brave' | 'custom' | 'duckduckgo';
  name: string;
  keySetting: string;
  keyless?: boolean;
  freeTier?: string;
  signupUrl?: string;
}

const SEARCH_PROVIDERS: SearchProviderInfo[] = [
  {
    id: 'exa',
    name: 'Exa AI',
    keySetting: 'tiermux.tools.exaApiKey',
    freeTier: '1,000 searches/month',
    signupUrl: 'https://exa.ai',
  },
  {
    id: 'brave',
    name: 'Brave Search',
    keySetting: 'tiermux.tools.braveApiKey',
    freeTier: '2,000 queries/month',
    signupUrl: 'https://brave.com/search/api/',
  },
  {
    id: 'custom',
    name: 'Custom endpoint',
    keySetting: 'tiermux.tools.searchEndpoint',
    freeTier: 'Bring your own (SearXNG, etc.)',
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo (free)',
    keySetting: '',
    keyless: true,
    freeTier: 'Unlimited (but often rate-limited)',
  },
];

/** Show a quick-pick of web search providers with their current key status. */
async function manageSearchProviders(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('tiermux.tools');
  const priority = cfg.get<string>('searchProviderPriority', 'auto');

  const items = SEARCH_PROVIDERS.map((p) => {
    const hasKey = p.keyless || !!cfg.get<string>(p.keySetting.split('.').pop() ?? '', '').trim();
    const status = p.keyless ? '✓ Always available' : hasKey ? '✓ Key configured' : '✗ No key';
    const detail = p.keyless
      ? p.freeTier
      : `${p.freeTier} — ${hasKey ? 'key set' : 'click to set key'}`;
    return {
      label: `${status}  $(search)  ${p.name}`,
      description: priority === 'auto' ? '' : `[priority: ${p.id}]`,
      detail,
      provider: p,
      action: hasKey ? 'clear' : 'set',
    };
  });

  // Priority selector as the first item.
  const priorityOptions: Array<{ label: string; description: string; id: string }> = [
    { label: '$(rocket) Auto', description: 'Try Exa → Brave → custom → DuckDuckGo in order', id: 'auto' },
    { label: '$(search) Exa only', description: 'Requires tiermux.tools.exaApiKey', id: 'exa' },
    { label: '$(search) Brave only', description: 'Requires tiermux.tools.braveApiKey', id: 'brave' },
    { label: '$(search) Custom only', description: 'Requires tiermux.tools.searchEndpoint', id: 'custom' },
    { label: '$(search) DuckDuckGo only', description: 'Free, no key, often rate-limited', id: 'duckduckgo' },
  ];
  const priorityItem = {
    label: `$(settings) Priority: ${priority}`,
    description: 'Click to change which provider(s) are tried',
    providers: priorityOptions,
  };

  const picked = await vscode.window.showQuickPick(
    [{ label: '--- Providers ---', kind: -1 } as any, priorityItem as any, ...items as any],
    { placeHolder: 'Manage web search providers', title: 'TierMux — Web Search' },
  );
  if (!picked) return;

  // Priority selector
  if ((picked as any).providers) {
    const newPriority = await vscode.window.showQuickPick<{ label: string; description: string; id: string }>(
      (picked as any).providers,
      { placeHolder: 'Select search provider priority' },
    );
    if (newPriority) {
      await cfg.update('searchProviderPriority', newPriority.id, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(`TierMux: search priority set to "${newPriority.id}".`);
    }
    return;
  }

  // Set or clear a key
  const provider = (picked as any).provider as SearchProviderInfo;
  if (provider.keyless) {
    void vscode.window.showInformationMessage(`${provider.name} is keyless — no setup needed.`);
    return;
  }

  if ((picked as any).action === 'clear') {
    await cfg.update(provider.keySetting.split('.').pop() ?? '', '', vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`Cleared ${provider.name} key.`);
  } else {
    const key = await vscode.window.showInputBox({
      prompt: `Enter API key for ${provider.name} (${provider.freeTier})`,
      placeHolder: provider.signupUrl ? `Get one at ${provider.signupUrl}` : 'paste your key',
      password: true,
      ignoreFocusOut: true,
    });
    if (key && key.trim()) {
      await cfg.update(provider.keySetting.split('.').pop() ?? '', key.trim(), vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(`Saved ${provider.name} key.`);
    }
  }
}
