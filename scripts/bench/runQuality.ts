/* Quality benchmark runner — the Retrieval / Reasoning / Answer harness docs/BENCHMARK.md
 * specifies. Complements `npm run bench` (router latency), it does not replace it.
 *
 * Usage:
 *   npm run bench:quality -- --variant baseline --judge openrouter::<strong-model>
 *   npm run bench:quality -- --limit 3 --platforms kilo,pollinations,ovh   # keyless smoke
 *   npm run bench:quality -- --no-judge --sheet .benchmarks/quality/sheet.md  # score by hand
 *
 * Flags:
 *   --dataset PATH    dataset JSON (default docs/bench/dataset.tiermux.json)
 *   --workspace PATH  project the queries are about (default: cwd)
 *   --variant NAME    label for the run file, e.g. baseline / with-symbol-index
 *   --model SPEC      'auto' or 'platform::modelId' for the AGENT (default auto)
 *   --judge SPEC      'platform::modelId' for the JUDGE (required unless --no-judge)
 *   --no-judge        skip judging; retrieval + efficiency only, and emit a scoring sheet
 *   --platforms a,b   restrict router candidates (keyless smoke)
 *   --filter E1,B2    run specific query ids
 *   --limit N         run the first N queries
 *   --timeout MS      per-query wall clock (default 180000)
 *   --delay MS        pause between queries (default 3000) — see the rate-limit note below
 *   --retries N       retries per query on a rate-limit/empty failure (default 3)
 *   --out DIR         output dir (default .benchmarks/quality)
 *
 * RATE LIMITS ARE THE DEFAULT FAILURE MODE ON FREE TIERS. A free model at 3 RPM cannot answer
 * 20 back-to-back queries: the first few succeed, the model lands in cooldown, and every
 * remaining query fails in ~0ms. That produces a run where the numbers describe the provider's
 * quota rather than the agent's quality — which is worse than no run, because it looks like
 * data. Hence the default pacing and the retry-with-backoff below.
 *
 * PIN BOTH MODELS for any run whose numbers you intend to compare. With --model auto the
 * router may pick a different model per query and per run, which makes a before/after delta
 * meaningless — the thing you changed and the model that changed under you are confounded.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { buildHarness, syncRemoteProviders } from './routerHarness';
import { loadQualityDataset, checkGroundTruth } from './qualityDataset';
import { runQuery, setWorkspaceRoot } from './agentHarness';
import { judgeAnswer } from './judge';
import { scoreRetrieval, summarizeQuality } from './qualityScore';
import type { QualityResult, QualityRun, QualityRunConfig, QualityScores } from './qualityTypes';
import { TARGETS } from './qualityTypes';

interface Args {
  dataset: string;
  workspace: string;
  variant: string;
  model: string;
  judge: string | null;
  noJudge: boolean;
  platforms?: string[];
  filter?: string[];
  limit?: number;
  timeoutMs: number;
  delayMs: number;
  retries: number;
  out: string;
  sheet?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Errors that mean "the provider refused right now", not "the agent is bad". Retrying these
 *  is the difference between measuring the agent and measuring a free tier's quota. */
function isTransient(message: string | null): boolean {
  if (!message) return false;
  return /rpm_limit|rate.?limit|empty_response|timeout|502|503|429|overload/i.test(message);
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const getList = (flag: string): string[] | undefined => {
    const v = get(flag);
    return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  };
  const limit = get('--limit');
  return {
    dataset: get('--dataset') ?? 'docs/bench/dataset.tiermux.json',
    workspace: get('--workspace') ?? process.cwd(),
    variant: get('--variant') ?? 'default',
    model: get('--model') ?? 'auto',
    judge: get('--judge') ?? null,
    noJudge: argv.includes('--no-judge'),
    platforms: getList('--platforms'),
    filter: getList('--filter'),
    limit: limit ? Number(limit) : undefined,
    timeoutMs: Number(get('--timeout') ?? 180_000),
    delayMs: Number(get('--delay') ?? 3_000),
    retries: Number(get('--retries') ?? 3),
    out: get('--out') ?? '.benchmarks/quality',
    sheet: get('--sheet'),
  };
}

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
}

