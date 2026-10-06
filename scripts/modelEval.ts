// Model eval: every model the worker catalog serves gets the same five TierMux agent turns — the
// real agent system prompt and toolset, sent through the real provider — against a small fake
// workspace whose tool results are simulated here. Prints a score table with a suggested tier
// tag and writes the details to .benchmarks/. Read-only: it changes no catalog, worker or table.
//
// Run: npm run eval:models
//   PLATFORMS=opencode,kilo        only these platforms (default: every keyless platform)
//   MODELS=opencode::big-pickle    only these models
//   TASKS=read-answer,edit         only these tasks
//   REPEAT=2                       runs per task (default 2 — one run is too noisy to retag on)
//   TIERMUX_KEY_<PLATFORM>=...     also evaluate a keyed platform (e.g. TIERMUX_KEY_GROQ)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asSchema } from 'ai';
import { buildV3ToolSet } from '../src/agent/core/tools/v3';
import { applyHunk } from '../src/agent/core/tools/v3/editMatch';
import { resolveToolAlias } from '../src/agent/core/repair';
import { composeSystemPrompt } from '../src/context/system';
import { Catalog } from '../src/catalog/catalog';
import { getPlatformInfo, resolveProvider } from '../src/providers';
import { TIER_ORDER, tierOf, type ModelTier } from '../src/catalog/discovery';
import type { CatalogModel, ChatMessage, ChatToolDefinition, Platform } from '../src/shared/types';

const WORKER = 'https://tiermux.mainulislam3057.workers.dev/';
const MAX_TURNS = 10;
const CALL_TIMEOUT_MS = 120_000;

/* ---------- the fake workspace ---------- */

const SEED: Record<string, string> = {
  'package.json': '{\n  "name": "demo-app",\n  "version": "4.5.6",\n  "scripts": {\n    "test": "vitest run"\n  }\n}\n',
  'README.md': '# demo-app\n\nA small billing demo.\n',
  'src/math.ts': 'export function add(a: number, b: number): number {\n  return a - b;\n}\n\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n',
  'src/billing/types.ts': 'export interface Invoice {\n  id: string;\n  total: number;\n}\n',
  'src/billing/invoice.ts': "import type { Invoice } from './types';\n\nexport function parseInvoice(raw: string): Invoice {\n  const [id, total] = raw.split(',');\n  return { id, total: Number(total) };\n}\n",
  'src/index.ts': "export * from './math';\nexport * from './billing/invoice';\n",
  'src/math.test.ts': "import { describe, it, expect } from 'vitest';\nimport { add } from './math';\n\ndescribe('add', () => {\n  it('adds two numbers', () => expect(add(2, 3)).toBe(5));\n  it('handles negatives', () => expect(add(-1, -1)).toBe(-2));\n});\n",
};
const TEST_OUTPUT = ' FAIL  src/math.test.ts > add > adds two numbers\n FAIL  src/math.test.ts > add > handles negatives\n\n Test Files  1 failed | 2 passed (3)\n      Tests  2 failed | 10 passed (12)\n';

type Fs = Map<string, string>;
const norm = (p: unknown): string => String(p ?? '').trim().replace(/^\.?\/+/, '').replace(/\/+$/, '');

function globBody(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{' && glob.indexOf('}', i) > i) { const end = glob.indexOf('}', i); re += `(${glob.slice(i + 1, end).split(',').map(globBody).join('|')})`; i = end; }
    else re += c.replace(/[.+^$(){}|[\]\\]/g, '\\$&');
  }
  return re;
}

function globToRegex(glob: string): RegExp {
  try { return new RegExp(`^${globBody(glob)}$`); } catch { return /^$/; }
}

function numbered(path: string, text: string): string {
  const lines = text.replace(/\n$/, '').split('\n');
  return `<file path="${path}">\n${lines.map((l, i) => `${i + 1}\t${l}`).join('\n')}\n</file>`;
}

