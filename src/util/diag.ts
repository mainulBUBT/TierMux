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

export function diagLog(scope: string, msg: string): void {
  // Temporary, unconditional diagnostic trace (the model-picker → AI SDK investigation).
  // Remove once the root cause is fixed. Always logs so no setting has to be enabled.
  if (!channel) channel = vscode.window.createOutputChannel('TierMux Diag');
  const line = `[${ts()}] ${scope} · ${msg}`;
  channel.appendLine(line);
  channel.show(true);
  console.log(`[tiermux][diag] ${line}`);
}
