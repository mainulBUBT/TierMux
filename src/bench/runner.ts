/**
 * Benchmark runner — drives the REAL agent loop over the 50-query dataset against
 * the open workspace (bazardor). Reuses `Agent.run()` exactly as the chat does;
 * only the RunContext + AgentCallbacks are bench-specific.
 *
 * Determinism: every run passes `temperature: 0` and a fixed pinned model. Chains
 * keep a persistent history; single-shot queries run in a length-1 history (which
 * auto-resets the agent's ExecutionTracker).
 */
import * as path from 'path';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import type { ChatMessage } from '../shared/types';
import { Agent, type AgentCallbacks, type AgentResult, type Mode, type RunOpts } from '../agent/agent';
import type { RunContext } from '../agent/runContext';
import type { Router } from '../router/router';
import { resetTelemetry, getSnapshot, type TelemetrySnapshot } from '../context/telemetry';
import { type BenchQuery } from './queries';
import type { ExecutionUnit } from './queries';
import { judgeAnswer, scoreRetrieval, type ToolTraceEntry } from './scorer';

export interface BenchmarkConfig {
  agent: Agent;
  router: Router;
  /** Pinned agent-under-test model (platform::modelId). Never 'auto'. */
  model: string;
  /** Pinned reasoning effort. */
  effort: 'low' | 'medium' | 'high';
  /** Pinned judge model. */
  judgeModel: string;
  /** Absolute workspace path (bazardor). */
  workspace: string;
  /** Absolute dir to write reports into. */
  outDir: string;
  /** Optional progress logger. */
  log?: (msg: string) => void;
  /** When true, restore the workspace via git after each query (default true). */
  restore?: boolean;
}

export interface QueryResult {
  id: string;
  query: string;
  expectedTokens: string[];
  retrieved: string[];
  openedFiles: string[];
  answer: string;
  reasoning?: string;
  retrieval: 0 | 1;
  reasoningScore: number; // 0 | 0.5 | 1
  answerScore: number; // 0 | 1
  /** True when the index/semantic pipeline (codebaseSearch, searchWorkspace) was used.
   *  False means the agent succeeded with raw file reads only — `retrieval=1,
   *  pipelineUsed=false` is a warning that the index stack isn't being exercised. */
  pipelineUsed?: boolean;
  telemetry: TelemetrySnapshot;
  /** True for chain steps after the first (these depend on conversation memory). */
  chainFollowUp?: boolean;
  /** Judge's one-line justification (audit trail). */
  judgeExplanation?: string;
  /** Full raw reply from the judge model (the JSON it emitted, with surrounding noise if any).
   *  Mandatory for any future re-grading / diff / debugging — never trust a benchmark that
   *  doesn't keep this around. */
  judgeRaw?: string;
  /** True when the query hit the BENCH_QUERY_TIMEOUT_MS wall-clock cap.
   *  Judge scores are unreliable for timed-out runs — partial answers score 0 even when
   *  the model was on track. Track separately so you can filter them out of aggregate stats. */
  timedOut?: boolean;
  error?: string;
}

/** A persistent session (accumulating history) for chains. */
export class BenchmarkSession {
  private history: ChatMessage[] = [];
  private step = 0;
  private readonly runIndex: () => string;
  private readonly bench: Benchmark;

  constructor(bench: Benchmark, runIndex: () => string) {
    this.bench = bench;
    this.runIndex = runIndex;
  }

  async ask(query: BenchQuery): Promise<QueryResult> {
    // No per-step restore: chain steps must see prior steps' edits.
    // Steps after the first are "follow-ups" — they depend on conversation memory.
    const followUp = this.step > 0;
    this.step++;
    return this.bench.runOne(query, this.history, this.runIndex(), false, followUp);
  }

  /** Reset between chains by dropping history (next ask starts length-1). */
  reset(): void { this.history = []; this.step = 0; }
}

/** Wall-clock cap per query. A stuck agent shouldn't burn more than 2 minutes per
 *  question — at that point it's looping, not reasoning. Cancellation is via the
 *  existing CancellationToken so the bench path gets a clean _Cancelled_ answer. */
const BENCH_QUERY_TIMEOUT_MS = 120_000;

export class Benchmark {
  private counter = 0;
  constructor(private readonly cfg: BenchmarkConfig) {}

  createSession(): BenchmarkSession {
    return new BenchmarkSession(this, () => `bench-${++this.counter}`);
  }

  /** Single-shot: fresh length-1 history → tracker auto-resets, then restore workspace. */
  async askInFreshSession(query: BenchQuery): Promise<QueryResult> {
    return this.runOne(query, [], `bench-${++this.counter}`, true);
  }

  /** Restore workspace to HEAD (tracked restore + clean untracked). Public so chains can call it once at chain end. */
  restoreWorkspace(): Promise<void> { return this.gitRestore(); }

