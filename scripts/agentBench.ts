// Agent bench: fixed coding tasks through the REAL engine and router (Auto routing as a fresh
// install sees it, real providers) on a throwaway copy of a small Node project, each graded by
// checks the model never sees. Measures what the user waits for — wall time to a checked result —
// and where it went: model steps, first-chunk waits, child processes (ripgrep searches, model
// commands, the verify gate), requests, tokens, questions asked. Details go to .benchmarks/ for before/after comparison.
//
// Run: npm run bench:agent
//   TASKS=fix-add,rename          only these tasks
//   REPEAT=3                      runs per task (default 1)
//   MODEL=opencode::big-pickle    pin one model (default: Auto)
//   TIERMUX_KEY_<PLATFORM>=...    a key for a keyed platform (e.g. TIERMUX_KEY_GROQ)
//   BASELINE=.benchmarks/agent-bench-<stamp>.json   print the change against an earlier run
//   TASK_TIMEOUT_MS=600000        abort a run after this long (default 10 min)
//   GRADER_CHECK=1                a model that does nothing: every task must FAIL, or its check is broken

import * as childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { runAgentStream } from '../src/agent/agent';
import { __setEngineModelForTests } from '../src/agent/core/engine';
import { createMockModel } from './mockModel';
import type { AgentOpts, AgentResult } from '../src/agent/agent';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';
import { Catalog } from '../src/catalog/catalog';
import { SettingsStore } from '../src/config/settingsStore';
import { SecretStore } from '../src/config/secrets';
import { setModelSources } from '../src/router/picker';
import { allPlatformInfo } from '../src/providers';
import type { Platform } from '../src/shared/types';

const WORKER = 'https://tiermux.mainulislam3057.workers.dev/';
const ROOT = join(__dirname, '..');

/* ---------- the fixture project (green as seeded; each task breaks or asks for something) ---------- */

const BASE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'bench-app', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n',
  'README.md': '# bench-app\n\nA small billing library.\n',
  'src/math.js': 'function add(a, b) {\n  return a + b;\n}\n\nfunction mul(a, b) {\n  return a * b;\n}\n\nmodule.exports = { add, mul };\n',
  'src/math.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add, mul } = require('./math');\n\ntest('add', () => {\n  assert.strictEqual(add(2, 3), 5);\n  assert.strictEqual(add(-1, -1), -2);\n});\n\ntest('mul', () => {\n  assert.strictEqual(mul(3, 4), 12);\n});\n",
  'src/billing/invoice.js': "function parseInvoice(raw) {\n  const [id, total] = raw.split(',');\n  return { id: id.trim(), total: Number(total) };\n}\n\nmodule.exports = { parseInvoice };\n",
  'src/billing/invoice.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\nconst { parseInvoice } = require('./invoice');\n\ntest('parseInvoice trims the id', () => {\n  assert.deepStrictEqual(parseInvoice(' A1 ,12.5'), { id: 'A1', total: 12.5 });\n});\n",
  'src/report.js': "const { mul } = require('./math');\nconst { parseInvoice } = require('./billing/invoice');\n\nfunction lineTotal(qty, price) {\n  return mul(qty, price);\n}\n\nfunction totals(lines) {\n  return lines.map(parseInvoice).map((inv) => inv.total);\n}\n\nmodule.exports = { lineTotal, totals };\n",
  'src/index.js': "module.exports = {\n  ...require('./math'),\n  ...require('./billing/invoice'),\n  ...require('./report'),\n};\n",
};

interface Task {
  id: string;
  prompt: string;
  setup?: (files: Record<string, string>) => void;
  /** Node code run in the finished workspace (cwd = workspace, `assert` in scope); throws on failure. */
  check?: string;
  /** Files the model must leave byte-identical. */
  frozen?: string[];
  /** Read-only: nothing may change, and the reply must match every pattern. */
  answer?: RegExp[];
}

