/* Schema for the QUALITY benchmark — the Retrieval / Reasoning / Answer metrics in
 * docs/BENCHMARK.md.
 *
 * Deliberately separate from ./types.ts. That schema describes the ROUTER benchmark
 * (`npm run bench`): one bare `router.route()` call per query, measuring latency / TTFT /
 * failover — no tools, no workspace, so it cannot say anything about whether the agent found
 * the right file or explained it correctly. This file describes a run of the REAL agent loop
 * (runTurn → tools → workspace) against a dataset that carries retrieval ground truth, which
 * is what the MVP pass criteria are actually written against.
 */

export type QualityCategory = 'explain' | 'bugfix' | 'feature' | 'refactor' | 'followup';

/** Which agent mode a query runs in. The bench is read-only by design: `ask` and `plan` build
 *  the read-only tool set (no write/edit/delete/runCommand), so a 50-query run can never mutate
 *  the project it is measuring — and retrieval is exercised identically either way. */
export type QualityMode = 'ask' | 'plan';

/** One dataset entry: a query plus the ground truth needed to score it without a human. */
export interface QualityQuery {
  id: string;
  category: QualityCategory;
  query: string;
  /** Agent mode (default: 'ask' for explain, 'plan' for everything else). */
  mode?: QualityMode;
  /** Retrieval ground truth: workspace-relative paths the agent MUST touch (read/grep/glob-hit)
   *  for retrieval to score 1.0. Substring match against the touched path, so
   *  "src/router/router.ts" matches an absolute or relative form of the same file. */
  expectFiles: string[];
  /** Optional alternates: touching ANY one of these also counts, on top of `expectFiles`.
   *  Use when two files are equally valid entry points to the same answer. */
  expectAnyOf?: string[];
  /** Optional grading hint handed to the judge — what a correct explanation must contain.
   *  Free text; keep it about the SUBSTANCE, not the wording. */
  rubric?: string;
  /** Prior turns replayed verbatim before the query — the mechanism behind category 5
   *  (follow-up) chains, where the question only makes sense given the previous exchange. */
  context?: { role: 'user' | 'assistant'; content: string }[];
}

export interface QualityDataset {
  /** Project the ground truth was authored against. A dataset is only valid for its project. */
  project: string;
  description?: string;
  queries: QualityQuery[];
}

/** One tool call as observed on the agent's ToolEvent stream. */
export interface TraceEntry {
  name: string;
  /** Paths named in the call's ARGUMENTS — the files the agent deliberately went after. */
  paths: string[];
  /** Paths that merely appeared in the call's OUTPUT (a grep/glob result listing). Kept apart
   *  from `paths` because they are not the same evidence: one broad grep lists a hundred files
   *  the agent never looked at, and counting those as retrieval would make the metric free. */
  hits?: string[];
  /** readFile only: the call passed an explicit offset/limit (a windowed read) rather than
   *  slurping the file's default first-800-lines page. */
  windowed?: boolean;
  /** Characters of tool output returned to the model — the context-growth proxy. */
  outputChars: number;
  error?: string;
}

/** Human/judge scores for one query. */
export interface QualityScores {
  /** 0 or 1 — computed from the tool trace vs `expectFiles`; never judged by a model. */
  retrieval: number;
  /** 0, 0.5 or 1 — judged. */
  reasoning: number;
  /** 0 or 1 — judged. */
  answer: number;
  /** Judge's one-line justification, or 'unscored' when running with --no-judge. */
  rationale?: string;
  /** True when reasoning/answer came from a model judge rather than a human scoring sheet. */
  judged: boolean;
}

export interface QualityResult {
  queryId: string;
  category: QualityCategory;
  query: string;
  mode: QualityMode;
  ok: boolean;
  /** Final answer text (truncated in the JSON to keep run files reviewable). */
  answer: string;
  selectedModel: string;
  latencyMs: number;
  trace: TraceEntry[];
  /** Files the agent actually opened (read/listed), deduped, workspace-relative. */
  openedFiles: string[];
  /** Files that only showed up in a search result. Weaker evidence — see scoreRetrieval. */
  seenFiles: string[];
  /** Which `expectFiles` entries were never retrieved — the retrieval post-mortem. */
  missedFiles: string[];
  scores: QualityScores;
  errorMessage: string | null;
}

/** Efficiency metrics from docs/BENCHMARK.md, computed over the whole run. */
export interface EfficiencyStats {
  /** Fraction of queries whose FIRST retrieval tool call was `grep` — i.e. the agent had no
   *  better idea than a full-text sweep. Target < 20%. */
  grepFallbackRate: number;
  /** Fraction of SUCCESSFUL readFile calls that passed offset/limit instead of pulling a
   *  default page. Target > 80%. Read `readCount` alongside it: a 100% rate over zero reads is
   *  an absence of evidence, not window discipline. */
  windowReadRate: number;
  /** Successful readFile calls the rate above is computed over. */
  readCount: number;
  /** Fraction of all tool calls that errored — a model calling `read` instead of `readFile`
   *  looks like a retrieval failure in the scores, and this is the number that tells you it
   *  was actually a tool-name mismatch. */
  toolErrorRate: number;
  avgToolCalls: number;
  /** Mean characters of tool output pulled into context per query — the "context size should
   *  not increase significantly" guard, as a number you can actually diff between runs. */
  avgContextChars: number;
}

export interface QualitySummary {
  total: number;
  completed: number;
  /** 0..100, matching how BENCHMARK.md states its targets. */
  retrievalPct: number;
  reasoningPct: number;
  answerPct: number;
  efficiency: EfficiencyStats;
  /** Per-category breakdown — where a low aggregate actually comes from. */
  byCategory: { category: QualityCategory; n: number; retrievalPct: number; reasoningPct: number; answerPct: number }[];
  pass: { retrieval: boolean; reasoning: boolean; answer: boolean; grepFallback: boolean; windowRead: boolean; overall: boolean };
  /** The BENCHMARK.md diagnosis line for this result. */
  diagnosis: string;
}

export interface QualityRunConfig {
  dataset: string;
  variant: string;
  mode?: QualityMode;
  model: string;
  judgeModel: string | null;
  platforms?: string[];
  filter?: string[];
  limit?: number;
}

export interface QualityRun {
  schemaVersion: 1;
  runId: string;
  variant: string;
  gitSha: string;
  timestamp: string;
  project: string;
  config: QualityRunConfig;
  queries: QualityResult[];
  summary: QualitySummary;
}

/** MVP pass criteria, verbatim from docs/BENCHMARK.md. Single source of truth for the
 *  runner's report and the merge gate in compareQuality.ts. */
export const TARGETS = {
  retrievalPct: 85,
  reasoningPct: 80,
  answerPct: 80,
  grepFallbackRatePct: 20, // upper bound
  windowReadRatePct: 80,   // lower bound
} as const;
