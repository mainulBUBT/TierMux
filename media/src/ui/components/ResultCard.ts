// ResultCard — the structured end-of-turn work report (AI Elements "Result"-style).
//
// Renders WorkReportData — the durable, versioned object produced by the agent loop and
// persisted on the transcript entry. The SAME component serves the live turn (posted via the
// `workReport` message) and replay (renderAssistantStatic reads entry.workReport), so both
// paths are pixel-identical by construction.
//
// Deliberately COMPACT: token/model/duration telemetry stays in the message footer where it
// already lives — this card carries only what the footer CAN'T say: verification status,
// what changed, and a one-click action when the work is not yet verified.
//
// Boundary: strict-checked, may only import from media/src/** + src/shared/** (type-only for
// the latter). Host interaction is via callbacks (onDiffFile/onVerify) — no send() here.

import { el } from '../dom';
import { fmtDuration } from '../../format';

// ========== Types ==========

import type { WorkReportData } from '../../../../src/shared/workReport';

export interface ResultCardOptions {
  /** Click on a changed file → host opens checkpoint↔current diff. Absent ⇒ rows are inert. */
  onDiffFile?: (path: string) => void;
  /** Click on the verify action → host re-runs the project's check command and reports the
   *  outcome as its own bubble. Offered whenever the turn ended without a verified pass. */
  onVerify?: () => void;
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

/** Build the card from the WHOLE report object. Returns NULL when there is nothing the user
 *  needs to be told — a verified pass is the expected outcome, not news (the agent always
 *  verifies when it can), so success renders SILENT. The card only speaks when it changes
 *  what the user should do next: untested work (Run checks) or a failed gate (Re-run). */
export function createResultCard(report: WorkReportData, opts?: ResultCardOptions): HTMLElement | null {
  if (report.verifyOutcome === 'verified' || report.verifyOutcome === 'changes-only') return null;

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
  }

  // ── Verify action — the card's reason to exist: turn "untested/failed" into ONE click. ──
  if (opts?.onVerify) {
    const actions = el('div', { class: 'rc-actions' });
    if (quiet) {
      actions.append(el('span', { class: 'rc-hint' }, 'Not tested yet'));
    }
    actions.append(el('button', {
      class: 'rc-verify-btn',
      title: report.verifyOutcome === 'failed'
        ? 'Run the verify command again to see the current failures'
        : 'Look for a test/build command in this workspace and run it',
      onClick: () => opts.onVerify!(),
    }, report.verifyOutcome === 'failed' ? '↻ Re-run checks' : '▶ Run checks'));
    card.append(actions);
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
