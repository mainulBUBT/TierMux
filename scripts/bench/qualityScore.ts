/* Retrieval scoring, efficiency metrics, and run aggregation for the quality benchmark.
 *
 * Retrieval is deterministic on purpose (see judge.ts): it compares the agent's tool trace
 * against the dataset's ground-truth paths. That makes the metric reproducible — the same run
 * re-scored later gives the same number — and it makes a failure diagnosable, because
 * `missedFiles` says exactly which file the agent never opened.
 */
import { RETRIEVAL_TOOLS, normalizePath } from './agentHarness';
import type {
  EfficiencyStats,
  QualityCategory,
  QualityQuery,
  QualityResult,
  QualitySummary,
  TraceEntry,
} from './qualityTypes';
import { TARGETS } from './qualityTypes';

/** A ground-truth path counts as touched when it matches a trace path as a suffix — the trace
 *  may hold "src/router/router.ts" or an absolute form of it, and ground truth is always
 *  workspace-relative. Suffix (not substring) so "router.ts" can't be satisfied by
 *  "other/router.ts" when the dataset asked for "src/router/router.ts". */
function touchedBy(expected: string, touched: string[]): boolean {
  const want = normalizePath(expected);
  return touched.some((t) => t === want || t.endsWith(`/${want}`) || want.endsWith(`/${t}`));
}

export interface RetrievalOutcome {
  score: 0 | 1;
  missed: string[];
}

export interface RetrievalEvidence {
  /** Files the agent deliberately opened (readFile/listDir target, scoped grep). */
  openedFiles: string[];
  /** Files that only appeared inside a search result. */
  seenFiles: string[];
  /** The final answer, used to decide whether a merely-seen file was actually used. */
  answer: string;
}

/** Does the answer actually cite this file — by path or by basename? A file listed among a
 *  hundred grep hits and then referenced in the answer was found; one that is never mentioned
 *  again was just noise in a dump. */
function citedInAnswer(expected: string, answer: string): boolean {
  const rel = normalizePath(expected);
  if (answer.includes(rel)) return true;
  const base = rel.split('/').pop() ?? rel;
  // Bare basenames like "read.ts" are too common to be evidence on their own; require enough
  // specificity that the mention identifies a file rather than a word.
  return base.length >= 8 && answer.includes(base);
}

/** Binary per docs/BENCHMARK.md: 1.0 = correct file/symbol found, 0.0 = not.
 *
 * A file counts as retrieved when the agent OPENED it, or when it appeared in a search result
 * AND the answer goes on to cite it. The second clause is what stops the metric from being
 * free: one unscoped `grep` over the repo puts 150 paths in front of the model, and counting
 * those as retrieval would score ~1.0 for an agent that read nothing and understood nothing.
 * Grepping and then actually using the hit is real retrieval; grepping and ignoring it is not.
 */
export function scoreRetrieval(q: QualityQuery, ev: RetrievalEvidence): RetrievalOutcome {
  const found = (f: string): boolean =>
    touchedBy(f, ev.openedFiles) || (touchedBy(f, ev.seenFiles) && citedInAnswer(f, ev.answer));

  const missed = q.expectFiles.filter((f) => !found(f));
  const anyOf = q.expectAnyOf ?? [];
  if (anyOf.length > 0 && !anyOf.some(found)) missed.push(`(any of: ${anyOf.join(' | ')})`);
  return { score: missed.length === 0 ? 1 : 0, missed };
}

/** True when the first retrieval call of the turn was an unscoped grep — the agent had no
 *  better handle on the codebase than a full-text sweep. A grep scoped to a path (or one that
 *  follows a glob/list) is targeted search, not a fallback, and does not count. */
export function usedGrepFallback(trace: TraceEntry[]): boolean {
  const first = trace.find((t) => RETRIEVAL_TOOLS.has(t.name));
  return !!first && first.name === 'grep' && first.paths.length === 0;
}

