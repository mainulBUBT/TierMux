// ResultCard — the structured end-of-turn work report. Renders WorkReportData for both the live
// turn (`workReport` message) and replay (entry.workReport), so both are identical by
// construction. Compact on purpose: telemetry stays in the footer; this carries only what the
// footer cannot — verification status and what changed. No manual verify button: the agent owns
// the recheck. Host interaction via callbacks (onDiffFile) only.

import { el } from '../dom';
import { fmtDuration } from '../../format';

// ========== Types ==========

import type { WorkReportData } from '../../../../src/shared/workReport';

export interface ResultCardOptions {
  /** Click on a changed file → host opens checkpoint↔current diff. Absent ⇒ rows are inert. */
  onDiffFile?: (path: string) => void;
}

// ========== Helpers ==========

const OUTCOME_META = {
  verified: { icon: '✅', label: 'Verified', cls: 'rc-verified' },
  failed: { icon: '❌', label: 'Verification failed', cls: 'rc-failed' },
  unverified: { icon: '⚠️', label: 'Unverified', cls: 'rc-unverified' },
  'changes-only': { icon: '✅', label: 'Changes applied', cls: 'rc-verified' },
} as const;

function fmtElapsed(ms: number): string {
  // Sub-second precision stays (tool timings are often < 10s); longer spans go human.
  if (ms >= 60_000) return fmtDuration(ms / 1000);
  if (ms >= 1_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

const BADGE_CLS = { A: 'cp-created', M: 'cp-modified', D: 'cp-deleted' } as const;

// ========== Component ==========

/** Build the card, or NULL when there is nothing to tell: a verified pass is the expected
 *  outcome, so success is SILENT; the card speaks only for a failed gate or untested work — and
 *  "untested" only when the workspace HAS a check to run (verifyAvailable !== false). */
export function createResultCard(report: WorkReportData, opts?: ResultCardOptions): HTMLElement | null {
  if (report.verifyOutcome === 'verified' || report.verifyOutcome === 'changes-only') return null;
  if (report.verifyOutcome === 'unverified' && report.verifyAvailable === false) return null;

  const meta = OUTCOME_META[report.verifyOutcome] ?? OUTCOME_META.unverified;
  const quiet = report.verifyOutcome === 'unverified';

  const card = el('div', { class: `tm-result-card ${quiet ? 'rc-quiet' : meta.cls}` });

  // ── Header: status badge + verify command chip + fix rounds (failure case only) ──
  if (!quiet) {
    const head = el('div', { class: 'rc-head' });
    head.append(el('span', { class: `rc-status ${meta.cls}` }, `${meta.icon} ${meta.label}`));
    if (report.verifyCmd) {
      head.append(el('code', { class: 'rc-cmd', title: `Verify command: ${report.verifyCmd}` }, report.verifyCmd));
    }
    if (report.fixRounds > 0) {
      head.append(el('span', { class: 'rc-pill' }, `${report.fixRounds} fix round${report.fixRounds === 1 ? '' : 's'}`));
    }
    card.append(head);
  } else {
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
