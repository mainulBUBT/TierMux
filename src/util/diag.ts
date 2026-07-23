import * as vscode from 'vscode';

/**
 * Temporary diagnostics for tracing the model from the picker through to the AI SDK call.
 * Writes to a dedicated "TierMux Diag" OutputChannel so it's visible in a packaged build,
 * not just the dev Debug Console. Gated behind `tiermux.agent.diagTrace` so it's silent
 * unless explicitly enabled. Remove once the root cause is confirmed.
 */
let channel: vscode.OutputChannel | undefined;

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

/** Honor the `tiermux.agent.diagTrace` gate. Read fresh each call so toggling the setting
 *  takes effect without a reload; cheap enough for a diagnostic path. */
function enabled(): boolean {
  try {
    return vscode.workspace.getConfiguration('tiermux').get<boolean>('agent.diagTrace', false);
  } catch {
    return false; // no workspace config available (e.g. very early activation) → stay silent
  }
}

export function diagLog(scope: string, msg: string): void {
  // Temporary diagnostic trace (the model-picker → AI SDK investigation). Silent unless the
  // user opts in via `tiermux.agent.diagTrace`. Remove once the root cause is fixed.
  if (!enabled()) return;
  if (!channel) channel = vscode.window.createOutputChannel('TierMux Diag');
  const line = `[${ts()}] ${scope} · ${msg}`;
  channel.appendLine(line);
  // NOTE: do NOT channel.show() here — it runs on every log line and would repeatedly steal
  // the panel from the user during normal chat. The channel is reachable from the Output
  // dropdown when the user wants it.
  console.log(`[tiermux][diag] ${line}`);
}