export function efficiency(results: QualityResult[]): EfficiencyStats {
  const scorable = results.filter((r) => r.trace.length > 0);
  const grepFallbacks = scorable.filter((r) => usedGrepFallback(r.trace)).length;

  // Successful reads only: a call that errored (wrong tool name, missing file) tells you
  // nothing about window discipline and would otherwise dilute the rate in either direction.
  const reads = results.flatMap((r) => r.trace.filter((t) => t.name === 'readFile' && !t.error));
  const windowed = reads.filter((t) => t.windowed).length;

  const allCalls = results.flatMap((r) => r.trace);
  const totalChars = results.reduce((s, r) => s + r.trace.reduce((a, t) => a + t.outputChars, 0), 0);

  return {
    grepFallbackRate: scorable.length ? grepFallbacks / scorable.length : 0,
    // No reads at all → report 1 rather than 0: a run that never called readFile has no window
    // discipline to fail, and a spurious 0% would trip the gate for the wrong reason. Always
    // read this together with readCount — 100% over 0 reads is not a pass, it is no data.
    windowReadRate: reads.length ? windowed / reads.length : 1,
    readCount: reads.length,
    toolErrorRate: allCalls.length ? allCalls.filter((t) => t.error).length / allCalls.length : 0,
    avgToolCalls: results.length ? allCalls.length / results.length : 0,
    avgContextChars: results.length ? totalChars / results.length : 0,
  };
}

function pct(sum: number, n: number): number {
  return n ? (sum / n) * 100 : 0;
}

/** The BENCHMARK.md diagnosis table, applied to a finished run. */
function diagnose(retrieval: number, reasoning: number, answer: number): string {
  const rOk = retrieval >= TARGETS.retrievalPct;
  const reasonOk = reasoning >= TARGETS.reasoningPct;
  const aOk = answer >= TARGETS.answerPct;
  if (rOk && reasonOk && aOk) return 'MVP PASSED — all three targets met; architecture freeze confirmed.';
  if (!rOk && reasoning >= TARGETS.reasoningPct) {
    return 'Retrieval is the bottleneck — fix the retrieval pipeline (symbol index / alias / grep logic) before touching prompts or models.';
  }
  if (rOk && !reasonOk) {
    return 'Retrieval is fine, reasoning is not — model/prompt bottleneck. Fix = task-aware model routing, not another retrieval layer.';
  }
  if (rOk && reasonOk && !aOk) {
    return 'Right files, sound reasoning, unacceptable answers — prompt/response-shape issue, not architecture.';
  }
  return 'Both retrieval and reasoning below target — fix retrieval first; reasoning numbers are unreliable while the model is reading the wrong files.';
}

export function summarizeQuality(results: QualityResult[]): QualitySummary {
  const n = results.length;
  const completed = results.filter((r) => r.ok).length;

  const retrievalPct = pct(results.reduce((s, r) => s + r.scores.retrieval, 0), n);
  const reasoningPct = pct(results.reduce((s, r) => s + r.scores.reasoning, 0), n);
  const answerPct = pct(results.reduce((s, r) => s + r.scores.answer, 0), n);

  const cats = [...new Set(results.map((r) => r.category))] as QualityCategory[];
  const byCategory = cats.map((category) => {
    const rows = results.filter((r) => r.category === category);
    return {
      category,
      n: rows.length,
      retrievalPct: pct(rows.reduce((s, r) => s + r.scores.retrieval, 0), rows.length),
      reasoningPct: pct(rows.reduce((s, r) => s + r.scores.reasoning, 0), rows.length),
      answerPct: pct(rows.reduce((s, r) => s + r.scores.answer, 0), rows.length),
    };
  });

  const eff = efficiency(results);
  const pass = {
    retrieval: retrievalPct >= TARGETS.retrievalPct,
    reasoning: reasoningPct >= TARGETS.reasoningPct,
    answer: answerPct >= TARGETS.answerPct,
    grepFallback: eff.grepFallbackRate * 100 < TARGETS.grepFallbackRatePct,
    // A run with no successful reads has not demonstrated window discipline — don't pass it.
    windowRead: eff.readCount > 0 && eff.windowReadRate * 100 > TARGETS.windowReadRatePct,
    overall: false,
  };
  // "MVP PASSED" is the three quality targets only — the efficiency numbers are reported and
  // gate merges (see compareQuality.ts) but were never part of the pass criteria.
  pass.overall = pass.retrieval && pass.reasoning && pass.answer;

  return {
    total: n,
    completed,
    retrievalPct,
    reasoningPct,
    answerPct,
    efficiency: eff,
    byCategory,
    pass,
    diagnosis: diagnose(retrievalPct, reasoningPct, answerPct),
  };
}
