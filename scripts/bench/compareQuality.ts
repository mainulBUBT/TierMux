/* Merge gate: compare two quality runs and decide whether a change may land.
 *
 * This is the mechanical form of the rule in docs/BENCHMARK.md — "any proposal must show
 * benchmark results before merge" — so the decision is a command's exit code rather than an
 * argument. Exit 0 = MERGE, exit 1 = REJECT.
 *
 * Usage:
 *   npm run bench:quality:compare -- .benchmarks/quality/<before>.json .benchmarks/quality/<after>.json
 */
import * as fs from 'fs';
import type { QualityRun } from './qualityTypes';

/** Percentage points a metric may move before it counts as a real change rather than judge
 *  noise. A 20-query run moves 5pp when a single query flips, so anything smaller is not signal. */
const NOISE_PP = 5;

function loadRun(file: string): QualityRun {
  const run = JSON.parse(fs.readFileSync(file, 'utf8')) as QualityRun;
  if (run.schemaVersion !== 1) throw new Error(`${file}: unsupported schemaVersion ${run.schemaVersion}`);
  return run;
}

function delta(before: number, after: number): string {
  const d = after - before;
  const arrow = Math.abs(d) < NOISE_PP ? '  ' : d > 0 ? '✅' : '❌';
  return `${arrow} ${d >= 0 ? '+' : ''}${d.toFixed(1)}pp`;
}

function row(label: string, before: number, after: number, unit = '%'): void {
  console.log(
    `  ${label.padEnd(20)} ${`${before.toFixed(1)}${unit}`.padStart(9)} → ${`${after.toFixed(1)}${unit}`.padStart(9)}   ${delta(before, after)}`,
  );
}

function main(): void {
  const [beforeFile, afterFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!beforeFile || !afterFile) {
    console.error('Usage: npm run bench:quality:compare -- <before.json> <after.json>');
    process.exit(2);
  }
  const before = loadRun(beforeFile);
  const after = loadRun(afterFile);

  const warnings: string[] = [];
  // A comparison across different datasets, projects, agent models, or judges is not a
  // comparison — say so rather than printing an authoritative-looking delta.
  if (before.project !== after.project) warnings.push(`different projects (${before.project} vs ${after.project})`);
  if (before.config.dataset !== after.config.dataset) warnings.push('different datasets');
  if (before.config.model !== after.config.model) warnings.push(`different agent models (${before.config.model} vs ${after.config.model})`);
  if (before.config.judgeModel !== after.config.judgeModel) warnings.push('different judge models');
  if (before.summary.total !== after.summary.total) warnings.push(`different query counts (${before.summary.total} vs ${after.summary.total})`);

  const b = before.summary;
  const a = after.summary;

  console.log(`\n════════ Quality delta ════════`);
  console.log(`before: ${before.variant} (${before.gitSha})   after: ${after.variant} (${after.gitSha})`);
  if (warnings.length) {
    console.log('\n⚠ NOT A CLEAN COMPARISON:');
    for (const w of warnings) console.log(`   - ${w}`);
  }
  console.log('');
  row('Retrieval', b.retrievalPct, a.retrievalPct);
  row('Reasoning', b.reasoningPct, a.reasoningPct);
  row('Answer', b.answerPct, a.answerPct);
  console.log('');
  row('Grep fallback', b.efficiency.grepFallbackRate * 100, a.efficiency.grepFallbackRate * 100);
  row('Window reads', b.efficiency.windowReadRate * 100, a.efficiency.windowReadRate * 100);
  row('Tool errors', b.efficiency.toolErrorRate * 100, a.efficiency.toolErrorRate * 100);
  row('Avg tool calls', b.efficiency.avgToolCalls, a.efficiency.avgToolCalls, '');
  row('Avg context chars', b.efficiency.avgContextChars, a.efficiency.avgContextChars, '');

  // Per-query flips — where the aggregate delta actually came from.
  const beforeById = new Map(before.queries.map((q) => [q.queryId, q]));
  const flips = after.queries
    .map((q) => ({ q, prev: beforeById.get(q.queryId) }))
    .filter(({ q, prev }) => prev && (prev.scores.retrieval !== q.scores.retrieval || prev.scores.answer !== q.scores.answer));
  if (flips.length) {
    console.log('\nflipped queries:');
    for (const { q, prev } of flips) {
      console.log(
        `  ${q.queryId.padEnd(4)} ret ${prev!.scores.retrieval}→${q.scores.retrieval}  ans ${prev!.scores.answer}→${q.scores.answer}   ${q.query.slice(0, 60)}`,
      );
    }
  }

  // Merge criteria, verbatim from BENCHMARK.md:
  //   - Retrieval does not regress
  //   - Reasoning improves OR Answer improves
  //   - Tool calls do not increase significantly
  const retrievalHeld = a.retrievalPct >= b.retrievalPct - NOISE_PP;
  const qualityImproved =
    a.reasoningPct > b.reasoningPct + NOISE_PP || a.answerPct > b.answerPct + NOISE_PP;
  const toolCallsHeld = a.efficiency.avgToolCalls <= b.efficiency.avgToolCalls * 1.2;

  const reasons: string[] = [];
  if (!retrievalHeld) reasons.push(`retrieval regressed (${b.retrievalPct.toFixed(1)}% → ${a.retrievalPct.toFixed(1)}%)`);
  if (!qualityImproved) reasons.push('neither reasoning nor answer improved beyond noise');
  if (!toolCallsHeld) reasons.push(`avg tool calls up >20% (${b.efficiency.avgToolCalls.toFixed(1)} → ${a.efficiency.avgToolCalls.toFixed(1)})`);

  console.log('');
  if (reasons.length === 0) {
    console.log('✓ MERGE — retrieval held, quality improved, tool cost flat.');
    if (warnings.length) console.log('  (…but see the comparability warnings above.)');
    process.exit(0);
  }
  console.log('✗ REJECT');
  for (const r of reasons) console.log(`   - ${r}`);
  console.log('\nBENCHMARK.md: a change that does not improve reasoning or answer, or that costs');
  console.log('retrieval or tool calls, is complexity without payoff.');
  process.exit(1);
}

main();