function bar(value: number, target: number, higherBetter = true): string {
  const ok = higherBetter ? value >= target : value < target;
  return `${ok ? '✓' : '✗'} ${value.toFixed(1)}%`.padStart(9);
}

function printReport(run: QualityRun): void {
  const s = run.summary;
  console.log('\n════════ Quality benchmark ════════');
  console.log(`variant: ${run.variant}   git: ${run.gitSha}   project: ${run.project}`);
  console.log(`queries: ${s.completed}/${s.total} produced an answer`);
  console.log('');
  console.log(`  Retrieval  ${bar(s.retrievalPct, TARGETS.retrievalPct)}   (target ≥ ${TARGETS.retrievalPct}%)`);
  console.log(`  Reasoning  ${bar(s.reasoningPct, TARGETS.reasoningPct)}   (target ≥ ${TARGETS.reasoningPct}%)`);
  console.log(`  Answer     ${bar(s.answerPct, TARGETS.answerPct)}   (target ≥ ${TARGETS.answerPct}%)`);
  console.log('');
  const e = s.efficiency;
  console.log(`  Grep fallback  ${bar(e.grepFallbackRate * 100, TARGETS.grepFallbackRatePct, false)}   (target < ${TARGETS.grepFallbackRatePct}%)`);
  console.log(
    `  Window reads   ${e.readCount === 0 ? '✗     n/a' : bar(e.windowReadRate * 100, TARGETS.windowReadRatePct)}` +
      `   (target > ${TARGETS.windowReadRatePct}%, over ${e.readCount} successful read${e.readCount === 1 ? '' : 's'})`,
  );
  console.log(`  Avg tool calls    ${e.avgToolCalls.toFixed(1)}`);
  console.log(`  Tool errors       ${(e.toolErrorRate * 100).toFixed(1)}%`);
  console.log(`  Avg context chars ${Math.round(e.avgContextChars)}`);

  console.log('\nby category:');
  for (const c of s.byCategory) {
    console.log(
      `  ${c.category.padEnd(9)} n=${String(c.n).padStart(2)}   ret ${c.retrievalPct.toFixed(0).padStart(3)}%   reas ${c.reasoningPct.toFixed(0).padStart(3)}%   ans ${c.answerPct.toFixed(0).padStart(3)}%`,
    );
  }

  const misses = run.queries.filter((q) => q.scores.retrieval === 0);
  if (misses.length) {
    console.log('\nretrieval misses (files never opened):');
    for (const m of misses) console.log(`  ${m.queryId.padEnd(4)} ${m.missedFiles.join(', ')}`);
  }

  console.log(`\n${s.pass.overall ? '✓ MVP PASSED' : '✗ MVP NOT PASSED'} — ${s.diagnosis}`);
}

/** Markdown scoring sheet for --no-judge runs: retrieval is already filled in (it is computed),
 *  reasoning/answer are left blank for a human, matching the sheet in BENCHMARK_QUERIES.md. */
