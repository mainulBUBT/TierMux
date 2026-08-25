/** Visual preview harness for ResultCard — builds the three outcome cases with mock reports
 *  so the rendered card can be inspected in a plain browser (dist/resultCardPreview.html). */
import { createResultCard } from '../media/src/ui/components';
import type { WorkReportData } from '../src/shared/workReport';

const telemetry = (over: Partial<WorkReportData['telemetry']>) => ({
  model: 'cloudflare/@cf/openai/gpt-oss-120b',
  taskKind: 'agent' as const,
  inputTokens: 224_100, outputTokens: 1_900, toolCalls: 5, thoughts: 0, failovers: 5,
  elapsedMs: 63_000, ...over,
});

const report = (over: Partial<WorkReportData>): WorkReportData => ({
  version: 1, verifyOutcome: 'unverified', fixRounds: 0, changedFiles: [], toolTally: [],
  stopReason: '', telemetry: telemetry({}), ...over,
} as WorkReportData);

const section = (label: string, ...nodes: HTMLElement[]) => {
  const box = document.createElement('div');
  box.className = 'pv-case';
  const h = document.createElement('div');
  h.className = 'pv-label'; h.textContent = label;
  box.append(h, ...nodes);
  // A stand-in for the message footer the card sits above.
  const foot = document.createElement('div');
  foot.className = 'pv-foot';
  foot.textContent = 'cloudflare/@cf/openai/gpt-oss-120b  ·  224.1k in · 1.9k out  ·  1m 3s  ·  ⟳ 5';
  box.append(foot);
  return box;
};

const opts = { onDiffFile: () => {} };

document.body.append(
  section('untested turn (quiet CTA)', createResultCard(report({
    verifyOutcome: 'unverified',
    changedFiles: [{ path: 'solar-system.html', status: 'M' }],
  }), opts)),
  section('verified turn', createResultCard(report({
    verifyOutcome: 'verified', verifyCmd: 'npm run build', fixRounds: 1,
    changedFiles: [{ path: 'src/app.ts', status: 'M' }, { path: 'src/new.ts', status: 'A' }],
  }), opts)),
  section('failed turn', createResultCard(report({
    verifyOutcome: 'failed', verifyCmd: 'npm test', fixRounds: 2,
    changedFiles: [{ path: 'src/app.ts', status: 'M' }],
  }), opts)),
);
