/**
 * Structured end-of-turn report — the durable representation of what a turn did.
 *
 * Dependency-neutral by contract: this module is imported by BOTH the host/agent runtime and
 * the webview bundle (which may only import from media/src/** and src/shared/**). The TaskKind
 * import below is TYPE-ONLY — it is erased at bundle time, so no agent-runtime code ever
 * reaches the browser bundle. Do not add runtime imports here.
 *
 * Token semantics (authoritative — do not conflate):
 *  - TurnTelemetry.inputTokens/outputTokens = ACCUMULATED provider-reported tokens across ALL
 *    model calls of the entire turn (planner, executor, judges, continuations, verify-fix
 *    rounds). Turn COST accounting; shown in the footer and the ResultCard stats row.
 *  - ContextTelemetry.contextTokens = context size of the MOST RECENT model request as
 *    actually sent. Window PRESSURE state; only the context chip consumes it, against the
 *    SERVING model's window (failover changes the window — never use the selected model's).
 */

import type { TaskKind } from '../agent/routing';

/** THE accounting object for one turn — the live status line, footer, ResultCard, and replay
 *  all read these numbers from one place. No component recomputes its own copy. */
export interface TurnTelemetry {
  /** "provider/modelId" of the model that actually served, or "unknown". Always present —
   *  deterministic rendering beats defensive optionality. */
  model: string;
  taskKind: TaskKind;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  thoughts: number;
  failovers: number;
  elapsedMs: number;
}

/** Request/window pressure state for the most recent serving request — NOT turn accounting. */
export interface ContextTelemetry {
  /** Actual context size of the most recent model request (conversation + retained history +
   *  tool output + system prompt, as fitted and sent). */
  contextTokens: number;
  /** The SERVING model's declared context window. */
  contextWindow: number;
  /** Math.floor(contextTokens / contextWindow * 100), precomputed host-side. */
  percent: number;
  // Future: breakdown { system, retained, user, tools }
}

export interface WorkReportChangedFile {
  path: string;
  status: 'A' | 'M' | 'D';
}

export interface WorkReportToolCount {
  name: string;
  count: number;
}

export interface WorkReportData {
  /** Persisted in transcripts — readers switch on this for forward compatibility. */
  version: 1;
  verifyOutcome: 'verified' | 'failed' | 'unverified' | 'changes-only';
  verifyCmd?: string;
  fixRounds: number;
  changedFiles: WorkReportChangedFile[];
  toolTally: WorkReportToolCount[];
  stopReason: string;
  telemetry: TurnTelemetry;
  context?: ContextTelemetry;
  /** The turn's own checkpoint (requestId) — turn-scoped and immutable after the turn ends,
   *  so replay-time changed-file clicks always diff against this turn's baseline. Stamped by
   *  the HOST (chatViewProvider), which owns the requestId; the agent loop leaves it unset. */
  checkpointId?: string;
}

// ── Legacy markdown serialization ───────────────────────────────────────────────────────
// The transcript is the durable structured representation; this markdown form exists ONLY so
// transcripts persisted before WorkReportData keep rendering after the minimum migration
// window. New code must never PARSE it back — emit and strip share this one implementation
// precisely so the two sides can never diverge.

/** Marker phrases here are load-bearing: e2e suites key on them ('Verification failed',
 *  'Unverified'), and the wording is user-facing copy — change with care. */
export function renderLegacyMarkdown(report: WorkReportData): string {
  const lines: string[] = [];
  const rounds = report.fixRounds;
  if (report.verifyOutcome === 'verified') {
    const rTxt = rounds ? ` (after ${rounds} fix round${rounds === 1 ? '' : 's'})` : '';
    lines.push(`**✅ Verified** — \`${report.verifyCmd}\` passed${rTxt}.`);
  } else if (report.verifyOutcome === 'failed') {
    const r = rounds || 1;
    lines.push(`**❌ Verification failed** — \`${report.verifyCmd}\` still fails after ${r} fix round${r === 1 ? '' : 's'}. Your changes are saved, but the issue isn't fully resolved yet — re-run the command to see what's left, or ask me to keep fixing it.`);
  } else if (report.verifyOutcome === 'changes-only') {
    lines.push('**✅ Changes applied** — your changes are saved to disk.');
  } else {
    // The honest default: EVERY untested mutating turn says so. Lead with what IS true (the
    // changes are saved), then why they're untested and one concrete next step.
    const reason = report.stopReason
      ? 'the run ended before the final check could run'
      : 'this project has no test command I could run';
    const next = report.stopReason
      ? 'Ask me to verify the changes, or give them a quick look yourself.'
      : 'Give the changes a quick look — or tell me which command tests this project and I\'ll run it.';
    lines.push(`**⚠️ Unverified** — your changes are saved but not tested yet (${reason}). ${next}`);
  }
  if (report.changedFiles.length) {
    const byStatus = (st: WorkReportChangedFile['status']) => report.changedFiles.filter((f) => f.status === st).map((f) => f.path);
    const parts: string[] = [];
    const created = byStatus('A'), modified = byStatus('M'), deleted = byStatus('D');
    if (created.length) parts.push(`created: ${created.join(', ')}`);
    if (modified.length) parts.push(`modified: ${modified.join(', ')}`);
    if (deleted.length) parts.push(`deleted: ${deleted.join(', ')}`);
    // Always present — a structured report may repeat what the prose above already said.
    lines.push(`**Files changed:** ${parts.join('; ')}.`);
  }
  if (report.toolTally.length) {
    const total = report.toolTally.reduce((s, t) => s + t.count, 0);
    const top = report.toolTally.slice(0, 6).map((t) => `${t.name}×${t.count}`).join(', ');
    const more = report.toolTally.length > 6 ? `, +${report.toolTally.length - 6} more` : '';
    lines.push(`**Tools used:** ${total} call${total === 1 ? '' : 's'} — ${top}${more}`);
  }
  return `\n\n---\n${lines.join('\n')}`;
}

/** Remove exactly what renderLegacyMarkdown appended — same input ⇒ same string, so a suffix
 *  match is lossless. Returns `text` unchanged when no report block is present (e.g. legacy
 *  prose that never had one). */
export function stripLegacyMarkdown(text: string, report: WorkReportData): string {
  const md = renderLegacyMarkdown(report);
  return text.endsWith(md) ? text.slice(0, text.length - md.length) : text;
}
