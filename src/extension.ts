import * as vscode from 'vscode';
import type { Platform, FallbackEntry, PlatformInfo } from './shared/types';
import { Catalog } from './catalog/catalog';
import { fetchAnnouncements, unnotifiedAnnouncements } from './catalog/announcements';
import { SecretStore } from './config/secrets';
import { SettingsStore } from './config/settingsStore';
import { UsageTracker } from './config/usage';
import { UsageStore } from './config/usageStore';
import { ModelStatsStore } from './config/modelStats';
import { QuotaStore } from './config/quotaStore';
import { setModelSources, setQuotaStore } from './router/picker';
import { verifyGrounding, renderVerifyReport } from './backend/groundingVerify';
import { EditGate } from './edits/applyEdit';
import { registerCheckpointContentProvider } from './edits/checkpoints';

import { setMcpManager } from './agent/core/tools/mcp/manager';

import { McpManager } from './mcp/mcpManager';
import { ChatViewProvider } from './chatViewProvider';
import { allPlatformInfo, getPlatformInfo } from './providers';
import { registerEditorCommands } from './editor/commands';
import { registerCodeActions } from './editor/codeActions';
import { registerInlineChat } from './editor/inlineChat';
import { registerInlineCompletions } from './completions/inlineCompletion';
import { registerCommitMessage, generateCommitMessage } from './scm/commitMessage';
import { watchGitCommits } from './scm/gitWatch';
import { openMemoryForEdit } from './context/userMemory';
import { invalidateSkillsCache } from './context/skills';
import { installSkillPackage, checkNpxAvailable } from './context/skillInstaller';

let chatProviderRef: ChatViewProvider | undefined;

/** Shows a one-time notification for newly-discovered catalog models, grouped by
 *  provider, with a button that jumps straight to the model-enable settings panel. */
function notifyNewModels(entries: FallbackEntry[]): void {
  const byPlatform = new Map<Platform, number>();
  for (const e of entries) byPlatform.set(e.platform, (byPlatform.get(e.platform) ?? 0) + 1);
  const providerList = [...byPlatform.keys()].map((p) => getPlatformInfo(p)?.name ?? p);

  const message = entries.length === 1
    ? `${providerList[0]} added a new model: ${entries[0].modelId}. Go to Settings to enable it.`
    : `${entries.length} new models added (${providerList.join(', ')}). Go to Settings to enable them.`;

  void vscode.window.showInformationMessage(message, 'Manage Models')
    .then((choice) => { if (choice === 'Manage Models') void vscode.commands.executeCommand('tiermux.openModelSettings'); });
  chatProviderRef?.postNewModels(message);
}

/** Shows a one-time notification for providers newly registered from the remote catalog,
 *  mirroring notifyNewModels. Jumps to Settings so the user can add a key / enable it. */
function notifyNewProviders(entries: PlatformInfo[]): void {
  const names = entries.map((p) => p.name);
  const message = entries.length === 1
    ? `New provider available: ${names[0]}. Go to Settings to add its API key and enable it.`
    : `${entries.length} new providers available (${names.join(', ')}). Go to Settings to enable them.`;

  void vscode.window.showInformationMessage(message, 'Manage Providers')
    .then((choice) => { if (choice === 'Manage Providers') void vscode.commands.executeCommand('tiermux.openModelSettings'); });
  chatProviderRef?.postNewProviders(message);
}

/** Toast for an announcement the user hasn't been told about yet (items arrive newest-first,
 *  so the caller passes the head of the list). View jumps to the Tips & Announcements page. */
function notifyNewAnnouncement(title: string): void {
  void vscode.window.showInformationMessage(`New announcement: ${title}`, 'View')
    .then((choice) => { if (choice === 'View') void vscode.commands.executeCommand('tiermux.showAnnouncements'); });
}

/** Quiet toast when a refresh dropped models the worker no longer serves, so a provider
 *  quietly retiring its free tier doesn't look like models vanishing for no reason. */
