/** Legacy end-of-turn report types + markdown strip, kept ONLY so transcripts persisted before
 *  the structured work report was removed (cline-agent branch, 2026-09-22) stay replayable.
 *  Nothing new produces WorkReportData; the webview strips the serialized block from old
 *  entries and renders the plain text. Type-only imports here (host AND webview import it). */

/** THE accounting object one old turn carried. No longer produced — legacy shapes only. */
export interface TurnTelemetry {
  model: string;
  taskKind: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  thoughts: number;
  failovers: number;
  elapsedMs: number;
}

/** Request/window pressure state for the most recent serving request. No longer produced —
 *  live turns report pressure via the `contextPressure` message instead. */
export interface ContextTelemetry {
  contextTokens: number;
  contextWindow: number;
  percent: number;
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
  version: 1;
  verifyOutcome: 'verified' | 'failed' | 'unverified' | 'changes-only';
  verifyAvailable?: boolean;
  verifyCmd?: string;
  auditOutcome?: 'verified' | 'incomplete';
  fixRounds: number;
  changedFiles: WorkReportChangedFile[];
  toolTally: WorkReportToolCount[];
  stopReason: string;
  telemetry: TurnTelemetry;
  context?: ContextTelemetry;
  checkpointId?: string;
}

// ── Legacy markdown serialization — emit and strip share one implementation so the strip is
// lossless. Only `stripLegacyMarkdown` is exported; nothing renders new reports.

/** Marker phrases here are load-bearing: old persisted entries end in exactly this block, and
 *  the strip relies on byte-identical reproduction. */
function renderLegacyMarkdown(report: WorkReportData): string {
  const lines: string[] = [];
  const rounds = report.fixRounds;
  if (report.verifyOutcome === 'verified') {
    const rTxt = rounds ? ` (after ${rounds} fix round${rounds === 1 ? '' : 's'})` : '';
    lines.push(`**✅ Verified** — \`${report.verifyCmd}\` passed${rTxt}.`);
  } else if (report.verifyOutcome === 'failed') {
    // SILENT (2026-09-17, user direction) — was emitted with no line at all. Kept as a branch
    // so the strip matches what old code actually wrote.
  } else if (report.verifyOutcome === 'changes-only') {
    lines.push('**✅ Changes applied** — your changes are saved to disk.');
  } else if (report.verifyAvailable === false) {
    lines.push('**✅ Changes applied** — your changes are saved to disk.');
  } else {
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

/** Remove exactly what the legacy serializer appended — same input ⇒ same string, so a suffix
 *  match is lossless. Returns `text` unchanged when no report block is present (e.g. legacy
 *  prose that never had one). */
export function stripLegacyMarkdown(text: string, report: WorkReportData): string {
  const md = renderLegacyMarkdown(report);
  return text.endsWith(md) ? text.slice(0, text.length - md.length) : text;
}