const TASKS: Task[] = [
  {
    id: 'fix-add',
    prompt: 'add() in src/math.js returns wrong results. Fix it.',
    setup: (f) => { f['src/math.js'] = f['src/math.js'].replace('a + b', 'a - b'); },
    check: "const { add } = require('./src/math'); assert.strictEqual(add(2, 3), 5); assert.strictEqual(add(-4, 1), -3);",
  },
  {
    id: 'failing-test',
    prompt: 'npm test is failing. Find the cause and fix the code, not the tests.',
    setup: (f) => { f['src/billing/invoice.js'] = f['src/billing/invoice.js'].replace('id.trim()', 'id'); },
    frozen: ['src/billing/invoice.test.js'],
    check: "const { parseInvoice } = require('./src/billing/invoice'); assert.strictEqual(parseInvoice(' B2 ,3').id, 'B2');",
  },
  {
    id: 'feature',
    prompt: "Invoices can carry an optional discount percentage as a third field: parseInvoice('A1,100,10') should return "
      + "{ id: 'A1', total: 100, discount: 10 }, and discount is 0 when the field is missing. Add invoiceTotal(invoice) in "
      + 'src/billing/total.js that returns the total after the discount, export it from src/index.js, and add tests for both.',
    check: "const { parseInvoice } = require('./src/billing/invoice');"
      + " assert.deepStrictEqual(parseInvoice('A1,100,10'), { id: 'A1', total: 100, discount: 10 });"
      + " assert.strictEqual(parseInvoice('A1,100').discount, 0);"
      + " assert.strictEqual(require('./src').invoiceTotal({ id: 'x', total: 200, discount: 25 }), 150);"
      + " const fs = require('fs'), path = require('path'); const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);"
      + " assert.ok(walk('src').some((f) => /\\.test\\.js$/.test(f) && fs.readFileSync(f, 'utf8').includes('invoiceTotal')), 'no test covers invoiceTotal');",
  },
  {
    id: 'rename',
    prompt: 'Rename the function mul to multiply everywhere: definition, exports, callers and tests.',
    check: "const fs = require('fs'), path = require('path'); const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);"
      + " const left = walk('src').filter((f) => /\\bmul\\b/.test(fs.readFileSync(f, 'utf8'))); assert.deepStrictEqual(left, [], 'mul still in ' + left.join(', '));"
      + " assert.strictEqual(require('./src').multiply(3, 4), 12); assert.strictEqual(require('./src/report').lineTotal(2, 5), 10);",
  },
  {
    id: 'explain',
    prompt: "Where does an invoice line's total get converted to a number, and what does the total become when that field "
      + 'is not numeric? Answer only; do not change any files.',
    answer: [/invoice\.js/, /NaN/],
  },
];

/* ---------- workspace + grading ---------- */

function walk(dir: string, rel = ''): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === '.git' ? [] : walk(dir, r);
    return [r];
  });
}

