// ResultCard — the structured end-of-turn work report. Renders WorkReportData for both the live
// turn (`workReport` message) and replay (entry.workReport), so both are identical by
// construction. Compact on purpose: telemetry stays in the footer; this carries only what the
// footer cannot — verification status and what changed. No verdict BADGE either: a failed gate
// reads as a quiet note suggesting the user run the command (2026-09-17, user direction), since
// the loop has already spent its fix rounds and the gate never saw the suite before the turn.
// Host interaction via callbacks (onDiffFile) only.

import { el } from '../dom';
import { fmtDuration } from '../../format';

// ========== Types ==========

import type { WorkReportData } from '../../../../src/shared/workReport';

export interface ResultCardOptions {
  /** Click on a changed file → host opens checkpoint↔current diff. Absent ⇒ rows are inert. */
  onDiffFile?: (path: string) => void;
}

// ========== Helpers ==========

function fmtElapsed(ms: number): string {
  // Sub-second precision stays (tool timings are often < 10s); longer spans go human.
  if (ms >= 60_000) return fmtDuration(ms / 1000);
  if (ms >= 1_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

const BADGE_CLS = { A: 'cp-created', M: 'cp-modified', D: 'cp-deleted' } as const;

// ========== Component ==========

/** Build the card, or NULL when there is nothing to tell: a verified pass is the expected
 *  outcome, so success is SILENT, and a FAILED gate is silent too (2026-09-17, user direction) —
 *  the command was never run before the changes, so a non-zero exit cannot be attributed to this
 *  turn, and reporting it anyway blamed the agent for a suite that was often already red. A
 *  failed turn therefore renders only its changed files, and nothing at all when it changed none.
 *  The one thing the card still SAYS is "untested", and only where the workspace HAS a check
 *  (verifyAvailable !== false). The agent's own closing sentence is what reports a failure now. */
export function createResultCard(report: WorkReportData, opts?: ResultCardOptions): HTMLElement | null {
  if (report.verifyOutcome === 'verified' || report.verifyOutcome === 'changes-only') return null;
  if (report.verifyOutcome === 'unverified' && report.verifyAvailable === false) return null;
  if (report.verifyOutcome === 'failed' && report.changedFiles.length === 0) return null;

  const card = el('div', { class: 'tm-result-card rc-quiet' });

  if (report.verifyOutcome !== 'failed') {
    card.append(el('div', { class: 'rc-hint' }, 'Not tested this turn'));
  }

  // ── Files changed: A/M/D badge + path; click → checkpoint diff when wired ──
  if (report.changedFiles.length) {
    const filesBox = el('div', { class: 'rc-files' });
    for (const f of report.changedFiles.slice(0, 40)) {
      const row = el('div', { class: `cp-file${opts?.onDiffFile && report.checkpointId ? ' rc-clickable' : ''}`, title: opts?.onDiffFile && report.checkpointId ? 'Diff against this turn\'s checkpoint' : undefined });
      row.append(el('span', { class: `cp-badge ${BADGE_CLS[f.status]}` }, f.status));
      row.append(el('span', { class: 'cp-name' }, f.path));
      if (opts?.onDiffFile && report.checkpointId) row.addEventListener('click', () => opts.onDiffFile!(f.path));
      filesBox.append(row);
    }
    if (report.changedFiles.length > 40) {
      filesBox.append(el('div', { class: 'rc-more' }, `+${report.changedFiles.length - 40} more file(s)`));
    }
    card.append(filesBox);
  }

  return card;
}