function grepFs(fs: Fs, pattern: string, opts: { path?: string; glob?: string; ignoreCase?: boolean; filesOnly?: boolean }): string {
  let re: RegExp;
  try { re = new RegExp(pattern, opts.ignoreCase ? 'i' : ''); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.ignoreCase ? 'i' : ''); }
  const scope = norm(opts.path);
  const g = opts.glob ? globToRegex(opts.glob.includes('/') ? opts.glob : `**/${opts.glob}`) : null;
  const hits: string[] = [];
  for (const [file, text] of fs) {
    if (scope && file !== scope && !file.startsWith(scope + '/')) continue;
    if (g && !g.test(file) && !g.test(file.split('/').pop()!)) continue;
    text.split('\n').forEach((line, i) => { if (re.test(line)) hits.push(opts.filesOnly ? file : `${file}:${i + 1}: ${line}`); });
  }
  return hits.length ? [...new Set(hits)].join('\n') : 'No matches.';
}

/** A small shell: each `;`/`&&`/`||` segment runs on its own and only its first command counts
 *  (a pipe tail like `| head` passes the output through). Models that probe whether the shell
 *  works (`echo marker`) must get a sane answer, or they keep probing. */
function fakeShell(fs: Fs, cmd: string): string {
  const out: string[] = [];
  let exit = 0;
  for (const seg of cmd.split(/;|&&|\|\|/)) {
    const head = seg.split('|')[0].replace(/\s*\d?>\s*\S+|2>&1/g, '').trim();
    const word = head.split(/\s+/)[0] ?? '';
    const arg = head.slice(word.length).trim().replace(/^["']|["']$/g, '');
    if (!head) continue;
    if (/\b(npm|pnpm|yarn)\s+(run\s+)?test\b|\bvitest\b/.test(head)) { out.push(TEST_OUTPUT); exit = 1; }
    else if (word === 'echo' || word === 'printf') out.push(arg.replace(/\$\?/g, String(exit)));
    else if (word === 'pwd') out.push('/workspace/demo-app');
    else if (word === 'cat') { const f = norm(arg.split(/\s+/)[0]); out.push(fs.get(f) ?? `cat: ${f}: No such file or directory`); }
    else if (word === 'ls') { const dir = norm(arg.replace(/-\w+/g, '').trim()); out.push([...fs.keys()].filter((f) => !dir || f.startsWith(dir + '/')).join('\n')); }
    else if (word === 'which') out.push(arg.split(/\s+/).map((b) => `/usr/local/bin/${b}`).join('\n'));
    else if (word === 'true' || word === 'exit' || word === 'cd' || /^[A-Z_]+=/.test(word)) continue;
    else if (word === 'node' || word === 'npx') out.push('v22.11.0');
    else out.push(`${word}: command not available in this sandbox`);
  }
  const body = out.join('\n').trim() || '(no output)';
  return exit ? `${body}\n\n[Exit code: ${exit} (command FAILED)]` : body;
}

/** What each tool answers in the fake workspace. Mutating tools change `fs`. */
function runTool(fs: Fs, name: string, a: Record<string, unknown>, log: string[]): string {
  switch (name) {
    case 'readFile': {
      const paths = Array.isArray(a.path) ? a.path : [a.path];
      return paths.map((p) => { const f = norm(p); return fs.has(f) ? numbered(f, fs.get(f)!) : JSON.stringify({ error: `File not found: ${f}` }); }).join('\n');
    }
    case 'listDir': {
      const dir = norm(a.path);
      const out = new Set<string>();
      for (const f of fs.keys()) {
        if (dir && !f.startsWith(dir + '/')) continue;
        const rest = dir ? f.slice(dir.length + 1) : f;
        out.add(rest.includes('/') ? rest.split('/')[0] + '/' : rest);
      }
      return out.size ? [...out].sort().join('\n') : JSON.stringify({ error: `Not a directory: ${dir}` });
    }
    case 'glob': {
      const pat = String(a.pattern ?? '');
      const re = globToRegex(pat.includes('/') ? pat : `**/${pat}`);
      const hits = [...fs.keys()].filter((f) => re.test(f) || re.test(f.split('/').pop()!));
      return hits.length ? hits.join('\n') : 'No files matched.';
    }
    case 'grep':
      return grepFs(fs, String(a.pattern ?? ''), { path: a.path as string, glob: a.glob as string, ignoreCase: !!a.ignoreCase, filesOnly: !!a.filesOnly });
    case 'findSymbol': {
      const q = String(a.query ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return grepFs(fs, `(function|class|interface|const)\\s+${q}\\b`, {});
    }
    case 'outline': {
      const f = norm(a.path);
      return fs.has(f) ? grepFs(fs, '^export ', { path: f }) : JSON.stringify({ error: `File not found: ${f}` });
    }
    case 'definition':
    case 'references':
    case 'hover':
      return grepFs(fs, `\\b${String(a.symbol ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, {});
    case 'runCommand': {
      const cmd = String(a.command ?? '');
      log.push(`$ ${cmd}`);
      return fakeShell(fs, cmd);
    }
    case 'editFile': {
      const f = norm(a.path);
      if (!fs.has(f)) return JSON.stringify({ error: `File not found: ${f}` });
      const edits = Array.isArray(a.edits) ? (a.edits as Array<{ search?: unknown; replace?: unknown }>) : [{ search: a.search, replace: a.replace }];
      let text = fs.get(f)!;
      for (const e of edits) {
        const next = applyHunk(text, String(e.search ?? ''), String(e.replace ?? ''));
        if ('error' in next) return JSON.stringify({ error: next.error });
        text = next.text;
      }
      fs.set(f, text);
      log.push(`edit ${f}`);
      return `Edited ${f}.`;
    }
    case 'writeFile':
      fs.set(norm(a.path), String(a.content ?? ''));
      log.push(`write ${norm(a.path)}`);
      return `Wrote ${norm(a.path)}.`;
    case 'getDiagnostics':
      return 'No problems found.';
    case 'todoWrite':
      return 'Todo list updated.';
    default:
      return JSON.stringify({ error: `${name} is not available here.` });
  }
}

/* ---------- the tasks ---------- */

interface Outcome { text: string; calls: Array<{ name: string; args: Record<string, unknown> }>; fs: Fs; log: string[] }
interface Task { id: string; prompt: string; check: (o: Outcome) => string | null }

const TASKS: Task[] = [
  {
    id: 'read-answer',
    prompt: 'What version is declared in package.json?',
    check: (o) => (o.text.includes('4.5.6') ? null : 'answer lacks 4.5.6'),
  },
  {
    id: 'find-symbol',
    prompt: 'Which file defines the function parseInvoice?',
    check: (o) => (o.text.includes('src/billing/invoice.ts') ? null : 'answer lacks src/billing/invoice.ts'),
  },
  {
    id: 'edit',
    prompt: 'The add function in src/math.ts subtracts instead of adding. Fix it.',
    check: (o) => {
      const t = o.fs.get('src/math.ts') ?? '';
      if (/return a - b;/.test(t)) return 'add still subtracts';
      if (!/return a \+ b;|return b \+ a;/.test(t)) return 'add not fixed';
      if (!/return a \* b;/.test(t)) return 'mul was damaged';
      return null;
    },
  },
  {
    id: 'run-tests',
    prompt: 'Run the test suite and tell me how many tests failed.',
    check: (o) => {
      if (!o.log.some((l) => l.startsWith('$ '))) return 'never ran a command';
      return /\b2\b|\btwo\b/i.test(o.text) ? null : 'answer lacks the failure count (2)';
    },
  },
  {
    id: 'no-tool',
    prompt: 'What is 17 * 3? Reply with only the number.',
    check: (o) => (o.calls.length > 0 ? `used ${o.calls.length} tool call(s) for arithmetic` : o.text.includes('51') ? null : 'wrong answer'),
  },
];

/* ---------- one model call, streamed like routerProvider does ---------- */

interface Reply { text: string; calls: Array<{ id: string; name: string; args: string }>; ms: number; ttftMs: number | null }

async function callModel(platform: Platform, modelId: string, key: string, messages: ChatMessage[], tools: ChatToolDefinition[], sessionId: string): Promise<Reply> {
  const provider = resolveProvider(platform, modelId);
  if (!provider) throw new Error(`no provider for ${platform}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  const t0 = Date.now();
  let ttftMs: number | null = null;
  let text = '';
  let reasoning = '';
  const acc = new Map<number, { id: string; name: string; args: string }>();
  try {
    for await (const chunk of provider.streamChatCompletion(key, messages, modelId, { tools, parallel_tool_calls: true, sessionId, abortSignal: ctrl.signal, timeoutMs: 60_000 })) {
      if (ttftMs === null) ttftMs = Date.now() - t0;
      const d = chunk.choices?.[0]?.delta as { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } | undefined;
      text += d?.content ?? '';
      reasoning += d?.reasoning_content ?? d?.reasoning ?? '';
      for (const tc of d?.tool_calls ?? []) {
        const i = tc.index ?? 0;
        const slot = acc.get(i) ?? { id: tc.id ?? `call_${i}`, name: '', args: '' };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        acc.set(i, slot);
      }
    }
  } finally {
    clearTimeout(timer);
  }
  // Same fold the engine applies: a reasoning-only reply counts as the answer.
  const answer = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || reasoning.trim();
  return { text: answer, calls: [...acc.values()].filter((c) => c.name), ms: Date.now() - t0, ttftMs };
}

/* ---------- running a task ---------- */

interface TaskResult {
  task: string;
  pass: boolean;
  reason: string | null;
  turns: number;
  toolCalls: number;
  badArgs: number;
  unknownTools: string[];
  errors: string[];
  trace: string[];
  ms: number;
  ttftMs: number[];
  finalText: string;
}

async function runTask(m: CatalogModel, key: string, task: Task, system: string, tools: ChatToolDefinition[], toolNames: Set<string>): Promise<TaskResult> {
  const fs: Fs = new Map(Object.entries(SEED));
  const log: string[] = [];
  const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: task.prompt }];
  const allCalls: Outcome['calls'] = [];
  const r: TaskResult = { task: task.id, pass: false, reason: null, turns: 0, toolCalls: 0, badArgs: 0, unknownTools: [], errors: [], trace: [], ms: 0, ttftMs: [], finalText: '' };
  const sessionId = `eval-${m.platform}-${m.modelId}-${task.id}-${Date.now()}`;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let reply: Reply | null = null;
    for (let attempt = 0; attempt < 2 && !reply; attempt++) {
      try {
        reply = await callModel(m.platform, m.modelId, key, messages, tools, sessionId);
      } catch (e) {
        const status = (e as { status?: number }).status;
        const msg = `${status ?? ''} ${(e as Error).message}`.replace(/\s+/g, ' ').trim().slice(0, 160);
        r.errors.push(msg);
        if (status === 429 && attempt === 0) { await new Promise((res) => setTimeout(res, 8_000)); continue; }
        break;
      }
    }
    if (!reply) { r.reason = `HTTP error: ${r.errors[r.errors.length - 1]}`; return r; }
    r.turns++;
    r.ms += reply.ms;
    if (reply.ttftMs !== null) r.ttftMs.push(reply.ttftMs);
    if (reply.calls.length === 0) {
      r.finalText = reply.text;
      if (!reply.text) { r.reason = 'empty reply'; return r; }
      r.reason = task.check({ text: reply.text, calls: allCalls, fs, log });
      r.pass = r.reason === null;
      return r;
    }
    messages.push({ role: 'assistant', content: reply.text || null, tool_calls: reply.calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args || '{}' } })) });
    for (const c of reply.calls) {
      r.toolCalls++;
      let result: string;
      let args: Record<string, unknown> | null = null;
      try { args = JSON.parse(c.args || '{}'); } catch { r.badArgs++; }
      const name = toolNames.has(c.name) ? c.name : resolveToolAlias(c.name, [...toolNames]);
      if (!name) {
        r.unknownTools.push(c.name);
        result = JSON.stringify({ error: `Unknown tool "${c.name}".` });
      } else if (!args || typeof args !== 'object') {
        result = JSON.stringify({ error: 'Tool arguments were not valid JSON.' });
      } else {
        if (name !== c.name) r.unknownTools.push(`${c.name}→${name}`);
        allCalls.push({ name, args });
        try { result = runTool(fs, name, args, log); } catch (e) { result = JSON.stringify({ error: (e as Error).message }); }
      }
      r.trace.push(`${c.name}(${(c.args || '').slice(0, 160)}) → ${result.replace(/\s+/g, ' ').slice(0, 160)}`);
      messages.push({ role: 'tool', tool_call_id: c.id, content: result });
    }
  }
  r.reason = `no final answer within ${MAX_TURNS} turns`;
  // An edit can land without a closing message; judge the workspace anyway.
  if (task.id === 'edit' && task.check({ text: '', calls: allCalls, fs, log }) === null) { r.pass = true; r.reason = null; }
  return r;
}

