/**
 * Structured end-of-turn report — the durable representation of what a turn did. Imported by
 * BOTH the host and the webview bundle: type-only imports only, no runtime imports.
 *
 * Token semantics: TurnTelemetry.inputTokens/outputTokens accumulate across ALL model calls
 * of the turn (turn COST); ContextTelemetry.contextTokens is the MOST RECENT request's context
 * size (window PRESSURE), measured against the SERVING model's window.
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
  /** Whether a verify command existed for this workspace at all. false ⇒ "unverified" is a
   *  property of the PROJECT, so the UI stays silent. Older transcripts are treated as true. */
  verifyAvailable?: boolean;
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

// ── Legacy markdown serialization — only so transcripts persisted before WorkReportData keep
// rendering. Never PARSE it back; emit and strip share one implementation.

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
    // Agent-owns-the-recheck copy (2026-08-25): the loop already ran the fix rounds itself, so
    // the user is never asked to re-run the command — the only follow-up offered is telling the
    // agent to keep going.
    lines.push(`**❌ Verification failed** — \`${report.verifyCmd}\` still fails after ${r} fix round${r === 1 ? '' : 's'}. Your changes are saved, but the issue isn't fully resolved yet — say "keep fixing" and I'll continue from the current failures.`);
  } else if (report.verifyOutcome === 'changes-only') {
    lines.push('**✅ Changes applied** — your changes are saved to disk.');
  } else if (report.verifyAvailable === false) {
    // No test/build command exists in this workspace for ANY stack. Flagging the turn as
    // untested (and asking for a command) blames the turn for a property of the project, on
    // every single turn — pure noise. State what IS true and stop there.
    lines.push('**\u2705 Changes applied** \u2014 your changes are saved to disk.');
  } else {
    // Every untested mutating turn says so: what IS true (changes saved), why untested, one
    // next step addressed to the AGENT. A command DOES exist here (verifyAvailable !== false).
    const reason = report.stopReason
      ? 'the run ended before the final check could run'
      : report.verifyAvailable
        ? 'the final check didn\'t run this turn'
        : 'this project has no test command I could run';
    const next = report.stopReason
      ? 'Ask me to verify the changes and I\'ll run the check myself.'
      : report.verifyAvailable
        ? 'Ask me to verify and I\'ll run it again.'
        : 'Tell me which command tests this project and I\'ll run it from now on.';
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
