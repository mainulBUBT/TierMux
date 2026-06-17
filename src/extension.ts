import * as vscode from 'vscode';
import type { Platform } from './shared/types';
import { Catalog } from './catalog/catalog';
import { SecretStore } from './config/secrets';
import { SettingsStore } from './config/settingsStore';
import { UsageTracker } from './config/usage';
import { ModelStatsStore } from './config/modelStats';
import { Router } from './router/router';
import { EditGate } from './edits/applyEdit';
import { CommandGate, type CommandApproval } from './edits/commandGate';
import { CheckpointManager } from './edits/checkpoints';
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

export function activate(context: vscode.ExtensionContext): void {
  const catalog = new Catalog(context.extensionPath);
  const secrets = new SecretStore(context.secrets);
  const settings = new SettingsStore(context.globalState, catalog);
  const usage = new UsageTracker();
  const modelStats = new ModelStatsStore(context.globalState);
  const router = new Router(secrets, settings, catalog, usage, modelStats);

  const editGate = new EditGate(() =>
    vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('requireWriteConfirmation', true),
  );
  context.subscriptions.push(editGate.register());

  const checkpoints = new CheckpointManager();
  context.subscriptions.push(checkpoints.register());
  editGate.setRecorder((uri, before) => checkpoints.record(uri, before));

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
    agent,
    router,
    mcp,
    index,
    checkpoints,
    modelStats,
    workspaceState: context.workspaceState,
    generateCommitMessage: () => generateCommitMessage(router),
  });

  // Stream index-build progress into the chat webview (transient "Indexing…" strip).
  index.onProgress((p) => chat.onIndexProgress(p));

  // Incrementally re-embed an indexed file when it's saved.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => { void index.updateFile(doc.uri); }),
  );

  // Reconnect MCP servers when their configuration changes; refresh the panel
  // when embeddings/context settings change — and auto-build the index when it's
  // turned on (Cursor-style: no manual click needed once a provider key is set).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tiermux.mcpServers')) void mcp.reconnect();
      if (e.affectsConfiguration('tiermux.embeddings') || e.affectsConfiguration('tiermux.context')) {
        chat.refresh();
        void index.maybeAutoBuild();
      }
    }),
  );

  // Auto-build once a relevant API key is added (e.g. the embedding provider's).
  context.subscriptions.push(secrets.onDidChange(() => { void index.maybeAutoBuild(); }));

  // Kick off an automatic build on startup when already enabled + configured.
  void index.maybeAutoBuild();

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
    vscode.commands.registerCommand('tiermux.addSelectionToChat', () => chat.addSelectionToChat()),
    vscode.commands.registerCommand('tiermux.reconnectMcp', async () => { await mcp.reconnect(); void vscode.window.showInformationMessage('Reconnected MCP servers.'); }),
    vscode.commands.registerCommand('tiermux.buildIndex', () => index.build()),
    vscode.commands.registerCommand('tiermux.clearIndex', async () => { await index.clear(); void vscode.window.showInformationMessage('Cleared codebase index.'); }),
  );

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
  const prompt = platform === 'cloudflare' ? 'Cloudflare key as "account_id:api_token"' : `API key for ${info?.name ?? platform}`;
  const key = await vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true });
  if (!key) return;
  await secrets.set(platform, key.trim());
  void vscode.window.showInformationMessage(`Saved API key for ${info?.name ?? platform}.`);
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