function notifyRemovedModels(keys: string[]): void {
  const sample = keys.slice(0, 5).join(', ') + (keys.length > 5 ? `, +${keys.length - 5} more` : '');
  void vscode.window.showInformationMessage(`TierMux removed ${keys.length} retired model${keys.length === 1 ? '' : 's'}: ${sample}`);
}

export function activate(context: vscode.ExtensionContext): void {
  const extensionPath = context.extensionUri.fsPath;

  try {
    const catalog = new Catalog(extensionPath);
    catalog.loadCached(context.globalState, vscode.workspace.getConfiguration('tiermux').get<string>('catalog.url', ''));
    const secrets = new SecretStore(context.secrets);
    const settings = new SettingsStore(context.globalState, catalog);
    if (context.globalState.get('tiermux.notifiedModels') === undefined) {
      settings.seedNotifiedModels(); // first run of this feature: don't notify about the whole existing catalog
    }
    if (context.globalState.get('tiermux.notifiedProviders') === undefined) {
      settings.seedNotifiedProviders(); // first run: don't notify about the whole built-in provider registry
    }
    context.subscriptions.push(
      catalog.onDidChange(() => {
        const fresh = settings.checkForNewModels();
        if (fresh.length) notifyNewModels(fresh);
        const freshProviders = settings.checkForNewProviders();
        if (freshProviders.length) notifyNewProviders(freshProviders);
      }),
    );

    // Remote catalog + announcements sync, once per window (VS Code or fork) at startup —
    // no periodic timer; reopening/reloading the editor is the refresh trigger. refresh()
    // reconciles wholesale (new rows added, vanished rows dropped) and no-ops on any network
    // failure, keeping the cached list; toasts only fire when something actually changed.
    const backgroundCatalogSync = async (): Promise<void> => {
      const url = vscode.workspace.getConfiguration('tiermux').get<string>('catalog.url', '');
      const report = await catalog.refresh(url, context.globalState);
      if (report?.removed.length) notifyRemovedModels(report.removed);
      const ann = await fetchAnnouncements(url);
      if (ann) {
        chatProviderRef?.postAnnouncements(ann.items, ann.lastUpdated);
        const fresh = unnotifiedAnnouncements(context.globalState, ann.items);
        if (fresh.length) notifyNewAnnouncement(fresh[0].title || 'Untitled');
      }
    };
    void backgroundCatalogSync();
    const usage = new UsageTracker();
    const usageStore = new UsageStore(context.globalState);
    const modelStats = new ModelStatsStore(context.globalState);

    setModelSources({ catalog, settings, secrets });
    // Declared rpm/rpd windows survive a reload (see picker.setQuotaStore).
    setQuotaStore(new QuotaStore(context.globalState));

    const editGate = new EditGate(() =>
      vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('requireWriteConfirmation', true),
    );
    context.subscriptions.push(editGate.register());

    // The Smart Auto scoring trace lived here (a "TierMux Router" output channel fed by
    // Router.setRationaleSink). It went with the scoring engine on 2026-09-05 — the v3 picker
    // publishes its own selection rationale to the "Why this model?" popover instead, which is
    // the same information in front of the user rather than in a dev channel.
    context.subscriptions.push(registerCheckpointContentProvider());

    const mcp = new McpManager();
    context.subscriptions.push({ dispose: () => mcp.dispose() });

    setMcpManager(mcp);

    const chat = new ChatViewProvider(context.extensionUri, {
      secrets,
      settings,
      catalog,
      usage,
      usageStore,
      mcp,
      modelStats,
      workspaceState: context.workspaceState,
      // storageUri is undefined with no folder open; those chats go under global storage.
      sessionDir: vscode.Uri.joinPath(context.storageUri ?? vscode.Uri.joinPath(context.globalStorageUri, 'no-workspace'), 'sessions').fsPath,
      globalState: context.globalState,
      generateCommitMessage: () => generateCommitMessage(),
    });
    chatProviderRef = chat;

    editGate.setConfirmHandler((req) => chat.requestEditApproval(req));

    editGate.setAutoApprove(() => chat.autoApprove);

    context.subscriptions.push(watchGitCommits(() => { void chat.clearAllCheckpoints(); }));

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tiermux.mcpServers')) void mcp.reconnect().then(() => chat.refresh());
        if (e.affectsConfiguration('tiermux.catalog')) {
          void backgroundCatalogSync();
        }
      }),
    );

    context.subscriptions.push(catalog.onDidChange(() => chat.refresh()));

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('tiermux.newChat', () => chat.newChat()),
      vscode.commands.registerCommand('tiermux.showHistory', () => chat.showHistory()),
      vscode.commands.registerCommand('tiermux.compactChat', () => chat.compact()),
      vscode.commands.registerCommand('tiermux.generateHandoff', () => chat.handoff()),
      vscode.commands.registerCommand('tiermux.openModelSettings', () => chat.toggleSettingsPanel()),
      vscode.commands.registerCommand('tiermux.showAnnouncements', () => chat.showAnnouncements()),
      vscode.commands.registerCommand('tiermux.setApiKey', (platformArg?: Platform) => setApiKey(secrets, platformArg)),
      vscode.commands.registerCommand('tiermux.clearApiKey', () => clearApiKey(secrets)),
      vscode.commands.registerCommand('tiermux.addSelectionToChat', () => chat.addSelectionToChat()),
      vscode.commands.registerCommand('tiermux.reconnectMcp', async () => { await mcp.reconnect(); void vscode.window.showInformationMessage('Reconnected MCP servers.'); }),
      vscode.commands.registerCommand('tiermux.refreshModels', async () => {
        const report = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'TierMux: refreshing model catalog from sheet…' },
          () => catalog.refresh(
            vscode.workspace.getConfiguration('tiermux').get<string>('catalog.url', ''),
            context.globalState,
          ),
        );
        chat.refresh();

        if (!report) {
          void vscode.window.showWarningMessage('TierMux: could not refresh model catalog (offline, bad URL, or invalid sheet format).');
          return;
        }

        if (!report.changed) {
          void vscode.window.showInformationMessage('TierMux: catalog already up to date with Google Sheet.');
          return;
        }

        const parts = [`+${report.added.length} added`, `−${report.removed.length} removed`];
        const choice = await vscode.window.showInformationMessage(
          `TierMux catalog refreshed from sheet: ${parts.join(', ')}.`,
          'Show Details',
          'Undo',
        );
        if (choice === 'Undo') {
          const ok = await catalog.undoSync(context.globalState);
          chat.refresh();
          void vscode.window.showInformationMessage(
            ok ? 'TierMux: catalog refresh undone.' : 'TierMux: nothing to undo.',
          );
        } else if (choice === 'Show Details') {
          const doc = await vscode.workspace.openTextDocument({
            language: 'markdown',
            content: [
              `# TierMux sheet catalog sync`, '',
              `## Added (${report.added.length})`, ...report.added.map((k) => `- ${k}`), '',
              `## Removed (${report.removed.length})`, ...report.removed.map((k) => `- ${k}`), '',
              `Carried over: ${report.updated}`,
            ].join('\n'),
          });
          await vscode.window.showTextDocument(doc, { preview: true });
        }
      }),
      vscode.commands.registerCommand('tiermux.editMemory', () => openMemoryForEdit()),
      vscode.commands.registerCommand('tiermux.addSkill', async () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { void vscode.window.showErrorMessage('TierMux: open a workspace folder first.'); return; }
        if (!(await checkNpxAvailable())) {
          void vscode.window.showErrorMessage(
            'TierMux: skill packages need Node.js (npx) on PATH. Install Node.js, then try again.',
            'Install Node.js',
          ).then((choice) => { if (choice === 'Install Node.js') void vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org/')); });
          return;
        }
        const source = await vscode.window.showInputBox({
          title: 'Add Skill from GitHub',
          prompt: 'Repo to install from (owner/repo or a full GitHub URL)',
          placeHolder: 'e.g. obra/superpowers',
        });
        if (!source) return;
        const skill = await vscode.window.showInputBox({
          title: 'Add Skill from GitHub',
          prompt: 'Specific skill name (leave blank to install all skills in the repo)',
          placeHolder: 'e.g. writing-plans',
        });
        const channel = vscode.window.createOutputChannel('TierMux Skills');
        channel.show(true);
        channel.appendLine(`$ npx skills add ${source}${skill ? ` --skill ${skill}` : ''} -y`);
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'TierMux: installing skill…' },
          () => installSkillPackage(root, source, skill || undefined, (chunk) => channel.append(chunk)),
        );
        if (result.ok) {
          invalidateSkillsCache(context.extensionUri.fsPath, root);
          const choice = await vscode.window.showInformationMessage(
            'TierMux: skill installed. Reload the window so the agent picks it up.',
            'Reload Window',
          );
          if (choice === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
        } else {
          void vscode.window.showErrorMessage('TierMux: skill install failed — see "TierMux Skills" output for details.');
        }
      }),
      vscode.commands.registerCommand('tiermux.verifyGrounding', async () => {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) { void vscode.window.showErrorMessage('No workspace folder open.'); return; }
        const report = await verifyGrounding(wsRoot);
        const channel = vscode.window.createOutputChannel('TierMux Grounding Verify');
        channel.show(true);
        channel.appendLine(`Workspace: ${wsRoot}`);
        channel.appendLine('');
        channel.appendLine(renderVerifyReport(report));
        void vscode.window.showInformationMessage(`Grounding verify: ${report.ok ? 'PASS' : 'FAIL'} (${report.passed}/${report.total} questions passed)`);
      }),
    );

    context.subscriptions.push(
      ...registerEditorCommands(chat),
      ...registerCodeActions(chat),
      registerInlineChat(editGate),
      ...registerInlineCompletions(catalog, settings),
      registerCommitMessage(),
    );
  } catch (error) {
    console.error('[tiermux] Extension activation failed:', error);
    void vscode.window.showErrorMessage(
      `TierMux failed to activate: ${error instanceof Error ? error.message : String(error)}. Check console for details.`
    );
  }
}

