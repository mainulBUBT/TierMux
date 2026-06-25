/**
 * Benchmark report writer — emits runs.jsonl, scores.md, and summary.json.
 * Output dir is created on demand. Formulas mirror BENCHMARK_QUERIES.md (lines 175-186).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { QueryResult } from './runner';
import type { TelemetrySnapshot } from '../context/telemetry';

export interface CategoryScore {
  n: number;
  retrieval: number; // %
  reasoning: number; // %
  answer: number; // %
  overall: number; // %
}

/** Provenance metadata — makes a 6-month-old score comparable to today's. */
export interface RunMeta {
  label: string;
  generatorModel: string;
  judgeModel: string;
  effort: string;
  temperature: number;
  gitCommit: string; // TierMux repo HEAD (the architecture under test)
  timestamp: string; // ISO
}

export interface BenchSummary {
  run: RunMeta;
  n: number;
  retrieval: number; // %
  reasoning: number; // %
  answer: number; // %
  /** Combined score across chain follow-up steps (memory test). null if no chains run. */
  continuation: number | null;
  /** Only for the `consistency` scope: spread of per-run overall scores (lower = more deterministic). null otherwise. */
  consistencySpread: number | null;
  /** Median of overall scores across repeated base queries (e.g. E1#1/E1#2/E1#3).
   *  Robust to judge outliers — prefer over `overall` when the dataset has repeats. */
  medianOverall: number | null;
  /** Median of reasoning scores across repeated base queries. */
  medianReasoning: number | null;
  /** Median of answer scores across repeated base queries. */
  medianAnswer: number | null;
  /** Fraction of queries that exercised the index/semantic pipeline (codebaseSearch or
   *  searchWorkspace). Low = the agent succeeds but the index stack isn't being used,
   *  so retrieval scores are coming from raw file reads. Reported as a % (0–100). */
  retrievalPipelineUsage: number;
  overall: number; // mean of retrieval/reasoning/answer
  /** Number of queries that hit the 120s wall-clock cap.
   *  These are performance/planner failures — their answer/reasoning scores are 0 not
   *  because the model is wrong but because it ran out of time. Track separately so
   *  you can distinguish: timedOut=true → planner problem; timedOut=false,answer=0 → model problem. */
  timedOutCount: number;
  pass: boolean;
  passRetrieval: boolean;
  passReasoning: boolean;
  passAnswer: boolean;
  diagnosis: string;
  /** Per-category breakdown (Explain / Bug / Feature / Refactor / Follow-up). */
  byCategory: Record<string, CategoryScore>;
  telemetry: TelemetrySnapshot;
}

const PASS = { retrieval: 85, reasoning: 80, answer: 80 };

