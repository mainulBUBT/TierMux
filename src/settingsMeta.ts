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
    desc: 'How the agent\'s runCommand tool is gated before running shell commands.' },
  { key: 'agent.maxStepsPerTurn', label: 'Max steps per turn', type: 'number', min: 1, max: 200,
    desc: 'Hard cap on model round-trips in one agent turn. A turn stopped by this cap is marked resumable — the Continue button picks it up with the full transcript, nothing is repeated. Raise it for long unattended tasks; each step is a real request against a rate-limited free tier.' },
  { key: 'agent.maxConcurrentRuns', label: 'Max concurrent runs', type: 'number', min: 1, max: 10,
    desc: 'Maximum number of chat sessions that run their agent at the same time.' },
  { key: 'agent.commandTimeoutMs', label: 'Command timeout (ms)', type: 'number', min: 1000, max: 300000,
    desc: 'Maximum time (ms) a single agent command may run before it is killed.' },
  { key: 'agent.autoCompactThreshold', label: 'Auto-compact threshold', type: 'number', min: 0, max: 1, step: 0.05,
    desc: 'Fraction of the routed model\'s context window at which the conversation is compacted — older turns summarized, recent ones kept verbatim. Checked before a send and after a turn settles. The token cap below can lower the trigger further; "Auto-compact context" turns the whole thing off.' },
  // -- Completions --
  { key: 'completions.enabled', label: 'Inline completions', type: 'boolean',
    desc: 'Enable Copilot-style inline (ghost-text) completions.' },
  // 'completions.model' is a dedicated dropdown row in renderOthersSection(), not a generic
  // string field — see the Utility model row for why.
  { key: 'completions.debounceMs', label: 'Completions debounce (ms)', type: 'number', min: 0, max: 5000,
    desc: 'Debounce delay before requesting an inline completion.' },
  // -- Plan --
  { key: 'plan.saveToFile', label: 'Save plans to file', type: 'boolean',
    desc: 'Save actionable plans as markdown checklist files.' },
  { key: 'plan.folder', label: 'Plans folder', type: 'string',
    desc: 'Workspace-relative folder where plan files are written.' },
  // -- Other --
  { key: 'agent.toolCompaction', label: 'Tool-result compaction', type: 'enum', enum: ['off', 'light', 'aggressive'],
    desc: 'Replace EARLIER steps\' bulky tool outputs with a one-line stub naming the tool and its arguments, so each step re-sends a small prompt; light stubs over ~2,000 characters, aggressive over ~800. The most recent step\'s results, short outputs and error payloads stay verbatim. File reads are included — they are the largest outputs and the reason this exists.' },
  { key: 'agent.verifyFixRounds', label: 'Verify fix rounds', type: 'number', min: 0, max: 5,
    desc: 'After a turn edits files, the project\'s verify command runs. If it fails, the failure output goes back to the agent for up to this many fix-and-recheck rounds before the turn reports failure — you are never asked to re-run it. 0 reports the failure without retrying.' },
  { key: 'agent.autoCondense', label: 'Auto-compact context', type: 'boolean',
    desc: 'Automatically summarize older turns when the conversation approaches ~80% of the model\'s context window, before a turn starts.' },
  // min 0, not 8000: 0 is the documented "no cap, window-only" value (package.json declares
  // minimum 0 too), and an 8k floor made the settings UI unable to express it at all.
  { key: 'agent.autoCondenseTokenCap', label: 'Auto-compact context cap (tokens)', type: 'number', min: 0, max: 200000,
    desc: 'Fixed working-context ceiling for auto-compact, independent of the served model\'s window — keeps per-turn payload (and first-token latency) bounded. Raise it to compact less often at the cost of slower turns; 0 disables the cap (window-only).' },
];