function writeSheet(file: string, run: QualityRun): void {
  const lines = [
    `# Scoring sheet — ${run.variant} (${run.gitSha})`,
    '',
    'Retrieval is computed from the tool trace. Fill Reasoning (0/0.5/1) and Answer (0/1) by hand,',
    'then re-run with `--score-from` is NOT supported yet — enter them in the run JSON directly.',
    '',
    '| # | Query | Retrieval | Reasoning | Answer | Notes |',
    '|---|---|---|---|---|---|',
  ];
  for (const q of run.queries) {
    lines.push(`| ${q.queryId} | ${q.query.replace(/\|/g, '\\|').slice(0, 80)} | ${q.scores.retrieval} | | | ${q.ok ? '' : `FAILED: ${q.errorMessage ?? ''}`} |`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.noJudge && !args.judge) {
    console.error(
      'Reasoning/Answer need a judge model. Pass --judge platform::modelId (a STRONG model —\n' +
        'grading with the same weak model that wrote the answer measures nothing), or pass\n' +
        '--no-judge to get retrieval + efficiency only and score the rest by hand.',
    );
    process.exit(1);
  }

  const workspace = path.resolve(args.workspace);
  const datasetFile = path.resolve(process.cwd(), args.dataset);
  const dataset = loadQualityDataset(datasetFile);

  // Ground truth is paths in one specific repo. Running it against another checkout produces a
  // 0% retrieval score that says nothing about the agent — fail loudly instead.
  const problems = checkGroundTruth(dataset, workspace);
  if (problems.length) {
    console.error(`\n${problems.length} ground-truth path(s) do not exist in ${workspace}:`);
    for (const p of problems.slice(0, 15)) console.error(`  ${p}`);
    console.error('\nThe dataset is stale (a refactor moved these) or pointed at the wrong workspace.');
    process.exit(1);
  }

  let queries = dataset.queries;
  if (args.filter) {
    const want = new Set(args.filter);
    queries = queries.filter((q) => want.has(q.id));
  }
  if (args.limit && args.limit > 0) queries = queries.slice(0, args.limit);
  if (queries.length === 0) {
    console.error('No queries to run (check --filter / --limit).');
    process.exit(1);
  }

  setWorkspaceRoot(workspace);
  // Same provider set the extension resolves at runtime — without this, platforms that live
  // only in the remote catalog (e.g. nararouter) are unbenchmarkable here but work in the app.
  const applied = await syncRemoteProviders();
  if (applied) console.log(`Remote provider catalog: ${applied} provider(s) registered/refreshed.`);
  const { router, candidates } = buildHarness({ platforms: args.platforms });
  console.log(`Dataset: ${path.relative(process.cwd(), datasetFile)} — ${queries.length} of ${dataset.queries.length} queries`);
  console.log(`Workspace: ${workspace}`);
  console.log(`Agent model: ${args.model}   Judge: ${args.noJudge ? '(none — --no-judge)' : args.judge}`);
  console.log(`Router candidates: ${candidates.length}`);
  if (args.model === 'auto') {
    console.log('⚠ --model auto: the router may pick a different model per query, so this run is');
    console.log('  NOT comparable to another. Pin --model platform::id for before/after work.');
  }

  const results: QualityResult[] = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const mode = q.mode ?? 'ask';
    process.stdout.write(`[${i + 1}/${queries.length}] ${q.id} (${q.category}/${mode}) … `);

    if (i > 0 && args.delayMs > 0) await sleep(args.delayMs);

    // Retry only transient provider refusals — never a real agent failure, which is a result.
    let outcome = await runQuery(router, q, { mode, model: args.model, timeoutMs: args.timeoutMs });
    for (let attempt = 1; attempt <= args.retries && !outcome.ok && isTransient(outcome.errorMessage); attempt++) {
      // Linear backoff past the provider's own cooldown; a 3-RPM tier needs ~20s of headroom.
      const wait = args.delayMs * 2 * attempt + 5_000;
      process.stdout.write(`rate-limited, waiting ${Math.round(wait / 1000)}s (retry ${attempt}/${args.retries}) … `);
      await sleep(wait);
      outcome = await runQuery(router, q, { mode, model: args.model, timeoutMs: args.timeoutMs });
    }
    const retrieval = scoreRetrieval(q, {
      openedFiles: outcome.openedFiles,
      seenFiles: outcome.seenFiles,
      answer: outcome.answer,
    });

    let scores: QualityScores;
    if (!outcome.ok) {
      // No answer to grade. Scoring it 0/0 is the honest reading — the user got nothing.
      scores = { retrieval: retrieval.score, reasoning: 0, answer: 0, rationale: `no answer — ${outcome.errorMessage ?? 'unknown'}`, judged: false };
    } else if (args.noJudge) {
      scores = { retrieval: retrieval.score, reasoning: 0, answer: 0, rationale: 'unscored (--no-judge)', judged: false };
    } else {
      const verdict = await judgeAnswer(router, q, outcome.answer, outcome.openedFiles, { model: args.judge as string });
      scores = { retrieval: retrieval.score, ...verdict };
    }

    results.push({
      queryId: q.id,
      category: q.category,
      query: q.query,
      mode,
      ok: outcome.ok,
      // Keep run files reviewable; the full answer is reproducible from the same pinned model.
      answer: outcome.answer.slice(0, 4000),
      selectedModel: outcome.selectedModel,
      latencyMs: outcome.latencyMs,
      trace: outcome.trace,
      openedFiles: outcome.openedFiles,
      seenFiles: outcome.seenFiles,
      missedFiles: retrieval.missed,
      scores,
      errorMessage: outcome.errorMessage,
    });

    process.stdout.write(
      `${outcome.ok ? 'ok' : 'FAIL'}  ret ${retrieval.score}` +
        (args.noJudge || !outcome.ok ? '' : `  reas ${scores.reasoning}  ans ${scores.answer}`) +
        `  ${outcome.trace.length} tools  ${Math.round(outcome.latencyMs / 1000)}s\n`,
    );
  }

  const config: QualityRunConfig = {
    dataset: path.relative(process.cwd(), datasetFile),
    variant: args.variant,
    model: args.model,
    judgeModel: args.noJudge ? null : args.judge,
    ...(args.platforms ? { platforms: args.platforms } : {}),
    ...(args.filter ? { filter: args.filter } : {}),
    ...(args.limit ? { limit: args.limit } : {}),
  };

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `${ts}-${args.variant}`;
  const run: QualityRun = {
    schemaVersion: 1,
    runId,
    variant: args.variant,
    gitSha: gitSha(),
    timestamp: new Date().toISOString(),
    project: dataset.project,
    config,
    queries: results,
    summary: summarizeQuality(results),
  };

  const outDir = path.resolve(process.cwd(), args.out);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${runId}.json`);
  fs.writeFileSync(outFile, JSON.stringify(run, null, 2));

  printReport(run);

  // A run that lost queries to provider refusals is not a measurement of the agent, and its
  // percentages are diluted by every query the model never got to attempt. Say so loudly —
  // silently reporting "Retrieval 5%" from a rate-limited run is how a harness lies.
  const transient = results.filter((r) => !r.ok && isTransient(r.errorMessage));
  const unjudged = results.filter((r) => r.ok && !r.scores.judged && !args.noJudge);
  if (transient.length) {
    const pctLost = (transient.length / results.length) * 100;
    console.log(`\n⚠ ${transient.length}/${results.length} queries (${pctLost.toFixed(0)}%) died on provider rate limits/timeouts,`);
    console.log('  even after retries. Those count as 0 in every percentage above, so THIS RUN IS NOT');
    console.log('  A VALID BASELINE. Raise --delay/--retries, or use a provider with real quota.');
    console.log(`  Affected: ${transient.map((r) => r.queryId).join(', ')}`);
  }
  if (unjudged.length) {
    console.log(`\n⚠ ${unjudged.length} answered ${unjudged.length === 1 ? 'query' : 'queries'} could not be judged (judge unavailable):`);
    console.log(`  ${unjudged.map((r) => r.queryId).join(', ')} — their reasoning/answer 0s are missing data, not verdicts.`);
  }

  if (args.noJudge) {
    const sheet = args.sheet ?? path.join(outDir, `${runId}.sheet.md`);
    writeSheet(sheet, run);
    console.log(`\nReasoning/Answer are UNSCORED (--no-judge) — the two percentages above are 0 by`);
    console.log(`construction, not a measurement. Scoring sheet: ${path.relative(process.cwd(), sheet)}`);
  }
  console.log(`\nWrote ${path.relative(process.cwd(), outFile)}`);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
