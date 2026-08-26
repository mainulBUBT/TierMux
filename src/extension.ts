import * as vscode from 'vscode';
import type { Platform, FallbackEntry, PlatformInfo } from './shared/types';
import { Catalog } from './catalog/catalog';
import { fetchAnnouncements, unnotifiedAnnouncements } from './catalog/announcements';
import { SecretStore } from './config/secrets';
import { SettingsStore } from './config/settingsStore';
import { UsageTracker } from './config/usage';
import { UsageStore } from './config/usageStore';
import { QuotaStore } from './config/quotaStore';
import { ModelStatsStore } from './config/modelStats';
import { SlowModelStore } from './config/slowModel';
import { Router, setSmartScoring } from './router/router';
import { setModelSources } from './router/picker';
import { MetricsStore } from './router/metricsStore';
import { ScoringEngine } from './router/scoring';
import { verifyGrounding, renderVerifyReport } from './backend/groundingVerify';
import { EditGate } from './edits/applyEdit';
import { CommandGate, type CommandApproval } from './edits/commandGate';
import { PersistentShellManager } from './edits/persistentShell';
import { registerCheckpointContentProvider } from './edits/checkpoints';

import { setGates } from './agent/core/tools/gates';
import { setMcpManager } from './agent/core/tools/mcp/manager';
import { setWorkspaceIndex } from './agent/core/tools/indexAccess';
import { WorkspaceIndex } from './indexer/WorkspaceIndex';

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

import { formatTelemetryReport, resetTelemetry, getSnapshot, onTelemetryUpdate } from './context/telemetry';
import { createProfiler, type IProfilerService } from './profiler/profilerService';
import { render as renderProfilerReport } from './profiler/outputRenderer';
import { toExportData as exportProfilerData } from './profiler/export';