function snapshot(dir: string): Map<string, string> {
  return new Map(walk(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
}

function seed(task: Task): { dir: string; files: Record<string, string> } {
  const files = { ...BASE };
  task.setup?.(files);
  const dir = mkdtempSync(join(tmpdir(), `tm-bench-${task.id}-`));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  mkdirSync(join(dir, 'node_modules')); // "installed", so the engine's verify gate runs as it would for a user
  return { dir, files };
}

function grade(task: Task, dir: string, before: Map<string, string>, reply: string): string[] {
  const fails: string[] = [];
  const after = snapshot(dir);
  if (task.answer) {
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((f) => before.get(f) !== after.get(f));
    if (changed.length) fails.push(`changed ${changed.join(', ')}`);
    for (const re of task.answer) if (!re.test(reply)) fails.push(`reply lacks ${re}`);
    return fails;
  }
  for (const f of task.frozen ?? []) if (before.get(f) !== after.get(f)) fails.push(`edited frozen ${f}`);
  if (task.check) {
    const r = childProcess.spawnSync(process.execPath, ['-e', `const assert = require('node:assert'); ${task.check}`], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0) fails.push(`check: ${(r.stderr || r.stdout).match(/^\s*(\w*Error\b.*)$/m)?.[1].slice(0, 120) ?? `exit ${r.status}`}`);
  }
  const t = childProcess.spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
  if (t.status !== 0) fails.push(`tests: ${t.stdout.match(/# fail \d+/)?.[0] ?? `exit ${t.status}`}`);
  return fails;
}

/* ---------- instrumentation: diag trace lines, provider requests, child processes ---------- */

interface Probe { diag: string[]; requests: number; procMs: number; procs: string[] }
let probe: Probe | undefined;

function instrument(): void {
  (globalThis as { __tiermuxTestConfig?: Record<string, unknown> }).__tiermuxTestConfig = { 'agent.diagTrace': true };
  (vscode.window as unknown as Record<string, unknown>).createOutputChannel = () => ({ appendLine() {}, show() {}, dispose() {} });

  const log = console.log.bind(console);
  console.log = (...a: unknown[]) => {
    const line = a.map(String).join(' ');
    if (line.startsWith('[tiermux][diag]')) { probe?.diag.push(line); return; }
    log(...a);
  };

  const fetch0 = globalThis.fetch;
  globalThis.fetch = ((...a: Parameters<typeof fetch>) => { if (probe) probe.requests++; return fetch0(...a); }) as typeof fetch;

  const cp = require('child_process') as { spawn: typeof childProcess.spawn };
  const spawn0 = cp.spawn;
  cp.spawn = ((...a: Parameters<typeof spawn0>) => {
    const child = spawn0(...a);
    const p = probe;
    const t0 = Date.now();
    child.on('close', () => { if (p) { p.procMs += Date.now() - t0; p.procs.push(String((a[1] as string[] | undefined)?.at(-1) ?? a[0]).slice(0, 60)); } });
    return child;
  }) as typeof spawn0;
}

/* ---------- one run ---------- */

interface Run {
  task: string; rep: number; pass: boolean; fails: string[];
  wallMs: number; firstActionMs?: number; ttftMs?: number; firstChunkMs: number;
  steps: number; toolCalls: number; toolErrors: number; asks: number;
  requests: number; procMs: number; procs: string[];
  inputTokens: number; outputTokens: number; failovers: number;
  models: string[]; verify?: string; finish?: string; stop?: string; paused?: boolean; error?: string;
}

async function runOnce(task: Task, rep: number, pinned: string | undefined, timeoutMs: number): Promise<Run> {
  const { dir } = seed(task);
  const before = snapshot(dir);
  const p: Probe = { diag: [], requests: 0, procMs: 0, procs: [] };
  const tools = new Map<string, string>();
  const models = new Set<string>();
  let asks = 0, inputTokens = 0, outputTokens = 0, failovers = 0;
  let firstActionMs: number | undefined;
  let result: AgentResult | undefined;
  let error: string | undefined;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('bench timeout')), timeoutMs);
  const t0 = Date.now();
  probe = p;
  if (process.env.GRADER_CHECK) __setEngineModelForTests(createMockModel(Array.from({ length: 5 }, () => ({ text: 'Done.' })), 'noop'));
  try {
    result = await runWithWorkspaceRoot(dir, () => runAgentStream({
      messages: [{ role: 'user', content: task.prompt }],
      mode: 'agent', effort: 'medium', autoApprove: true, sessionId: `bench-${task.id}-${rep}-${t0}`,
      pinnedModel: pinned, abortSignal: abort.signal, verifyFixRounds: 1,
      onChunk: () => {}, onReasoning: () => {}, onStep: () => {}, onTodos: () => {},
      onFailover: () => { failovers++; },
      usageSink: (u) => { inputTokens += u.inputTokens; outputTokens += u.outputTokens; },
      onModel: (platform, model) => { models.add(`${platform}::${model}`); },
      onTool: (e) => { firstActionMs ??= Date.now() - t0; tools.set(e.toolCallId, e.state); },
      onAskUser: async () => { asks++; return { status: 'answered' as const, answers: ['Use your best judgment and proceed.'] }; },
      onError: (m) => { error = m; },
    } as AgentOpts));
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
    probe = undefined;
    __setEngineModelForTests(undefined);
  }
  const wallMs = Date.now() - t0;
  const reply = result?.text ?? '';
  const fails = error && !result ? [`error: ${error}`] : grade(task, dir, before, reply);
  rmSync(dir, { recursive: true, force: true });

  const num = (re: RegExp) => p.diag.map((l) => re.exec(l)?.[1]).filter((x): x is string => x !== undefined).map(Number);
  return {
    task: task.id, rep, pass: fails.length === 0, fails,
    wallMs, firstActionMs, ttftMs: num(/engine\.ttft · (\d+)ms/)[0], firstChunkMs: num(/rp\.ttft · .* first chunk after (\d+)ms/).reduce((a, b) => a + b, 0),
    steps: num(/engine\.step · step (\d+) took/).length,
    toolCalls: tools.size, toolErrors: [...tools.values()].filter((s) => s === 'error').length, asks,
    requests: p.requests, procMs: p.procMs, procs: p.procs,
    inputTokens, outputTokens, failovers,
    models: [...models], verify: result?.verifyOutcome, finish: result?.finishReason, stop: result?.stopReason,
    paused: result?.paused, error,
  };
}

