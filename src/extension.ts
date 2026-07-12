import * as vscode from 'vscode';
import type { Platform, FallbackEntry } from './shared/types';
import { Catalog } from './catalog/catalog';
import { SecretStore } from './config/secrets';
import { SettingsStore } from './config/settingsStore';
import { UsageTracker } from './config/usage';
import { UsageStore } from './config/usageStore';
import { ModelStatsStore } from './config/modelStats';
import { SlowModelStore } from './config/slowModel';
import { Router } from './router/router';
import { startRouterProxy } from './backend/routerProxy';
import { launchOpenCode, stopOpenCode, type OcConnection } from './backend/ocLauncher';
import { runBridgeDiagnostic, formatReport } from './backend/ocDiagnostics';
import { verifyGrounding, renderVerifyReport } from './backend/groundingVerify';
import { EditGate } from './edits/applyEdit';
import { CommandGate, type CommandApproval } from './edits/commandGate';
import { registerCheckpointContentProvider } from './edits/checkpoints';
import { registerOcSessionDiffContentProvider } from './edits/ocSessionDiff';

import { setOcEngine, setOcTrace, setQualityGate, setHotStandby, setHedging, setCompactionTailTurns } from './agent/sdk';
import { McpManager } from './mcp/mcpManager';
import { normalizeMcpServerConfig, type McpServerConfig } from './mcp/mcpClient';
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

let routerProxy: { baseURL: string; close(): void } | undefined;

let ocConnection: OcConnection | undefined;

let engineLog: vscode.OutputChannel | undefined;

let chatProviderRef: ChatViewProvider | undefined;
const ts = () => new Date().toISOString().slice(11, 23);

/** Global-state key: set once the engine has been confirmed working (download + a real
 *  chat round-trip succeeded). Onboarding progress/verification only runs before this is
 *  true — returning users get the old silent background startup. */
const ONBOARDED_KEY = 'tiermux.onboardedEngine';

/** One-shot safety net: if a fresh-install onboarding attempt fails and the user hasn't
 *  clicked Retry, try again automatically after a delay instead of leaving the engine
 *  dead until they notice. Only fires once per activation — a genuinely offline machine
 *  shouldn't get hammered with retries. */
let autoRetryScheduled = false;

/** Turn an ocBinary.ts/ocLauncher.ts onProgress(message, percent) call into an
 *  engineStatus post, inferring state from the message shape. */
function forwardEngineProgress(message: string, percent?: number): void {
  const state = /failed/i.test(message) ? 'error' : percent != null ? 'downloading' : 'starting';
  chatProviderRef?.postEngineStatus({ state, message, percent });
}

/** Lightweight end-to-end smoke test: does the router proxy actually route a completion
 *  through an enabled model? Used only during first-run onboarding to confirm chat/agent
 *  will really work, not just that the OC server process came up. */
async function verifyEngineWorks(routerProxyBaseURL: string): Promise<{ ok: boolean; detail?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${routerProxyBaseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'tiermux/fast',
        stream: false,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      }),
      signal: ctrl.signal,
    });
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => '');
    return { ok: false, detail: text || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

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

/** Reads `tiermux.mcpServers`, upgrading any legacy (pre-native-schema) entries on the fly. */
function readMcpServers(): Record<string, McpServerConfig> {
  const raw = vscode.workspace.getConfiguration('tiermux').get<Record<string, unknown>>('mcpServers', {}) ?? {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(raw)) {
    const normalized = normalizeMcpServerConfig(entry);
    if (normalized) out[name] = normalized;
  }
  return out;
}

/**
 * Reads `tiermux.engine.compaction` and returns the normalized camelCase shape the
 * engine-config path expects, or `undefined` to let OC fall back to its built-in
 * compaction defaults. Coerces garbage/clamped values so a malformed setting can't
 * break session creation (e.g. a non-positive tail_turns).
 */
function readCompactionSetting(): { auto: boolean; tailTurns: number; preserveRecentTokens: number; reserved: number } | undefined {
  const raw = vscode.workspace.getConfiguration('tiermux.engine').get<Record<string, unknown>>('compaction');
  if (!raw || typeof raw !== 'object') return undefined;
  const num = (v: unknown, dflt: number, min: number) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt;
    return Math.max(min, n);
  };
  return {
    auto: typeof raw.auto === 'boolean' ? raw.auto : true,
    tailTurns: num(raw.tailTurns, 12, 1),
    preserveRecentTokens: num(raw.preserveRecentTokens, 8000, 0),
    reserved: num(raw.reserved, 4096, 0),
  };
}