export function deactivate(): void {
  // No external engine process or router-proxy server to tear down anymore — the engine calls
  // Router.route() directly, in-process. Model cooldowns are deliberately NOT persisted here
  // (see picker.ts): a stale cooldown outliving the reload shadows a model that recovered.
}

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

  if (platform === 'cloudflare') {
    const existingAccountId = await secrets.getCloudflareAccountId();
    const accountPrompt = existingAccountId
      ? `Cloudflare Account ID (current: ${existingAccountId.slice(0, 8)}… — leave blank to keep, type to replace)`
      : 'Cloudflare Account ID';
    const accountId = await vscode.window.showInputBox({ prompt: accountPrompt, password: false, ignoreFocusOut: true, placeHolder: 'e.g. 1a2b3c4d5e6f7g8h9i0j' });
    if (accountId === undefined) return; // cancelled
    if (accountId.trim()) {
      await secrets.setCloudflareAccountId(accountId.trim());
    } else if (!existingAccountId) {
      void vscode.window.showWarningMessage('Cloudflare Account ID is required.');
      return;
    }

    const tokenPrompt = existing.length
      ? 'Replace Cloudflare API Token (blank = clear all keys)'
      : 'Set Cloudflare API Token (blank = cancel)';
    const token = await vscode.window.showInputBox({ prompt: tokenPrompt, password: true, ignoreFocusOut: true, placeHolder: 'Paste API token here' });
    if (token === undefined) return; // cancelled
    if (token.trim() === '') {
      if (existing.length) {
        await secrets.clear(platform);
        void vscode.window.showInformationMessage('Cleared Cloudflare API token(s).');
      }
      return;
    }
    const keys = token.split(/[\n,]+/).map((k) => k.trim()).filter(Boolean);
    await secrets.setKeys(platform, keys);
    const label = keys.length > 1 ? `${keys.length} tokens` : 'API token';
    void vscode.window.showInformationMessage(`Saved ${label} for Cloudflare Workers AI.`);
    return;
  }

  const basePrompt = `API key for ${info?.name ?? platform}`;
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
  if (picked.platform === 'cloudflare') await secrets.clearCloudflareAccountId();
  void vscode.window.showInformationMessage(`Cleared API key for ${picked.label}.`);
}