/* ---------- report ---------- */

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const sec = (ms: number | undefined) => (ms === undefined ? '-' : (ms / 1000).toFixed(1));
const pad = (s: string | number, n: number) => String(s).padEnd(n);

interface Summary { task: string; passed: number; runs: number; wallMs: number; tokens: number; requests: number; steps: number }
function summarize(runs: Run[]): Summary[] {
  const by = new Map<string, Run[]>();
  for (const r of runs) by.set(r.task, [...(by.get(r.task) ?? []), r]);
  return [...by].map(([task, rs]) => ({
    task, passed: rs.filter((r) => r.pass).length, runs: rs.length,
    wallMs: median(rs.map((r) => r.wallMs)), tokens: median(rs.map((r) => r.inputTokens + r.outputTokens)),
    requests: median(rs.map((r) => r.requests)), steps: median(rs.map((r) => r.steps)),
  }));
}

function delta(now: number, then: number | undefined, fmt: (n: number) => string): string {
  if (then === undefined) return fmt(now);
  const d = now - then;
  return `${fmt(now)} (${d > 0 ? '+' : ''}${fmt(d)})`;
}

function printRun(r: Run): void {
  console.log(`${pad(r.task, 13)}${pad(r.rep, 4)}${pad(r.pass ? 'PASS' : 'FAIL', 6)}${pad(sec(r.wallMs), 7)}${pad(sec(r.firstActionMs), 7)}${pad(sec(r.ttftMs), 7)}`
    + `${pad(r.steps, 6)}${pad(`${r.toolCalls}/${r.toolErrors}`, 7)}${pad(r.asks, 5)}${pad(r.requests, 5)}${pad(`${Math.round(r.inputTokens / 1000)}k/${r.outputTokens}`, 11)}`
    + `${pad(sec(r.procMs), 7)}${pad(r.verify ?? '-', 11)}${r.models.join(',') || '-'}${r.fails.length ? `   ✗ ${r.fails.join('; ')}` : ''}`);
}

/* ---------- main ---------- */

