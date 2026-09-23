import type { SettingMeta } from './messages';

/** Fallback for a key `vscode.workspace.getConfiguration` has no value for (never happens once
 *  `package.json` declares a default, but keeps the read side total). */
export function defaultForSetting(meta: SettingMeta): boolean | number | string {
  if (meta.type === 'boolean') return false;
  if (meta.type === 'number') return 0;
  if (meta.type === 'enum') return meta.enum?.[0] ?? '';
  return '';
}

/** Row definitions for the "Others" settings tab. Single source of truth for both
 *  the read side (`sendConfig` snapshotting current values) and the write side
 *  (`setExtensionSetting` validating/persisting them) — the webview renders
 *  whatever this list says and never keeps its own copy. `utilityModel` is
 *  handled by its own dedicated `setUtilityModel` flow, not this generic one. */
export const SETTINGS_META: SettingMeta[] = [
  // -- Agent --
  { key: 'agent.requireWriteConfirmation', label: 'Require write confirmation', type: 'boolean',
    desc: 'Ask before the agent writes, creates or deletes a file (and before inline chat applies an edit). Off: file changes run without a prompt; shell commands still follow "Command approval mode".' },
  { key: 'agent.diagTrace', label: 'Diagnostic trace', type: 'boolean',
    desc: 'Log per-turn timing (model selection, first token) and engine events to the "TierMux Diag" output channel — for diagnosing slow turns.' },
  { key: 'agent.commandApproval', label: 'Command approval mode', type: 'enum', enum: ['always', 'allowlist', 'never'],
    desc: 'How the agent\'s run_commands tool is gated before running shell commands.' },
  { key: 'agent.maxStepsPerTurn', label: 'Max steps per turn', type: 'number', min: 0, max: 200,
    desc: 'Hard cap on model round-trips in one agent turn. A turn stopped by this cap is marked resumable — the Continue button picks it up with the full transcript, nothing is repeated. Raise it for long unattended tasks; each step is a real request against a rate-limited free tier. 0 turns the cap off entirely — no resumable pause, the turn just keeps going.' },
  { key: 'agent.maxConcurrentRuns', label: 'Max concurrent runs', type: 'number', min: 1, max: 10,
    desc: 'Maximum number of chat sessions that run their agent at the same time.' },
  { key: 'agent.commandTimeoutMs', label: 'Command timeout (ms)', type: 'number', min: 1000, max: 300000,
    desc: 'Maximum time (ms) one run_commands call may run before it is killed.' },
  { key: 'agent.connectTimeoutMs', label: 'Failover connect timeout (ms)', type: 'number', min: 1000, max: 300000,
    desc: 'Per-model ceiling on time to response headers while auto mode fails over between models. Lower it (e.g. 20000) when a dead gateway regularly holds turns; custom/local endpoints are exempt.' },
  { key: 'agent.firstContentTimeoutMs', label: 'First-content timeout (ms)', type: 'number', min: 1000, max: 300000,
    desc: 'Ceiling on time to the first real content chunk once a stream has started; a live-but-silent stream is abandoned after this and the next model takes over.' },
  { key: 'agent.chainDeadlineMs', label: 'Failover chain deadline (ms)', type: 'number', min: 5000, max: 600000,
    desc: 'Auto mode stops STARTING new failover candidates once the chain has spent this long on one request (a model already streaming is never interrupted).' },
  // -- Completions --
  { key: 'completions.enabled', label: 'Inline completions', type: 'boolean',
    desc: 'Enable Copilot-style inline (ghost-text) completions.' },
  // 'completions.model' is a dedicated dropdown row in renderOthersSection(), not a generic
  // string field — see the Utility model row for why.
  { key: 'completions.debounceMs', label: 'Completions debounce (ms)', type: 'number', min: 0, max: 5000,
    desc: 'Debounce delay before requesting an inline completion.' },
  // -- Other --
  { key: 'agent.toolCompaction', label: 'Context compaction', type: 'enum', enum: ['auto', 'off'],
    desc: 'Cline\'s context compaction. auto compacts older conversation before a request would overflow the routed model\'s window (no extra model call); off compacts only when a provider rejects a request as too long.' },
];
