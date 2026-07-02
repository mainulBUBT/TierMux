import * as vscode from 'vscode';
import type { Platform } from './shared/types';
import { Catalog } from './catalog/catalog';
import { SecretStore } from './config/secrets';
import { SettingsStore } from './config/settingsStore';
import { UsageTracker } from './config/usage';
import { UsageStore } from './config/usageStore';
import { ModelStatsStore } from './config/modelStats';
import { Router } from './router/router';
import { startRouterProxy } from './backend/routerProxy';
import { launchOpenCode, stopOpenCode, type OcConnection } from './backend/ocLauncher';
import { runBridgeDiagnostic, formatReport } from './backend/ocDiagnostics';
import { EditGate } from './edits/applyEdit';
import { CommandGate, type CommandApproval } from './edits/commandGate';
import { registerCheckpointContentProvider } from './edits/checkpoints';
// (ToolCache was removed in v7 — its no-op stand-in is no longer needed.)
import { setOcEngine, setOcTrace, setQualityGate, setHotStandby, setHedging } from './agent/sdk';
import { McpManager } from './mcp/mcpManager';
import { normalizeMcpServerConfig, type McpServerConfig } from './mcp/mcpClient';
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

// OpenAI-compatible router proxy handle; closed on deactivation.
let routerProxy: { baseURL: string; close(): void } | undefined;
// OpenCode engine handle (undefined when the OC engine is off / unavailable).
let ocConnection: OcConnection | undefined;
// "TierMux Engine" Output channel — surfaces the proxy URL, first-run download
// progress, OC stdout/stderr, and any startup error. Visible via View → Output
// → TierMux Engine (or `tiermux.showEngineLog`).
let engineLog: vscode.OutputChannel | undefined;
const ts = () => new Date().toISOString().slice(11, 23);

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
 * Start the OC engine pointed at the router proxy. Logs the outcome; never throws
 * — a missing binary just means the integration stays off and the built-in agent runs.
 */
async function startOpenCodeEngine(
  extensionPath: string,
  routerProxyBaseURL: string,
  cacheDir: string,
  enabledModelIds: string[],
  mcpServers: Record<string, McpServerConfig>,
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!engineLog) engineLog = vscode.window.createOutputChannel('TierMux Engine');
  const log = (msg: string) => engineLog?.appendLine(`[${ts()}] ${msg}`);
  log(`startOpenCodeEngine: proxy=${routerProxyBaseURL} cacheDir=${cacheDir}`);
  try {
    // withProgress makes the first-run binary download visible; later boots are instant (cached).
    ocConnection = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Starting TierMux engine' },
      (progress) => launchOpenCode({
        extensionPath,
        routerProxyBaseURL,
        workspaceRoot,
        cacheDir,
        enabledModelIds,
        mcpServers,
        onProgress: (msg) => progress.report({ message: msg }),
        log,
      }),
    );
    setOcEngine(ocConnection); // flip sdk.ts onto the OC path
    // Wire the OC SSE trace toggle (sink passed directly — no global indirection).
    const traceSink = (raw: string) => engineLog?.appendLine(`[${ts()}] [oc-event] ${raw}`);
    setOcTrace(vscode.workspace.getConfiguration('tiermux.engine').get<boolean>('traceOcEvents', false), traceSink);
    log(`OpenCode engine UP at ${ocConnection.baseURL} (routing via ${routerProxyBaseURL})`);
    console.log(`[tiermux] OpenCode engine up at ${ocConnection.baseURL} (routing via ${routerProxyBaseURL})`);
  } catch (err) {
    setOcEngine(undefined); // ensure sdk.ts reports "engine not running" instead of a silent hang
    const msg = err instanceof Error ? err.message : String(err);
    log(`OpenCode engine UNAVAILABLE: ${msg}`);
    engineLog?.show(true);
    console.warn(`[tiermux] OpenCode engine unavailable. (${msg})`);
  }
}

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

  // OpenAI-compatible router proxy. OC (the agent engine) is pointed at this URL
  // as a custom provider, so every model call it makes is routed across TierMux's
  // free providers with failover. Without the OC engine up, chat/agent runs cannot
  // happen — the built-in agent loop was removed in v7.0.
  void startRouterProxy(router)
    .then((srv) => {
      routerProxy = srv;
      console.log(`[tiermux] router proxy listening on ${srv.baseURL}`);
      // Bring up the OC engine now that the proxy URL is known.
      if (vscode.workspace.getConfiguration('tiermux').get<boolean>('useOpenCodeEngine', true)) {
        // Encode all currently enabled models as tm_<base64url> so OC's static model
        // registry accepts them. Models added after launch need a reload.
        const enabledModelIds = settings.enabledByPriority().map(
          (e) => 'tm_' + Buffer.from(`${e.platform}::${e.modelId}`).toString('base64url'),
        );
        const mcpServers = readMcpServers();
        void startOpenCodeEngine(context.extensionUri.fsPath, srv.baseURL, context.globalStorageUri.fsPath, enabledModelIds, mcpServers);
      } else {
        console.warn('[tiermux] OpenCode engine disabled (tiermux.useOpenCodeEngine = false). Chat and agent runs will not work — re-enable the engine to use TierMux.');
      }
    })
    .catch((err) => console.error('[tiermux] router proxy failed to start:', err));

  const editGate = new EditGate(() =>
    vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('requireWriteConfirmation', true),
  );
  context.subscriptions.push(editGate.register());

  // Quality gate (FrugalGPT-style): escalate weak-but-non-empty answers. Default on;
  // re-read in the onDidChangeConfiguration listener below.
  setQualityGate(vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('qualityGate', true));

  // Hot standby: pre-create the next chain hop's OC session while the current hop runs,
  // so escalation is instant. Default on; re-read in the listener below.
  setHotStandby(vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('hotStandby', true));

  // Chat hedging: race fast+smart for a short first chat turn. Default on; re-read below.
  setHedging(vscode.workspace.getConfiguration('tiermux.agent').get<boolean>('chatHedging', true));

  // One shared checkpoint content provider for every session (VS Code allows one per scheme);
  // each ChatViewProvider session owns its own CheckpointManager data on top of it.
  context.subscriptions.push(registerCheckpointContentProvider());

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

  // Reconnect MCP servers when their configuration changes.
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
    // Exercises the router proxy + OC engine end-to-end and reports which paths OC
    // serves. Used to verify the bridge and discover OC's REST/SSE shape before rewiring the UI.
    // If the OC engine isn't up but a binary is now available (e.g. the user pre-seeded the
    // cache after activation), re-attempt the launch so they don't have to reload the window.
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
          await startOpenCodeEngine(context.extensionUri.fsPath, routerProxy?.baseURL ?? '', cacheDir, retryModelIds, retryMcpServers);
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
    // Reveal the "TierMux Engine" output channel so the user can see proxy URL,
    // first-run download progress, OC stdout/stderr, and any startup error.
    vscode.commands.registerCommand('tiermux.showEngineLog', () => {
      if (!engineLog) engineLog = vscode.window.createOutputChannel('TierMux Engine');
      engineLog.show(true);
    }),
    // Toggle the OC SSE event trace on/off (writes raw frames to the engine channel).
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