export function writeReports(outDir: string, results: QueryResult[], meta: RunMeta): { runsPath: string; scoresPath: string; summaryPath: string; summary: BenchSummary } {
  fs.mkdirSync(outDir, { recursive: true });

  const runsPath = path.join(outDir, 'runs.jsonl');
  fs.writeFileSync(runsPath, results.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const scoresPath = path.join(outDir, 'scores.md');
  fs.writeFileSync(scoresPath, renderScores(results, meta), 'utf8');

  const summary = summarize(results, meta);
  const summaryPath = path.join(outDir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  return { runsPath, scoresPath, summaryPath, summary };
}

export function summarize(results: QueryResult[], meta: RunMeta): BenchSummary {
  const sumRetrieval = results.reduce((s, r) => s + r.retrieval, 0);
  const sumReasoning = results.reduce((s, r) => s + r.reasoningScore, 0);
  const sumAnswer = results.reduce((s, r) => s + r.answerScore, 0);
  const count = results.length;

  const retrieval = count ? Math.round((sumRetrieval / count) * 1000) / 10 : 0;
  const reasoning = count ? Math.round((sumReasoning / count) * 1000) / 10 : 0;
  const answer = count ? Math.round((sumAnswer / count) * 1000) / 10 : 0;
  const overall = Math.round(((retrieval + reasoning + answer) / 3) * 10) / 10;

  // Continuation: combined score across chain FOLLOW-UP steps (steps 2+) — these
  // depend on conversation memory. null when no chains were run.
  const followUps = results.filter((r) => r.chainFollowUp);
  const continuation = followUps.length
    ? Math.round((followUps.reduce((s, r) => s + (r.retrieval + r.reasoningScore + r.answerScore) / 3, 0) / followUps.length) * 1000) / 10
    : null;

  const passRetrieval = retrieval >= PASS.retrieval;
  const passReasoning = reasoning >= PASS.reasoning;
  const passAnswer = answer >= PASS.answer;
  const pass = passRetrieval && passReasoning && passAnswer;

  // Average telemetry across queries.
  const telemetry = avgTelemetry(results);

  // Consistency spread: for the `consistency` scope (same query × N), report the
  // max−min of per-run overall scores. 0 = perfectly deterministic. null otherwise.
  const consistencySpread = detectConsistencySpread(results);

  // Medians across repeated base queries. null if no repeats. Median is far more
  // robust than mean to a single judge outlier (e.g. one 0 in a {1,1,0} triple).
  const { medianOverall, medianReasoning, medianAnswer } = detectMedians(results);

  // Fraction of queries that exercised the index/semantic pipeline. % of total queries
  // (follow-ups excluded? no — follow-ups also count, since the pipeline should fire there too).
  const pipeHits = results.filter((r) => r.pipelineUsed).length;
  const retrievalPipelineUsage = count ? Math.round((pipeHits / count) * 1000) / 10 : 0;

  const timedOutCount = results.filter((r) => r.timedOut).length;

  const byCategory = breakdownByCategory(results);
  const diagnosis = diagnose(retrieval, reasoning, answer, continuation, pass, retrievalPipelineUsage, timedOutCount);

  return { run: meta, n: count, retrieval, reasoning, answer, continuation, consistencySpread, medianOverall, medianReasoning, medianAnswer, retrievalPipelineUsage, timedOutCount, overall, pass, passRetrieval, passReasoning, passAnswer, diagnosis, byCategory, telemetry };
}

/** When the same base query was run multiple times (ids like E1#1, E1#2, …), return the spread of overall scores. */
function detectMedians(results: QueryResult[]): { medianOverall: number | null; medianReasoning: number | null; medianAnswer: number | null } {
  const base = (id: string): string => id.split('#')[0];
  const groupOverall = new Map<string, number[]>();
  const groupReasoning = new Map<string, number[]>();
  const groupAnswer = new Map<string, number[]>();
  for (const r of results) {
    if (!r.id.includes('#')) continue;
    const b = base(r.id);
    push(groupOverall, b, (r.retrieval * 100 + r.reasoningScore * 100 + r.answerScore * 100) / 3);
    push(groupReasoning, b, r.reasoningScore * 100);
    push(groupAnswer, b, r.answerScore * 100);
  }
  if (groupOverall.size === 0) return { medianOverall: null, medianReasoning: null, medianAnswer: null };
  return {
    medianOverall: avgMedian(groupOverall),
    medianReasoning: avgMedian(groupReasoning),
    medianAnswer: avgMedian(groupAnswer),
  };
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Average the per-group medians. One median per repeated base query, then mean
 *  across groups — so a 5× repeat of E1 and a 3× repeat of E2 each get one vote. */
function avgMedian(groups: Map<string, number[]>): number {
  const meds: number[] = [];
  for (const arr of groups.values()) meds.push(median(arr));
  return Math.round((meds.reduce((s, v) => s + v, 0) / meds.length) * 10) / 10;
}

/** When the same base query was run multiple times (ids like E1#1, E1#2, …), return the spread of overall scores. */
function detectConsistencySpread(results: QueryResult[]): number | null {
  const base = (id: string): string => id.split('#')[0];
  const runsByBase = new Map<string, number[]>();
  for (const r of results) {
    if (!r.id.includes('#')) continue;
    const b = base(r.id);
    const overallRun = (r.retrieval * 100 + r.reasoningScore * 100 + r.answerScore * 100) / 3;
    if (!runsByBase.has(b)) runsByBase.set(b, []);
    runsByBase.get(b)!.push(overallRun);
  }
  if (runsByBase.size === 0) return null;
  // Report the largest spread across any repeated base query.
  let maxSpread = 0;
  for (const vals of runsByBase.values()) {
    if (vals.length < 2) continue;
    maxSpread = Math.max(maxSpread, Math.round((Math.max(...vals) - Math.min(...vals)) * 10) / 10);
  }
  return maxSpread;
}

/** Map a query id to its category label. */
function categoryOf(id: string): string {
  const c = id.charAt(0);
  switch (c) {
    case 'E': return 'Explain';
    case 'B': return 'Bug Fix';
    case 'F': return 'Feature';
    case 'R': return 'Refactor';
    case 'C': return 'Follow-up';
    default: return 'Other';
  }
}

function breakdownByCategory(results: QueryResult[]): Record<string, CategoryScore> {
  const groups = new Map<string, QueryResult[]>();
  for (const r of results) {
    const cat = categoryOf(r.id);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(r);
  }
  const out: Record<string, CategoryScore> = {};
  for (const [cat, rs] of groups) {
    const n = rs.length;
    const retrieval = Math.round((rs.reduce((s, r) => s + r.retrieval, 0) / n) * 1000) / 10;
    const reasoning = Math.round((rs.reduce((s, r) => s + r.reasoningScore, 0) / n) * 1000) / 10;
    const answer = Math.round((rs.reduce((s, r) => s + r.answerScore, 0) / n) * 1000) / 10;
    out[cat] = { n, retrieval, reasoning, answer, overall: Math.round(((retrieval + reasoning + answer) / 3) * 10) / 10 };
  }
  return out;
}

function diagnose(retrieval: number, reasoning: number, _answer: number, continuation: number | null, pass: boolean, retrievalPipelineUsage: number, timedOutCount: number): string {
  const timeoutNote = timedOutCount > 0 ? ` (${timedOutCount} queries timed out — planner/performance problem, not model quality)` : '';
  if (pass) return `MVP PASSED — all three thresholds met; architecture can be frozen.${timeoutNote}`;
  // Timeouts dominate — performance issue, not model quality.
  if (timedOutCount > 0 && reasoning < PASS.reasoning) {
    return `${timedOutCount} queries timed out (120s cap) — planner loop issue. Pattern: retrieval=1,timedOut=true → symbolIndex/pre-research not firing; model doing blind grep→read loops. Fix: check informationRouter routing + invertedIndex freshness.`;
  }
  // Chain-only failure → memory subsystem, not retrieval/reasoning.
  if (continuation !== null && continuation < 75 && retrieval >= PASS.retrieval && reasoning >= PASS.reasoning) {
    return `Conversation memory issue — single-shot retrieval+reasoning OK but chain follow-ups fail; inspect conversationMemory / executionTracker.${timeoutNote}`;
  }
  // Retrieval scores OK but the index stack was bypassed — agent is brute-forcing with
  // raw file reads. Pass the bench but the index subsystem is unvalidated.
  if (retrieval >= PASS.retrieval && retrievalPipelineUsage < 30) {
    return `Retrieval high (${retrieval}%) but index pipeline exercised in only ${retrievalPipelineUsage}% of queries — agent is brute-forcing with raw file reads; symbolIndex / bundleCache / invertedIndex not firing. Check pre-research path in agent.ts (route.needsRetrieval, searchTerms extraction).${timeoutNote}`;
  }
  if (retrieval < PASS.retrieval) return `Retrieval pipeline issue — fix symbol index / alias / grep threshold.${timeoutNote}`;
  if (reasoning < PASS.reasoning) return `Free-model bottleneck — retrieval OK but reasoning weak; tune model routing.${timeoutNote}`;
  return `Answer quality below threshold — retrieval + reasoning OK; improve prompt/templates.${timeoutNote}`;
}

function avgTelemetry(results: QueryResult[]): TelemetrySnapshot {
  const n = results.length || 1;
  const keys: (keyof TelemetrySnapshot)[] = [
    'totalRequests', 'totalToolCalls', 'symbolIndexHits', 'bundleCacheHits', 'invertedIndexHits',
    'grepCalls', 'largeContextReads', 'windowReads', 'fullFileReads',
  ];
  const avg = {} as TelemetrySnapshot;
  for (const k of keys) avg[k] = Math.round(results.reduce((s, r) => s + (r.telemetry[k] as number), 0) / n);
  // Re-derive rates from averaged counts so they stay consistent.
  const t = avg.totalRequests || 1;
  const reads = (avg.windowReads + avg.fullFileReads) || 1;
  avg.symbolHitRate = Math.round((avg.symbolIndexHits / t) * 100);
  avg.grepRate = Math.round((avg.grepCalls / t) * 100);
  avg.windowReadRate = Math.round((avg.windowReads / reads) * 100);
  avg.fullFileReadRate = Math.round((avg.fullFileReads / reads) * 100);
  avg.cacheHitRate = Math.round((avg.bundleCacheHits / t) * 100);
  avg.largeReadRate = Math.round((avg.largeContextReads / t) * 100);
  avg.avgToolCalls = Math.round((avg.totalToolCalls / t) * 10) / 10;
  return avg;
}

function renderScores(results: QueryResult[], meta: RunMeta): string {
  const s = summarize(results, meta);
  const lines: string[] = [];
  lines.push(`# Benchmark Scores — ${meta.label}`);
  lines.push('');
  lines.push(`- Generator: \`${meta.generatorModel}\`  ·  Effort: \`${meta.effort}\`  ·  Judge: \`${meta.judgeModel}\`  ·  temperature ${meta.temperature}`);
  lines.push(`- TierMux commit \`${meta.gitCommit}\`  ·  ${meta.timestamp}`);
  lines.push(`- Queries: ${results.length}`);
  lines.push('');
  lines.push('| Query | Retrieval | Pipeline | Reasoning | Answer | Timeout | Retrieved | Judge note |');
  lines.push('|-------|-----------|----------|-----------|--------|---------|-----------|------------|');
  for (const r of results) {
    const note = (r.judgeExplanation || '—').replace(/\|/g, '\\|').slice(0, 80);
    const flag = r.chainFollowUp ? ' ↳' : '';
    const timeout = r.timedOut ? '⏱' : '·';
    lines.push(`| ${r.id}${flag} | ${r.retrieval} | ${r.pipelineUsed ? '✓' : '·'} | ${r.reasoningScore} | ${r.answerScore} | ${timeout} | ${(r.retrieved.join(', ') || '—')} | ${note} |`);
  }
  lines.push('');
  lines.push('**Totals (%):**');
  lines.push(`- Retrieval: ${s.retrieval}% ${mark(s.passRetrieval)}`);
  lines.push(`- Retrieval pipeline usage (codebaseSearch / searchWorkspace): ${s.retrievalPipelineUsage}%`);
  lines.push(`- Reasoning: ${s.reasoning}% ${mark(s.passReasoning)}`);
  lines.push(`- Answer: ${s.answer}% ${mark(s.passAnswer)}`);
  if (s.continuation !== null) lines.push(`- Continuation (chain follow-ups): ${s.continuation}%`);
  lines.push(`- Overall (mean): ${s.overall}%`);
  if (s.timedOutCount > 0) lines.push(`- ⏱ Timed out (120s cap): ${s.timedOutCount}/${results.length} queries — planner/performance problem, scores for these are 0 (not model quality)`);
  if (s.medianOverall !== null) {
    lines.push(`- Overall (median, robust to judge outliers): ${s.medianOverall}%`);
    lines.push(`- Consistency spread (max−min overall across repeats): ${s.consistencySpread ?? 0}`);
  }
  lines.push('');
  lines.push('**By category (% overall):**');
  lines.push('| Category | n | Retrieval | Reasoning | Answer | Overall |');
  lines.push('|----------|---|-----------|-----------|--------|---------|');
  for (const [cat, c] of Object.entries(s.byCategory)) {
    lines.push(`| ${cat} | ${c.n} | ${c.retrieval} | ${c.reasoning} | ${c.answer} | ${c.overall} |`);
  }
  lines.push('');
  lines.push(`**Result: ${s.pass ? 'PASS ✅' : 'FAIL ❌'}**`);
  lines.push('');
  lines.push(`Diagnosis: ${s.diagnosis}`);
  lines.push('');
  lines.push('Telemetry (avg per query): ' +
    `symbolHits ${s.telemetry.symbolIndexHits} · ` +
    `invertedIndexHits ${s.telemetry.invertedIndexHits} · ` +
    `grepCalls ${s.telemetry.grepCalls} · ` +
    `windowReadRate ${s.telemetry.windowReadRate}% · ` +
    `fullFileReads ${s.telemetry.fullFileReads} · ` +
    `avgToolCalls ${s.telemetry.avgToolCalls}`);
  return lines.join('\n') + '\n';
}

function mark(ok: boolean): string { return ok ? '✓' : '✗'; }
