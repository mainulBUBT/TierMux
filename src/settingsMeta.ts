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
    desc: 'Show a diff and ask for confirmation before the agent writes/creates/deletes a file.' },
  { key: 'agent.qualityGate', label: 'Quality gate', type: 'boolean',
    desc: 'Escalate to the next model when an answer is weak (refusal, repetition, truncation) instead of accepting it.' },
  { key: 'agent.hotStandby', label: 'Hot standby', type: 'boolean',
    desc: 'Pre-create the next fallback model\'s session in the background so escalation starts faster.' },
  { key: 'agent.smartScoring', label: 'Smart Auto scoring', type: 'boolean',
    desc: 'Route Auto requests by learned, per-model runtime metrics (success rate, TTFT vs own baseline, provider health) instead of fixed priority. Slower models adapt within minutes; turn off to restore priority-only routing.' },
  { key: 'agent.scoringTrace', label: 'Trace Smart Auto', type: 'boolean',
    desc: 'Log the per-turn scoring rationale (why each model was selected or skipped) to the "TierMux Router" output channel.' },
  { key: 'agent.autoContinue', label: 'Auto-continue', type: 'boolean',
    desc: 'Automatically resume paused agent runs (up to 3 continuations) without waiting for input.' },
  { key: 'agent.commandApproval', label: 'Command approval mode', type: 'enum', enum: ['always', 'allowlist', 'never'],
    desc: 'How the agent\'s runCommand tool is gated before running shell commands.' },
  { key: 'agent.maxIterations', label: 'Max iterations', type: 'number', min: 1, max: 100,
    desc: 'Maximum tool-call iterations per agent task before pausing.' },
  { key: 'agent.maxConcurrentRuns', label: 'Max concurrent runs', type: 'number', min: 1, max: 10,
    desc: 'Maximum number of chat sessions that run their agent at the same time.' },
  { key: 'agent.commandTimeoutMs', label: 'Command timeout (ms)', type: 'number', min: 1000, max: 300000,
    desc: 'Maximum time (ms) a single agent command may run before it is killed.' },
  { key: 'agent.autoCompactThreshold', label: 'Auto-compact threshold', type: 'number', min: 0, max: 1, step: 0.05,
    desc: 'Automatically compact the conversation when it exceeds this fraction of the context window. 0 disables.' },
  // -- Completions --
  { key: 'completions.enabled', label: 'Inline completions', type: 'boolean',
    desc: 'Enable Copilot-style inline (ghost-text) completions.' },
  // 'completions.model' is a dedicated dropdown row in renderOthersSection(), not a generic
  // string field — see the Utility model row for why.
  { key: 'completions.debounceMs', label: 'Completions debounce (ms)', type: 'number', min: 0, max: 5000,
    desc: 'Debounce delay before requesting an inline completion.' },
  // -- Chat --
  { key: 'chat.typingSpeedMs', label: 'Typing speed (ms)', type: 'number', min: 0, max: 100,
    desc: 'Delay between chunks of the simulated typing animation. 0 disables animation.' },
  // -- Plan --
  { key: 'plan.saveToFile', label: 'Save plans to file', type: 'boolean',
    desc: 'Save actionable plans as markdown checklist files.' },
  { key: 'plan.folder', label: 'Plans folder', type: 'string',
    desc: 'Workspace-relative folder where plan files are written.' },
  // -- Profiler --
  { key: 'profiler.enabled', label: 'Profiler', type: 'boolean',
    desc: 'Collect per-turn performance traces (latency, tokens, fallbacks).' },
  { key: 'profiler.ringSize', label: 'Profiler ring size', type: 'number', min: 10, max: 10000,
    desc: 'Maximum number of recent turns to keep in the profiler\'s ring buffer.' },
  // -- Engine --
  { key: 'engine.traceOcEvents', label: 'Trace OC events', type: 'boolean',
    desc: 'Log every raw TierMux engine event to the output channel.' },
  // -- Other --
  { key: 'requestTimeoutMs', label: 'Request timeout (ms)', type: 'number', min: 1000, max: 300000,
    desc: 'Per-provider request timeout before failing over to the next model.' },
  { key: 'rateLimitCooldownMs', label: 'Rate-limit cooldown (ms)', type: 'number', min: 0, max: 600000,
    desc: 'How long to skip a rate-limited provider before trying it again.' },
];