/**
 * Start the OC engine pointed at the router proxy. Logs the outcome; never throws
 * — a missing binary just means the integration stays off and the built-in agent runs.
 *
 * `globalState` is passed through only to read/write the ONBOARDED_KEY flag — before it's
 * set, progress/verification is also mirrored into the webview's onboarding bar; once set,
 * startup goes back to the old silent background behavior.
 */
let engineStartInFlight = false;

async function startOpenCodeEngine(
  extensionPath: string,
  routerProxyBaseURL: string,
  cacheDir: string,
  enabledModelIds: string[],
  mcpServers: Record<string, McpServerConfig>,
  globalState: vscode.Memento,
): Promise<void> {

  if (engineStartInFlight) return;
  engineStartInFlight = true;
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!engineLog) engineLog = vscode.window.createOutputChannel('TierMux Engine');
  const log = (msg: string) => engineLog?.appendLine(`[${ts()}] ${msg}`);
  log(`startOpenCodeEngine: proxy=${routerProxyBaseURL} cacheDir=${cacheDir}`);
  const onboarding = !globalState.get<boolean>(ONBOARDED_KEY, false);
  try {

    ocConnection = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Starting TierMux engine' },
      (progress) => launchOpenCode({
        extensionPath,
        routerProxyBaseURL,
        workspaceRoot,
        cacheDir,
        enabledModelIds,
        mcpServers,
        compaction: readCompactionSetting(),
        onProgress: (msg, percent) => {
          progress.report({ message: msg });
          if (onboarding) forwardEngineProgress(msg, percent);
        },
        log,
    }),
  );
    setOcEngine(ocConnection); // flip sdk.ts onto the OC path

    const traceSink = (raw: string) => engineLog?.appendLine(`[${ts()}] [oc-event] ${raw}`);
    setOcTrace(vscode.workspace.getConfiguration('tiermux.engine').get<boolean>('traceOcEvents', false), traceSink);
    setCompactionTailTurns(readCompactionSetting()?.tailTurns);
    log(`OpenCode engine UP at ${ocConnection.baseURL} (routing via ${routerProxyBaseURL})`);
    console.log(`[tiermux] OpenCode engine up at ${ocConnection.baseURL} (routing via ${routerProxyBaseURL})`);

    if (onboarding) {

      if (enabledModelIds.length === 0) {
        await globalState.update(ONBOARDED_KEY, true);
        chatProviderRef?.postEngineStatus({ state: 'ready' });
      } else {
        chatProviderRef?.postEngineStatus({ state: 'verifying', message: 'Verifying chat works…' });
        const check = await verifyEngineWorks(routerProxyBaseURL);
        if (check.ok) {
          await globalState.update(ONBOARDED_KEY, true);
          chatProviderRef?.postEngineStatus({ state: 'ready' });
        } else {
          log(`onboarding verify FAILED: ${check.detail}`);
          chatProviderRef?.postEngineStatus({
            state: 'error',
            message: `Engine started, but no model responded (${check.detail}). Check your API key(s) in Settings, then retry.`,
          });
        }
      }
    }
  } catch (err) {
    setOcEngine(undefined); // ensure sdk.ts reports "engine not running" instead of a silent hang
    const msg = err instanceof Error ? err.message : String(err);
    log(`OpenCode engine UNAVAILABLE: ${msg}`);
    engineLog?.show(true);
    console.warn(`[tiermux] OpenCode engine unavailable. (${msg})`);
    if (onboarding) chatProviderRef?.postEngineStatus({ state: 'error', message: msg });
    void vscode.window.showErrorMessage(`TierMux engine failed to start: ${msg}`, 'Show Log', 'Retry').then((choice) => {
      if (choice === 'Show Log') engineLog?.show(true);
      else if (choice === 'Retry') void startOpenCodeEngine(extensionPath, routerProxyBaseURL, cacheDir, enabledModelIds, mcpServers, globalState);
    });

    if (onboarding && !autoRetryScheduled) {
      autoRetryScheduled = true;
      log(`scheduling one automatic retry in 30s`);
      setTimeout(() => {
        void startOpenCodeEngine(extensionPath, routerProxyBaseURL, cacheDir, enabledModelIds, mcpServers, globalState);
      }, 30_000);
    }
  } finally {
    engineStartInFlight = false;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  console.log('[tiermux-bench-debug] activate() STARTED');
  const catalog = new Catalog(context.extensionPath);
  catalog.loadCached(context.globalState);
  const secrets = new SecretStore(context.secrets);
  const settings = new SettingsStore(context.globalState, catalog);
  if (context.globalState.get('tiermux.notifiedModels') === undefined) {
    settings.seedNotifiedModels(); // first run of this feature: don't notify about the whole existing catalog
  }
  context.subscriptions.push(
    catalog.onDidChange(() => {
      const fresh = settings.checkForNewModels();
      if (fresh.length) notifyNewModels(fresh);
    }),
  );
  const usage = new UsageTracker();
  const usageStore = new UsageStore(context.globalState);
  const modelStats = new ModelStatsStore(context.globalState);
  const slowModels = new SlowModelStore(context.globalState);
  const router = new Router(secrets, settings, catalog, usage, modelStats, usageStore, slowModels);

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

  void startRouterProxy(router)
    .then((srv) => {
      routerProxy = srv;
      console.log(`[tiermux] router proxy listening on ${srv.baseURL}`);

      if (vscode.workspace.getConfiguration('tiermux').get<boolean>('useOpenCodeEngine', true)) {

        const enabledModelIds = settings.enabledByPriority().map(
          (e) => 'tm_' + Buffer.from(`${e.platform}::${e.modelId}`).toString('base64url'),
        );
        const mcpServers = readMcpServers();
        void startOpenCodeEngine(context.extensionUri.fsPath, srv.baseURL, context.globalStorageUri.fsPath, enabledModelIds, mcpServers, context.globalState);
      } else {
        console.warn('[tiermux] OpenCode engine disabled (tiermux.useOpenCodeEngine = false). Chat and agent runs will not work — re-enable the engine to use TierMux.');
      }
    })
    .catch((err) => console.error('[tiermux] router proxy failed to start:', err));

  const editGate = new EditGate(() =>
    vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('requireWriteConfirmation', true),
  );
  context.subscriptions.push(editGate.register());

  setQualityGate(vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('qualityGate', true));

  setHotStandby(vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('hotStandby', true));

  setHedging(vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('chatHedging', true));

  context.subscriptions.push(registerCheckpointContentProvider());

  context.subscriptions.push(registerOcSessionDiffContentProvider());

  const commandGate = new CommandGate(
    () => vscode.workspace.getConfiguration('tiermux.agent').get<CommandApproval>('commandApproval', 'always'),
    () => vscode.workspace.getConfiguration('tiermux.agent').get<number>('commandTimeoutMs', 120000),
    () => vscode.workspace.getConfiguration('tiermux.agent').get<string[]>('commandAllowlist', []),
  );
  const mcp = new McpManager();
  context.subscriptions.push({ dispose: () => mcp.dispose() });

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
    generateCommitMessage: () => generateCommitMessage(router),
    profiler,
    retryEngine: () => {
      if (!routerProxy) return;
      const enabledModelIds = settings.enabledByPriority().map(
        (e) => 'tm_' + Buffer.from(`${e.platform}::${e.modelId}`).toString('base64url'),
      );
      void startOpenCodeEngine(context.extensionUri.fsPath, routerProxy.baseURL, context.globalStorageUri.fsPath, enabledModelIds, readMcpServers(), context.globalState);
    },
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
      if (e.affectsConfiguration('tiermux.engine.traceOcEvents')) {
        const on = vscode.workspace.getConfiguration('tiermux.engine').get<boolean>('traceOcEvents', false);
        if (!engineLog) engineLog = vscode.window.createOutputChannel('TierMux Engine');
        const traceSink = (raw: string) => engineLog?.appendLine(`[${ts()}] [oc-event] ${raw}`);
        setOcTrace(on, traceSink);
      }
      if (e.affectsConfiguration('tiermux.agent.qualityGate')) {
        setQualityGate(vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('qualityGate', true));
      }
      if (e.affectsConfiguration('tiermux.agent.hotStandby')) {
        setHotStandby(vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('hotStandby', true));
      }
      if (e.affectsConfiguration('tiermux.agent.chatHedging')) {
        setHedging(vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('chatHedging', true));
      }
      if (e.affectsConfiguration('tiermux.catalog')) {
        void catalog.refresh(
          vscode.workspace.getConfiguration('tiermux').get<string>('catalog.url', ''),
          context.globalState,
        );
      }
    }),
  );

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

  context.subscriptions.push(
    vscode.commands.registerCommand('tiermux.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('tiermux.showHistory', () => chat.showHistory()),
    vscode.commands.registerCommand('tiermux.compactChat', () => chat.compact()),
    vscode.commands.registerCommand('tiermux.openModelSettings', () => chat.toggleSettingsPanel()),
    vscode.commands.registerCommand('tiermux.setApiKey', (platformArg?: Platform) => setApiKey(secrets, platformArg)),
    vscode.commands.registerCommand('tiermux.clearApiKey', () => clearApiKey(secrets)),
    vscode.commands.registerCommand('tiermux.addSelectionToChat', () => chat.addSelectionToChat()),
    vscode.commands.registerCommand('tiermux.reconnectMcp', async () => { await mcp.reconnect(); void vscode.window.showInformationMessage('Reconnected MCP servers.'); }),
    vscode.commands.registerCommand('tiermux.refreshModels', async () => {
      await catalog.refresh(
        vscode.workspace.getConfiguration('tiermux').get<string>('catalog.url', ''),
        context.globalState,
      );
      chat.refresh();
      void vscode.window.showInformationMessage('TierMux: model catalog refreshed.');
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

    vscode.commands.registerCommand('tiermux.testOcBridge', async () => {
      if (!ocConnection) {
        const cacheDir = context.globalStorageUri.fsPath;
        const ocBin = `${cacheDir}/bin/opencode`;
        const fs = await import('fs');
        if (fs.existsSync(ocBin)) {
          engineLog?.appendLine(`[${ts()}] testOcBridge: found binary at ${ocBin}, retrying launch…`);
          const retryModelIds = settings.enabledByPriority().map(
            (e) => 'tm_' + Buffer.from(`${e.platform}::${e.modelId}`).toString('base64url'),
          );
          const retryMcpServers = readMcpServers();
          await startOpenCodeEngine(context.extensionUri.fsPath, routerProxy?.baseURL ?? '', cacheDir, retryModelIds, retryMcpServers, context.globalState);
        }
      }
      const results = await runBridgeDiagnostic({ routerProxy, ocConnection });
      const report = formatReport(results);
      console.log('[tiermux] OC bridge diagnostic:\n' + report);
      const channel = vscode.window.createOutputChannel('TierMux OC Bridge');
      channel.show(true);
      channel.appendLine(report);
      const pass = results.filter((r) => r.ok).length;
      void vscode.window.showInformationMessage(`TierMux OC bridge: ${pass}/${results.length} checks passed (see output).`);
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

    vscode.commands.registerCommand('tiermux.showEngineLog', () => {
      if (!engineLog) engineLog = vscode.window.createOutputChannel('TierMux Engine');
      engineLog.show(true);
    }),

    vscode.commands.registerCommand('tiermux.resetEngineOnboarding', async () => {
      const deleteCache = await vscode.window.showWarningMessage(
        'Reset TierMux engine onboarding? This restarts the engine and shows the first-run overlay again.',
        { modal: true },
        'Reset', 'Reset + delete cached binary (full fresh-install simulation)',
      );
      if (!deleteCache) return;
      await context.globalState.update(ONBOARDED_KEY, false);
      stopOpenCode(ocConnection);
      ocConnection = undefined;
      setOcEngine(undefined);
      const cacheDir = context.globalStorageUri.fsPath;
      if (deleteCache.startsWith('Reset +')) {
        const fs = await import('fs');
        await fs.promises.rm(`${cacheDir}/bin`, { recursive: true, force: true }).catch(() => undefined);
        engineLog?.appendLine(`[${ts()}] resetEngineOnboarding: deleted cached binary at ${cacheDir}/bin`);
      }
      void vscode.window.showInformationMessage('TierMux: onboarding flag cleared. Restarting engine…');
      if (!routerProxy) return;
      const enabledModelIds = settings.enabledByPriority().map(
        (e) => 'tm_' + Buffer.from(`${e.platform}::${e.modelId}`).toString('base64url'),
      );
      void startOpenCodeEngine(context.extensionUri.fsPath, routerProxy.baseURL, cacheDir, enabledModelIds, readMcpServers(), context.globalState);
    }),

    vscode.commands.registerCommand('tiermux.toggleOcTrace', async () => {
      const cfg = vscode.workspace.getConfiguration('tiermux.engine');
      const next = !cfg.get<boolean>('traceOcEvents', false);
      await cfg.update('traceOcEvents', next, vscode.ConfigurationTarget.Global);
      if (!engineLog) engineLog = vscode.window.createOutputChannel('TierMux Engine');
      const traceSink = (raw: string) => engineLog?.appendLine(`[${ts()}] [oc-event] ${raw}`);
      setOcTrace(next, traceSink);
      engineLog.appendLine(`[${ts()}] OC event trace ${next ? 'ENABLED' : 'DISABLED'}`);
      engineLog.show(true);
      void vscode.window.showInformationMessage(`TierMux: OC event trace ${next ? 'enabled' : 'disabled'}.`);
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
  console.log('[tiermux-bench-debug] activate() COMPLETED — all commands registered');

  context.subscriptions.push(
    ...registerEditorCommands(chat),
    ...registerCodeActions(chat),
    registerInlineChat(router, editGate),
    ...registerInlineCompletions(router, catalog, settings),
    registerCommitMessage(router),
  );
}

export function deactivate(): void {
  stopOpenCode(ocConnection);
  routerProxy?.close();
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