async function main(): Promise<void> {
  const store = new Map<string, unknown>();
  const mem = { get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d), update: async (k: string, v: unknown) => { store.set(k, v); }, keys: () => [...store.keys()] };
  const catalog = new Catalog(ROOT);
  if (!(await catalog.refresh(process.env.CATALOG_URL ?? WORKER, mem as never))) console.log('worker unreachable — using the bundled catalog');
  const secretMap = new Map<string, string>();
  const secrets = new SecretStore({
    get: async (k: string) => secretMap.get(k), store: async (k: string, v: string) => { secretMap.set(k, v); },
    delete: async (k: string) => { secretMap.delete(k); }, onDidChange: () => ({ dispose() {} }),
  } as never);
  const keyed: string[] = [];
  for (const { platform } of allPlatformInfo()) {
    const key = process.env[`TIERMUX_KEY_${platform.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
    if (key) { await secrets.set(platform as Platform, key); keyed.push(platform); }
  }
  setModelSources({ catalog, settings: new SettingsStore(mem as never, catalog), secrets });

  const onlyTasks = process.env.TASKS?.split(',').map((s) => s.trim()).filter(Boolean);
  const tasks = TASKS.filter((t) => !onlyTasks || onlyTasks.includes(t.id));
  const repeat = Math.max(1, Number(process.env.REPEAT ?? 1) || 1);
  const timeoutMs = Number(process.env.TASK_TIMEOUT_MS ?? 600_000) || 600_000;
  const pinned = process.env.MODEL?.trim() || undefined;
  const commit = childProcess.spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const dirty = childProcess.spawnSync('git', ['status', '--porcelain', '--', 'src'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() !== '';

  console.log(`agent bench · ${commit}${dirty ? '+dirty' : ''} · ${pinned ?? 'Auto'} · keys: ${keyed.join(',') || 'none (keyless only)'} · ${tasks.length} task(s) × ${repeat}\n`);
  console.log(`${pad('task', 13)}${pad('#', 4)}${pad('', 6)}${pad('wall', 7)}${pad('1st', 7)}${pad('ttft', 7)}${pad('steps', 6)}${pad('tools', 7)}${pad('ask', 5)}${pad('req', 5)}${pad('tok in/out', 11)}${pad('proc', 7)}${pad('verify', 11)}model`);
  instrument();
  const runs: Run[] = [];
  for (const task of tasks) {
    for (let rep = 1; rep <= repeat; rep++) {
      const r = await runOnce(task, rep, pinned, timeoutMs);
      runs.push(r);
      printRun(r);
    }
  }

  const baseline = process.env.BASELINE ? summarize((JSON.parse(readFileSync(process.env.BASELINE, 'utf8')) as { runs: Run[] }).runs) : undefined;
  console.log(`\n${pad('task', 13)}${pad('pass', 8)}${pad('median wall s', 22)}${pad('median tokens', 24)}${pad('median req', 16)}median steps${baseline ? `   (vs ${process.env.BASELINE})` : ''}`);
  for (const s of summarize(runs)) {
    const b = baseline?.find((x) => x.task === s.task);
    console.log(`${pad(s.task, 13)}${pad(`${s.passed}/${s.runs}${b ? ` (${b.passed}/${b.runs})` : ''}`, 8)}${pad(delta(s.wallMs, b?.wallMs, (n) => (n / 1000).toFixed(1)), 22)}`
      + `${pad(delta(s.tokens, b?.tokens, (n) => String(Math.round(n))), 24)}${pad(delta(s.requests, b?.requests, String), 16)}${delta(s.steps, b?.steps, String)}`);
  }
  const passed = runs.filter((r) => r.pass).length;
  if (process.env.GRADER_CHECK) {
    console.log(passed === 0 ? '\ngrader OK: doing nothing fails every task' : `\ngrader BROKEN: ${runs.filter((r) => r.pass).map((r) => r.task).join(', ')} passed with no work`);
    process.exit(passed === 0 ? 0 : 1);
  }
  console.log(`\npassed ${passed}/${runs.length} · total wall ${sec(runs.reduce((a, r) => a + r.wallMs, 0))}s`);

  mkdirSync(join(ROOT, '.benchmarks'), { recursive: true });
  const out = join(ROOT, '.benchmarks', `agent-bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify({ commit, dirty, model: pinned ?? 'auto', keyed, node: process.version, repeat, runs }, null, 2));
  console.log(`details: ${out.slice(ROOT.length + 1)}`);
  process.exit(0);
}

void main().catch((e) => { console.error(e); process.exit(1); });
