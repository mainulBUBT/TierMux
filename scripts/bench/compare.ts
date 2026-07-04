/* Compare two BenchRun JSON files and print a regression report.
 *
 * Usage (after bundling):
 *   node dist/benchCompare.cjs .benchmarks/<a>.json .benchmarks/<b>.json
 *
 *   npm run bench:compare -- .benchmarks/a.json .benchmarks/b.json
 *
 * Prints per-aggregate delta (success rate, p50/p95/p99 latency, TTFT, tokens)
 * plus the per-query diff for queries that flipped ok↔fail or changed the
 * selected model. Regression rows are flagged with ❌, improvements ✅.
 */
import * as fs from 'fs';
import type { BenchRun, Percentiles } from './types';

function loadRun(file: string): BenchRun {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as BenchRun;
}

interface MetricRow {
  label: string;
  baseline: number;
  changed: number;
  /** lower-is-better (latency) vs higher-is-better (success rate). */
  lowerBetter: boolean;
  /** For percent values already in 0..100. Just changes formatting. */
  isPercent?: boolean;
  /** Plain integer count (tokens) — no unit suffix. */
  isCount?: boolean;
}

function pctDelta(base: number, changed: number): number {
  if (base === 0) return changed === 0 ? 0 : Infinity;
  return ((changed - base) / base) * 100;
}

function fmtNum(n: number, isPercent?: boolean, isCount?: boolean): string {
  if (n < 0) return '—';
  if (isPercent) return `${n.toFixed(1)}%`;
  if (isCount) return `${Math.round(n)}`;
  return `${Math.round(n)}ms`;
}

function fmtDelta(base: number, changed: number, lowerBetter: boolean): string {
  const d = changed - base;
  const dp = pctDelta(base, changed);
  if (!Number.isFinite(dp)) return '   —   ';
  const sign = d > 0 ? '+' : '';
  const arrow = d === 0 ? '  ' : lowerBetter ? (d > 0 ? '❌' : '✅') : d > 0 ? '✅' : '❌';
  return `${arrow} ${sign}${dp.toFixed(1)}%`;
}

function printSection(title: string, rows: MetricRow[]): void {
  console.log(`\n── ${title} ──────────────────────────────────────────`);
  console.log('  metric                 baseline      changed        delta');
  for (const r of rows) {
    const baseS = fmtNum(r.baseline, r.isPercent, r.isCount).padStart(10);
    const changedS = fmtNum(r.changed, r.isPercent, r.isCount).padStart(10);
    console.log(
      `  ${r.label.padEnd(22)} ${baseS}     ${changedS}     ${fmtDelta(r.baseline, r.changed, r.lowerBetter)}`,
    );
  }
}

function percentileRows(label: string, base: Percentiles, changed: Percentiles, lowerBetter = true): MetricRow[] {
  return [
    { label: `${label} p50`, baseline: base.p50, changed: changed.p50, lowerBetter },
    { label: `${label} p95`, baseline: base.p95, changed: changed.p95, lowerBetter },
    { label: `${label} p99`, baseline: base.p99, changed: changed.p99, lowerBetter },
    { label: `${label} avg`, baseline: base.avg, changed: changed.avg, lowerBetter },
  ];
}

function main(): void {
  const [aFile, bFile] = process.argv.slice(2);
  if (!aFile || !bFile) {
    console.error('Usage: bench:compare <baseline.json> <changed.json>');
    process.exit(1);
  }
  const a = loadRun(aFile);
  const b = loadRun(bFile);

  console.log(`baseline: ${a.runId}  (${a.summary.succeeded}/${a.summary.total} ok)`);
  console.log(`changed:  ${b.runId}  (${b.summary.succeeded}/${b.summary.total} ok)`);

  // Aggregate deltas.
  const sa = a.summary;
  const sb = b.summary;
  printSection('Aggregate', [
    { label: 'success rate', baseline: sa.successRate * 100, changed: sb.successRate * 100, lowerBetter: false, isPercent: true },
    { label: 'failover rate', baseline: sa.failoverRate * 100, changed: sb.failoverRate * 100, lowerBetter: true, isPercent: true },
    ...percentileRows('latency', sa.latency, sb.latency),
    ...percentileRows('ttft', sa.ttft, sb.ttft),
    { label: 'tokens prompt', baseline: sa.tokens.totalPrompt, changed: sb.tokens.totalPrompt, lowerBetter: true, isCount: true },
    { label: 'tokens completion', baseline: sa.tokens.totalCompletion, changed: sb.tokens.totalCompletion, lowerBetter: true, isCount: true },
  ]);

  // Per-query flips: ok↔fail and model changes.
  const byId = new Map(b.queries.map((q) => [q.queryId, q]));
  const flips: string[] = [];
  const modelChanges: string[] = [];
  const bigLatency: string[] = [];
  for (const qa of a.queries) {
    const qb = byId.get(qa.queryId);
    if (!qb) continue;
    if (qa.ok !== qb.ok) flips.push(`  ${qa.queryId}: ${qa.ok ? 'ok' : 'FAIL'} → ${qb.ok ? 'ok' : 'FAIL'}`);
    if (qa.ok && qb.ok && qa.selectedModel !== qb.selectedModel) {
      modelChanges.push(`  ${qa.queryId}: ${qa.selectedModel} → ${qb.selectedModel}`);
    }
    if (qa.ok && qb.ok && qa.latencyMs > 0) {
      const d = pctDelta(qa.latencyMs, qb.latencyMs);
      if (Number.isFinite(d) && Math.abs(d) >= 50) {
        bigLatency.push(`  ${qa.queryId}: ${qa.latencyMs}ms → ${qb.latencyMs}ms (${d > 0 ? '+' : ''}${d.toFixed(0)}%)`);
      }
    }
  }
  if (flips.length) {
    console.log('\n── ok↔fail flips ──────────────────────────────────');
    console.log(flips.join('\n'));
  }
  if (modelChanges.length) {
    console.log('\n── model routing changes ─────────────────────────');
    console.log(modelChanges.join('\n'));
  }
  if (bigLatency.length) {
    console.log('\n── latency swings (≥50%) ─────────────────────────');
    console.log(bigLatency.join('\n'));
  }
  if (!flips.length && !modelChanges.length && !bigLatency.length) {
    console.log('\nNo per-query flips, model changes, or large latency swings.');
  }
}

main();