  /** Core: run one query against a (possibly accumulated) history, in place. */
  async runOne(query: BenchQuery, history: ChatMessage[], requestId: string, restore = true, chainFollowUp = false): Promise<QueryResult> {
    history.push({ role: 'user', content: query.text });
    const trace: ToolTraceEntry[] = [];
    let answer = '';
    let reasoning: string | undefined;

    const cb: AgentCallbacks = {
      onTool: (e) => { trace.push({ name: e.name, args: e.args }); },
      onChunk: (t) => { answer += t; },
      onReasoning: (t) => { reasoning = (reasoning ?? '') + t; },
      onAskUser: async () => '', // never block on the absent webview
    };

    const runContext: RunContext = {
      sessionId: 'bench',
      requestId,
      outDir: this.cfg.outDir,           // debug log goes to <outDir>/pre-research.jsonl
      checkpoints: { record: () => {} },
      approveEdit: async () => true,    // allow edits → git restore after
      approveCommand: async () => false, // reject command exec (no side effects)
      autoApprove: () => true,
    };

    const tokenSource = new vscode.CancellationTokenSource();
    const opts: RunOpts = {
      model: this.cfg.model,
      reasoningEffort: this.cfg.effort,
      temperature: 0, // deterministic benchmark mode
      runContext,
      token: tokenSource.token,
      bench: true, // never pause/check-in — corrupts the answer
      chainFollowUp, // relax bundle-cache Jaccard to 0.4 for chain steps after the first
    };

    resetTelemetry();
    this.cfg.log?.(`▶ ${query.id}: ${query.text}`);
    let result: AgentResult | undefined;
    let error: string | undefined;
    const timeoutId = setTimeout(() => {
      this.cfg.log?.(`  ⏱ ${query.id}: timeout after ${BENCH_QUERY_TIMEOUT_MS / 1000}s — forcing stop`);
      tokenSource.cancel();
    }, BENCH_QUERY_TIMEOUT_MS);
    try {
      result = await this.cfg.agent.run(history, 'agent' as Mode, opts, cb);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      this.cfg.log?.(`  ✗ ${query.id} errored: ${error}`);
    } finally {
      clearTimeout(timeoutId);
      tokenSource.dispose();
    }

    // Append the assistant turn so chain history stays well-formed.
    const finalText = (result?.text ?? answer).trim() || (error ? `(error: ${error})` : '(no answer)');
    if (result?.workMessages && result.workMessages.length) {
      for (const m of result.workMessages) history.push(m);
    } else {
      history.push({ role: 'assistant', content: finalText });
    }

    const timedOut = result?.text?.trim() === '_Cancelled._';
    const answerText = timedOut ? '' : (result?.text?.trim() || answer.trim());
    // Also fold in tool traces from workMessages (authoritative) if onTool missed any.
    if (result?.workMessages) {
      for (const m of result.workMessages) {
        if (m.role === 'assistant' && m.tool_calls) {
          for (const tc of m.tool_calls) {
            try {
              const args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
              trace.push({ name: tc.function?.name ?? '', args });
            } catch { /* ignore malformed */ }
          }
        }
      }
    }

    const openedFiles = uniqueFiles(trace);
    const { score, matched, pipelineUsed: tracePipeline } = scoreRetrieval(trace, query.expectedTokens);
    const verdict = await judgeAnswer(this.cfg.router, this.cfg.judgeModel, {
      query, answer: answerText, reasoning: result?.reasoning ?? reasoning,
    });

    const telemetry = getSnapshot();
    resetTelemetry();

    // Pre-research pipeline (symbolIndex / bundleCache / invertedIndex / grep) runs in
    // TypeScript *before* the LLM loop, so it never appears in the tool trace. We use
    // telemetry counters as the authoritative signal that the index stack was exercised.
    const pipelineUsed = tracePipeline
      || telemetry.symbolIndexHits > 0
      || telemetry.invertedIndexHits > 0
      || telemetry.bundleCacheHits > 0
      || telemetry.grepCalls > 0;

    if (restore && this.cfg.restore !== false) await this.gitRestore();

    this.cfg.log?.(`  ${timedOut ? '⏱' : score === 1 ? '✓' : '✗'} retrieval=${score} reasoning=${verdict.reasoning} answer=${verdict.answer}${timedOut ? ' TIMED_OUT' : ''}  [${matched.join(',') || 'none'}]  symHits=${telemetry.symbolIndexHits} idxHits=${telemetry.invertedIndexHits} toolCalls=${telemetry.totalToolCalls} fullReads=${telemetry.fullFileReads} winReads=${telemetry.windowReads}`);

    // Per-query summary — joins the agent's pre-research log with this query's
    // telemetry snapshot by requestId. BACKWARD SCAN makes lookup O(1) amortised
    // (matching record is almost always the most recent). Derived metrics are
    // computed HERE from authoritative data:
    //   - toolCalls, windowReads, fullFileReads: telemetry snapshot
    //   - injectedFileUsedRate: workspace-relative paths, slash-normalised.
    //     Case folding only on case-insensitive filesystems (Windows, macOS
    //     APFS default) so Linux CI doesn't merge Admin/Helpers.php with
    //     admin/helpers.php. This is an OS-AWARE DEFAULT, not a guarantee —
    //     APFS can be formatted case-sensitive.
    try {
      const perQueryUri = vscode.Uri.file(path.join(this.cfg.outDir, 'summary-per-query.jsonl'));
      let preResearch: Record<string, unknown> = {};
      try {
        const preUri = vscode.Uri.file(path.join(this.cfg.outDir, 'pre-research.jsonl'));
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(preUri));
        const lines = text.split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const r = JSON.parse(lines[i]) as Record<string, unknown>;
            if (r.requestId === requestId) { preResearch = r; break; }
          } catch { /* skip malformed line */ }
        }
      } catch { /* pre-research log missing */ }

      const injectedRaw = (preResearch.filesInjected as string[] | undefined) ?? [];
      const readRaw = (preResearch.readFiles as Array<{ path: string }> | undefined) ?? [];
      const normalizeSep = (p: string): string => p.replace(/\\/g, '/');
      const isCaseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
      const normalize = isCaseInsensitive
        ? (p: string): string => normalizeSep(p).toLowerCase()
        : normalizeSep;
      const readSet = new Set(readRaw.map((r) => normalize(r.path)));
      const usedRate = injectedRaw.length === 0
        ? null
        : Math.round((injectedRaw.filter((f) => readSet.has(normalize(f))).length / injectedRaw.length) * 100) / 100;

      const summaryLine = JSON.stringify({
        id: query.id,
        requestId,
        ts: Date.now(),
        route: preResearch.route ?? null,
        symbolHits: preResearch.symbolHits ?? 0,
        symbolCoverage: preResearch.symbolCoverage ?? 0,
        cacheHit: preResearch.cacheHit ?? false,
        grepUsed: preResearch.grepUsed ?? false,
        filesInjected: injectedRaw,
        readFiles: readRaw,
        toolCalls: telemetry.totalToolCalls,
        windowReads: telemetry.windowReads,
        fullFileReads: telemetry.fullFileReads,
        injectedFileUsedRate: usedRate,
        retrieval: score,
        timedOut: !!timedOut,
      }) + '\n';

      let existing = '';
      try { existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(perQueryUri)); } catch {}
      await vscode.workspace.fs.writeFile(perQueryUri, new TextEncoder().encode(existing + summaryLine));
    } catch { /* non-critical */ }

    return {
      id: query.id,
      query: query.text,
      expectedTokens: query.expectedTokens,
      retrieved: matched,
      openedFiles,
      answer: answerText,
      reasoning: result?.reasoning ?? reasoning,
      retrieval: score,
      pipelineUsed,
      reasoningScore: verdict.reasoning,
      answerScore: verdict.answer,
      judgeExplanation: verdict.explanation,
      judgeRaw: verdict.raw,
      chainFollowUp,
      telemetry,
      timedOut: timedOut || undefined,
      error,
    };
  }

  /** Restore workspace to HEAD so the next query sees a pristine bazardor. */
  private gitRestore(): Promise<void> {
    const ws = this.cfg.workspace;
    return new Promise((resolve) => {
      // Restore tracked files, then remove untracked files the agent may have created.
      cp.exec(`git -C ${JSON.stringify(ws)} restore --staged --worktree . && git -C ${JSON.stringify(ws)} clean -fd`, (err) => {
        if (err) this.cfg.log?.(`  ⚠ git restore failed: ${err.message}`);
        resolve();
      });
    });
  }
}