let chatProviderRef: ChatViewProvider | undefined;
const ts = () => new Date().toISOString().slice(11, 23);

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
    const quotaStore = new QuotaStore(context.globalState);
    const modelStats = new ModelStatsStore(context.globalState);
    const slowModels = new SlowModelStore(context.globalState);
    const metrics = new MetricsStore(context.globalState);
    const scoring = new ScoringEngine(catalog, metrics, modelStats);
    const router = new Router(secrets, settings, catalog, usage, modelStats, usageStore, slowModels, metrics, scoring, quotaStore);

    // v3: the agent engine selects models through the thin picker (router/picker.ts), not the
    // scoring Router. The Router instance above stays alive for utility one-shot calls
    // (titles, commit messages, inline completions) until those migrate in v3.1.
    setModelSources({ catalog, settings, secrets });

    let profiler: IProfilerService = createProfiler(
      vscode.workspace.getConfiguration('tiermux.profiler').get<boolean>('enabled', false),
      vscode.workspace.getConfiguration('tiermux.profiler').get<number>('ringSize', 200),
    );

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tiermux.profiler.enabled') || e.affectsConfiguration('tiermux.profiler.ringSize')) {
          const enabled = vscode.workspace.getConfiguration('tiermux.profiler').get<boolean>('enabled', false);
          const ring = vscode.workspace.getConfiguration('tiermux.profiler').get<number>('ringSize', 200);
          profiler = createProfiler(enabled, ring);
        }
      }),
    );

    const editGate = new EditGate(() =>
      vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('requireWriteConfirmation', true),
    );
    context.subscriptions.push(editGate.register());


    setSmartScoring(vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('smartScoring', true));
    let scoringTraceOn = vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('scoringTrace', false);
    let routerLog: vscode.OutputChannel | undefined;
    /** Dev-facing trace channel for the Smart Auto scoring rationale (the engineLog pattern). */
    function getRouterLog(): vscode.OutputChannel {
      if (!routerLog) routerLog = vscode.window.createOutputChannel('TierMux Router');
      return routerLog;
    }
    function logRationale(taskKind: string, rationale: import('./router/scoring').RationaleEntry[]): void {
      if (!scoringTraceOn) return;
      const ch = getRouterLog();
      const win = rationale.find((r) => r.selected);
      ch.appendLine(`[${ts()}] Smart Auto · ${taskKind} → ${win ? `${win.platform}/${win.modelId}` : 'none'}`);
      for (const r of rationale) {
        const tag = r.selected ? '✓' : '·';
        const sig = `cap ${r.capability.toFixed(2)} · runtime ×${r.runtimeMultiplier.toFixed(2)} · pref ${r.userPreference.toFixed(2)} = ${r.score.toFixed(3)}`;
        ch.appendLine(`  ${tag} ${r.platform}/${r.modelId} — ${sig} — ${r.reason}`);
      }
    }
    router.setRationaleSink((info) => logRationale(info.taskKind, info.rationale));

    context.subscriptions.push(registerCheckpointContentProvider());

    const commandGate = new CommandGate(
      () => vscode.workspace.getConfiguration('tiermux.agent').get<CommandApproval>('commandApproval', 'always'),
      () => vscode.workspace.getConfiguration('tiermux.agent').get<number>('commandTimeoutMs', 120000),
      () => vscode.workspace.getConfiguration('tiermux.agent').get<string[]>('commandAllowlist', []),
    );
    const shellManager = new PersistentShellManager();
    context.subscriptions.push({ dispose: () => shellManager.dispose() });
    commandGate.setShellManager(shellManager);
    const mcp = new McpManager();
    context.subscriptions.push({ dispose: () => mcp.dispose() });

    setGates(editGate, commandGate);
    setMcpManager(mcp);

    // In-memory workspace symbol + dependency index (lazy, watcher-maintained). Constructed here
    // like the other singletons; its FileSystemWatcher is disposed via context.subscriptions. Tools
    // read it through the module-scoped holder set just below. No scan at activation — lazy.
    const wsIndex = new WorkspaceIndex(() => ({
      enabled: vscode.workspace.getConfiguration('tiermux.index').get<boolean>('enabled', true),
      maxFiles: vscode.workspace.getConfiguration('tiermux.index').get<number>('maxFiles', 5000),
      excludes: vscode.workspace.getConfiguration('tiermux.index').get<string[]>('excludes', []),
    }));
    context.subscriptions.push(wsIndex.register());
    setWorkspaceIndex(wsIndex);

    const chat = new ChatViewProvider(context.extensionUri, {
      secrets,
      settings,
      catalog,
      usage,
      usageStore,
      router,
      mcp,
      modelStats,
      slowModels,
      workspaceState: context.workspaceState,
      globalState: context.globalState,
      generateCommitMessage: () => generateCommitMessage(router),
      profiler,
    });
    chatProviderRef = chat;

    editGate.setConfirmHandler((req) => chat.requestEditApproval(req));

    commandGate.setAutoApprove(() => chat.autoApprove);
    editGate.setAutoApprove(() => chat.autoApprove);

    context.subscriptions.push(watchGitCommits(() => { void chat.clearAllCheckpoints(); }));

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

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tiermux.mcpServers')) void mcp.reconnect().then(() => chat.refresh());
        if (e.affectsConfiguration('tiermux.agent.smartScoring')) {
          setSmartScoring(vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('smartScoring', true));
        }
        if (e.affectsConfiguration('tiermux.agent.scoringTrace')) {
          scoringTraceOn = vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('scoringTrace', false);
          if (scoringTraceOn) getRouterLog().show(true);
        }
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
      vscode.commands.registerCommand('tiermux.index.rebuild', () => {
        wsIndex.rebuild();
        void vscode.window.showInformationMessage('TierMux: Symbol & Dependency Index rebuilt.');
      }),

      vscode.commands.registerCommand('tiermux.verifyGrounding', async () => {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) { void vscode.window.showErrorMessage('No workspace folder open.'); return; }
        const report = await verifyGrounding(router, wsRoot);
        const channel = vscode.window.createOutputChannel('TierMux Grounding Verify');
        channel.show(true);
        channel.appendLine(`Workspace: ${wsRoot}`);
        channel.appendLine('');
        channel.appendLine(renderVerifyReport(report));
        void vscode.window.showInformationMessage(`Grounding verify: ${report.ok ? 'PASS' : 'FAIL'} (${report.passed}/${report.total} questions passed)`);
      }),

      vscode.commands.registerCommand('tiermux.showProfiler', () => {
        const channel = vscode.window.createOutputChannel('TierMux Profiler');
        channel.clear();
        channel.appendLine(renderProfilerReport(profiler.getReportData()));
        channel.show(true);
      }),
      vscode.commands.registerCommand('tiermux.copyProfilerSummary', () => {
        void vscode.env.clipboard.writeText(profiler.getSummary());
        void vscode.window.showInformationMessage('TierMux Profiler: summary copied to clipboard.');
      }),
      vscode.commands.registerCommand('tiermux.exportProfiler', async () => {
        const uri = await vscode.window.showSaveDialog({
          filters: { 'JSON Files': ['json'] },
          defaultUri: vscode.Uri.file('tiermux-profiler-trace.json'),
        });
        if (uri) {
          const fs = await import('fs');
          fs.writeFileSync(uri.fsPath, JSON.stringify(exportProfilerData(profiler), null, 2), 'utf8');
          void vscode.window.showInformationMessage(`TierMux Profiler: exported to ${uri.fsPath}`);
        }
      }),
      vscode.commands.registerCommand('tiermux.resetProfiler', async () => {
        const confirm = await vscode.window.showWarningMessage(
          'Reset all profiler traces and statistics?', { modal: true },
          'Reset',
        );
        if (confirm === 'Reset') {
          profiler.reset();
          void vscode.window.showInformationMessage('TierMux Profiler: all traces cleared.');
        }
      }),
    );


    context.subscriptions.push(
      ...registerEditorCommands(chat),
      ...registerCodeActions(chat),
      registerInlineChat(router, editGate),
      ...registerInlineCompletions(router, catalog, settings),
      registerCommitMessage(router),
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
  // Router.route() directly, in-process.
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

