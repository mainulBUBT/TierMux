/* Benchmark runner — drives the 50-query dataset through Router.route().
 *
 * Usage (after bundling):
 *   node dist/runBench.cjs [--variant NAME] [--platforms a,b,c]
 *                          [--filter E1,E2,…] [--limit N]
 *                          [--taskKind chat|agent|…] [--model auto|platform::id]
 *                          [--out .benchmarks]
 *
 *   npm run bench -- --variant baseline
 *   npm run bench -- --platforms kilo,pollinations,ovh --limit 3   # keyless smoke
 *
 * Captures per-query: success, total latency, TTFT (time to first streamed
 * chunk), tokens, per-provider attempts, failovers, errorType. Writes a single
 * BenchRun JSON to .benchmarks/<runId>.json.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { ChatMessage } from '../../src/shared/types';
import { AllModelsFailedError } from '../../src/router/router';
import { loadDataset } from './dataset';
import { buildHarness } from './routerHarness';
import { summarizeResults } from './aggregate';
import type { Attempt, BenchConfig, BenchQuery, BenchRun, QueryResult } from './types';

interface Args {
  variant: string;
  platforms?: string[];
  filter?: string[];
  limit?: number;
  taskKind: string;
  model: string;
  out: string;
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
  const variant = get('--variant') ?? 'default';
  return {
    variant,
    platforms: getList('--platforms'),
    filter: getList('--filter'),
    limit: limit ? Number(limit) : undefined,
    taskKind: get('--taskKind') ?? 'chat',
    model: get('--model') ?? 'auto',
    out: get('--out') ?? '.benchmarks',
  };
}

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
}

function classifyError(e: unknown): { errorType: string; errorMessage: string } {
  if (e instanceof AllModelsFailedError) {
    return { errorType: 'all_failed', errorMessage: e.message };
  }
  const err = e as { name?: string; message?: string; errorType?: string };
  return { errorType: err.errorType ?? err.name ?? 'unknown', errorMessage: err.message ?? String(e) };
}

/** Run one query through the router, capturing metrics via callbacks. */
async function runOne(
  router: ReturnType<typeof buildHarness>['router'],
  q: BenchQuery,
  taskKind: string,
  model: string,
): Promise<QueryResult> {
  const attempts: Attempt[] = [];
  const failovers: { from: string; reason: string }[] = [];
  let firstChunkAt: number | null = null;

  const messages: ChatMessage[] = [{ role: 'user', content: q.query }];
  const start = Date.now();

  // onChunk → router uses streamChatCompletion → we get a real TTFT.
  const onChunk = () => {
    if (firstChunkAt === null) firstChunkAt = Date.now();
  };
  const onProviderAttempt = (info: {
    platform: string;
    model: string;
    status: 'ok' | 'fail';
    latencyMs: number;
    errorType?: string;
    reason?: string;
  }) => {
    attempts.push({ ...info });
  };
  const onFailover = (info: { from: { platform?: string; modelId?: string }; reason: string }) => {
    const f = info.from;
    failovers.push({ from: f ? `${f.platform ?? '?'}/${f.modelId ?? '?'}` : '?', reason: info.reason });
  };

  try {
    const result = await router.route(messages, {
      model,
      taskKind: taskKind as never, // TaskKind union; left loose to avoid importing router internals.
      onChunk,
      onProviderAttempt,
      onFailover,
    });
    const latencyMs = Date.now() - start;
    const ttftMs = firstChunkAt !== null ? firstChunkAt - start : null;
    const usage = result.response?.usage;
    const tokens = usage
      ? { prompt: usage.prompt_tokens, completion: usage.completion_tokens, total: usage.total_tokens }
      : null;
    return {
      queryId: q.id,
      category: q.category,
      query: q.query,
      ok: true,
      selectedModel: `${result.platform}::${result.model}`,
      latencyMs,
      ttftMs,
      tokens,
      attempts,
      failovers,
      errorType: null,
      errorMessage: null,
    };
  } catch (e) {
    const latencyMs = Date.now() - start;
    const { errorType, errorMessage } = classifyError(e);
    return {
      queryId: q.id,
      category: q.category,
      query: q.query,
      ok: false,
      selectedModel: '',
      latencyMs,
      ttftMs: firstChunkAt !== null ? firstChunkAt - start : null,
      tokens: null,
      attempts,
      failovers,
      errorType,
      errorMessage,
    };
  }
}