function uniqueFiles(trace: ToolTraceEntry[]): string[] {
  const out = new Set<string>();
  const READING = new Set(['readFile', 'listDir', 'searchWorkspace', 'codebaseSearch', 'glob', 'grep', 'editFile', 'writeFile', 'createFile', 'deleteFile', 'getSymbolGraph', 'impactAnalysis']);
  for (const e of trace) {
    if (!READING.has(e.name)) continue;
    const a = e.args as Record<string, unknown> | undefined;
    if (!a || typeof a !== 'object') continue;
    for (const key of ['path', 'file', 'file_path', 'filePath', 'pattern', 'include', 'glob', 'query', 'q']) {
      const v = a[key];
      if (typeof v === 'string' && v.trim()) {
        const bn = path.basename(v.trim().replace(/\\/g, '/'));
        if (bn) out.add(bn);
      }
    }
  }
  return [...out];
}

/** Run a set of execution units (standalone + chains), returning all results in order. */
export async function runUnits(bench: Benchmark, units: ExecutionUnit[], log?: (m: string) => void): Promise<QueryResult[]> {
  const results: QueryResult[] = [];
  for (const unit of units) {
    if (unit.chained) {
      const session = bench.createSession();
      log?.(`— chain start (${unit.queries.map((q) => q.id).join('→')}) —`);
      for (const q of unit.queries) results.push(await session.ask(q));
      session.reset();
      await bench.restoreWorkspace(); // restore once per chain (not between steps)
    } else {
      results.push(await bench.askInFreshSession(unit.queries[0]));
    }
  }
  return results;
}

export type { ExecutionUnit };