/* ---------- verdict ---------- */

interface ModelReport {
  key: string;
  currentTier: ModelTier;
  workerTools: boolean | undefined;
  score: number;
  /** Runs that reached the model — an HTTP refusal says nothing about how well it works. */
  of: number;
  httpFailed: number;
  medianTurnMs: number | null;
  verdict: string;
  notes: string[];
  tasks: TaskResult[];
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const BUSY = /\b429\b|rate|limit|overload|temporar|exhaust|capacity|busy/i;

/** These tasks are easy: they separate working from broken, not frontier from mid — nearly every
 *  live model passes them all. So a failure may demote a tag, a clean sheet never promotes one
 *  (an untagged model that works becomes `mid`). Promotion needs harder tasks. */
function suggest(r: ModelReport): string {
  if (r.of < Math.ceil(r.tasks.length / 2)) {
    const errs = r.tasks.flatMap((t) => t.errors);
    return errs.length && errs.every((e) => !BUSY.test(e)) && r.of === 0 ? 'disable (dead)' : 'busy (re-run)';
  }
  const rate = r.score / r.of;
  if (rate === 1) return r.currentTier === 'unknown' ? 'mid' : r.currentTier;
  if (rate >= 0.8) return TIER_ORDER[r.currentTier] < TIER_ORDER.mid ? 'mid' : r.currentTier;
  return 'small';
}

/* ---------- main ---------- */

async function main(): Promise<void> {
  const store = new Map<string, unknown>();
  const mem = { get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d), update: async (k: string, v: unknown) => { store.set(k, v); }, keys: () => [...store.keys()] };
  const catalog = new Catalog(join(__dirname, '..'));
  const synced = await catalog.refresh(process.env.CATALOG_URL ?? WORKER, mem as never);
  if (!synced) console.log('worker unreachable — using the bundled catalog');