function fmt(n: number, digits = 0): string {
  return n.toFixed(digits);
}

function printSummary(run: BenchRun): void {
  const s = run.summary;
  console.log('\n════════ Benchmark summary ════════');
  console.log(`variant:   ${run.variant}   git: ${run.gitSha}`);
  console.log(`queries:   ${s.succeeded}/${s.total} ok  (success rate ${fmt(s.successRate * 100, 1)}%)`);
  console.log(
    `latency:   p50 ${s.latency.p50}ms · p95 ${s.latency.p95}ms · p99 ${s.latency.p99}ms · avg ${Math.round(s.latency.avg)}ms`,
  );
  console.log(
    `ttft:      p50 ${s.ttft.p50}ms · p95 ${s.ttft.p95}ms · avg ${Math.round(s.ttft.avg)}ms`,
  );
  console.log(
    `tokens:    prompt ${s.tokens.totalPrompt} · completion ${s.tokens.totalCompletion}`,
  );
  console.log(`failover:  ${fmt(s.failoverRate * 100, 1)}% of turns had ≥1 failover`);
  if (s.perModel.length) {
    console.log('\nper-model (successful turns):');
    for (const m of s.perModel.slice(0, 8)) {
      console.log(
        `  ${m.model.padEnd(48)} n=${String(m.count).padStart(3)}  avg ${m.avgLatencyMs}ms  ok ${fmt(m.successRate * 100, 0)}%`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const datasetFile = path.resolve(process.cwd(), 'docs/BENCHMARK_QUERIES.md');
  let queries = loadDataset(datasetFile);
  if (args.filter) {
    const want = new Set(args.filter);
    queries = queries.filter((q) => want.has(q.id));
  }
  if (args.limit && args.limit > 0) queries = queries.slice(0, args.limit);
  if (queries.length === 0) {
    console.error('No queries to run (check --filter / --limit).');
    process.exit(1);
  }

  const { router, candidates } = buildHarness({ platforms: args.platforms });
  console.log(`Loaded ${queries.length} queries, ${candidates.length} candidate models.`);
  console.log(`Candidates: ${candidates.map((c) => `${c.platform}/${c.modelId}`).slice(0, 6).join(', ')}${candidates.length > 6 ? ', …' : ''}`);

  const config: BenchConfig = {
    taskKind: args.taskKind,
    model: args.model,
    concurrency: 1,
    ...(args.filter ? { filter: args.filter } : {}),
    ...(args.platforms ? { platforms: args.platforms } : {}),
  };

  const results: QueryResult[] = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    process.stdout.write(`[${i + 1}/${queries.length}] ${q.id} … `);
    const r = await runOne(router, q, args.taskKind, args.model);
    results.push(r);
    process.stdout.write(
      `${r.ok ? 'ok' : 'FAIL'}  ${r.latencyMs}ms` +
        (r.ttftMs !== null ? ` (ttft ${r.ttftMs}ms)` : '') +
        (r.failovers.length ? ` · ${r.failovers.length} failover` : '') +
        (r.ok ? ` · ${r.selectedModel}` : ` · ${r.errorType}`) +
        '\n',
    );
  }

  const summary = summarizeResults(results);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `${ts}-${args.variant}`;
  const run: BenchRun = {
    schemaVersion: 1,
    runId,
    variant: args.variant,
    gitSha: gitSha(),
    timestamp: new Date().toISOString(),
    config,
    queries: results,
    summary,
  };

  const outDir = path.resolve(process.cwd(), args.out);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${runId}.json`);
  fs.writeFileSync(outFile, JSON.stringify(run, null, 2));

  printSummary(run);
  console.log(`\nWrote ${path.relative(process.cwd(), outFile)}`);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