  const onlyPlatforms = process.env.PLATFORMS?.split(',').map((s) => s.trim()).filter(Boolean);
  const onlyModels = process.env.MODELS?.split(',').map((s) => s.trim()).filter(Boolean);
  const onlyTasks = process.env.TASKS?.split(',').map((s) => s.trim()).filter(Boolean);
  const tasks = TASKS.filter((t) => !onlyTasks || onlyTasks.includes(t.id));
  const repeat = Math.max(1, Number(process.env.REPEAT ?? 2) || 2);

  const keyFor = (p: Platform): string | null => {
    const env = process.env[`TIERMUX_KEY_${p.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
    if (env) return env;
    return getPlatformInfo(p)?.keyless ? '' : null;
  };
  const models = catalog.all().filter((m) => {
    if (onlyModels) return onlyModels.includes(`${m.platform}::${m.modelId}`);
    if (onlyPlatforms && !onlyPlatforms.includes(m.platform)) return false;
    return keyFor(m.platform) !== null;
  });
  if (!models.length) { console.log('nothing to evaluate (no keyless platform matched; set PLATFORMS/MODELS or TIERMUX_KEY_<PLATFORM>)'); return; }

  const toolSet = buildV3ToolSet('agent', {});
  const tools: ChatToolDefinition[] = [];
  for (const [name, t] of Object.entries(toolSet)) {
    const tt = t as { description?: string; inputSchema: unknown; inputExamples?: Array<{ input: unknown }> };
    const schema = await asSchema(tt.inputSchema as never).jsonSchema;
    const examples = (tt.inputExamples ?? []).map((e) => JSON.stringify(e.input)).join('\n');
    tools.push({ type: 'function', function: { name, description: examples ? `${tt.description ?? ''}\n\nInput examples:\n${examples}`.trim() : tt.description, parameters: schema as Record<string, unknown> } });
  }
  const toolNames = new Set(tools.map((t) => t.function.name));
  const system = composeSystemPrompt('agent');

  console.log(`evaluating ${models.length} model(s) × ${tasks.length} task(s) × ${repeat} run(s) — platforms run in parallel, models within one in sequence\n`);
  const byPlatform = new Map<Platform, CatalogModel[]>();
  for (const m of models) byPlatform.set(m.platform, [...(byPlatform.get(m.platform) ?? []), m]);

  const reports: ModelReport[] = [];
  await Promise.all([...byPlatform.entries()].map(async ([platform, list]) => {
    const key = keyFor(platform) ?? '';
    for (const m of list) {
      const results: TaskResult[] = [];
      for (let rep = 0; rep < repeat; rep++) for (const t of tasks) results.push(await runTask(m, key, t, system, tools, toolNames));
      const score = results.filter((t) => t.pass).length;
      const httpFailed = results.filter((t) => !t.pass && t.reason?.startsWith('HTTP error')).length;
      const turnMs = results.flatMap((t) => (t.turns ? [t.ms / t.turns] : []));
      const notes: string[] = [];
      const bad = results.reduce((n, t) => n + t.badArgs, 0);
      if (bad) notes.push(`${bad} bad-JSON args`);
      const unknown = [...new Set(results.flatMap((t) => t.unknownTools))];
      if (unknown.length) notes.push(`called unknown: ${unknown.join(',')}`);
      const toolPasses = results.filter((t) => t.pass && t.toolCalls > 0).length;
      if (m.supportsTools === false && toolPasses > 0) notes.push('worker says tools:false but it used tools');
      if (httpFailed) notes.push(`${httpFailed} run(s) refused: ${[...new Set(results.flatMap((t) => t.errors.map((e) => e.slice(0, 60))))].slice(0, 2).join(' | ')}`);
      for (const t of results) if (!t.pass && !t.reason?.startsWith('HTTP error')) notes.push(`${t.task}: ${t.reason}`);
      const report: ModelReport = {
        key: `${m.platform}::${m.modelId}`,
        currentTier: tierOf(m),
        workerTools: m.supportsTools,
        score,
        of: results.length - httpFailed,
        httpFailed,
        medianTurnMs: median(turnMs),
        verdict: '',
        notes,
        tasks: results,
      };
      report.verdict = suggest(report);
      reports.push(report);
      const sec = report.medianTurnMs === null ? '   -' : (report.medianTurnMs / 1000).toFixed(1).padStart(4);
      console.log(`done  ${report.key.padEnd(52)} ${score}/${report.of}${httpFailed ? ` (+${httpFailed} refused)` : ''}  ${sec}s/turn  ${report.currentTier} → ${report.verdict}`);
    }
  }));

  const rateOf = (r: ModelReport): number => (r.of ? r.score / r.of : -1);
  reports.sort((a, b) => rateOf(b) - rateOf(a) || b.of - a.of || (a.medianTurnMs ?? Infinity) - (b.medianTurnMs ?? Infinity));
  console.log('\n' + ['model'.padEnd(52), 'score'.padEnd(5), 'refused', 's/turn', 'now'.padEnd(8), 'suggest'.padEnd(22), 'notes'].join('  '));
  for (const r of reports) {
    const sec = r.medianTurnMs === null ? '-' : (r.medianTurnMs / 1000).toFixed(1);
    const changed = r.verdict !== r.currentTier ? '*' : ' ';
    console.log([r.key.padEnd(52), `${r.score}/${r.of}`.padEnd(5), String(r.httpFailed).padStart(7), sec.padStart(6), r.currentTier.padEnd(8), `${changed}${r.verdict}`.padEnd(22), r.notes.join('; ').slice(0, 160)].join('  '));
  }
  console.log('\n* = suggestion differs from the current tag');

  const outDir = join(__dirname, '..', '.benchmarks');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `model-eval-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), tasks: tasks.map((t) => t.id), reports }, null, 2));
  console.log(`details: ${out}`);
}

main().catch((e) => {
  console.error('eval crashed:', e);
  process.exit(1);
});
