/* One HUGE, multi-part task through the real agent loop in AGENT mode (edits enabled), on Auto.
 *
 * The other harnesses all stop short of this: the quality bench and taskSim run read-only
 * (ask/plan), and humanSim tests continuity rather than execution. Nothing so far has answered
 * the question a user actually has — "if I hand it a real, big job, does it finish?"
 *
 * SAFETY: the workspace is a detached git worktree passed as argv[2], never the developer's
 * checkout. Every edit the agent makes lands there and is thrown away. Refuses to run if the
 * target looks like the main working tree.
 *
 * Instrumentation is aimed at WHERE it breaks, not just whether it did: the full tool sequence,
 * the stop reason, the todo list it kept, and which of the task's parts it actually touched.
 *
 * Run: npm run test:e2e:complex-task -- <worktree-path>
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildHarness, syncRemoteProviders } from './bench/routerHarness';
import { setWorkspaceRoot } from './bench/agentHarness';
import { runTurn } from '../src/agent/core/loop';
import { setGates } from '../src/agent/core/tools/gates';
import { CommandGate } from '../src/edits/commandGate';
import { EditGate } from '../src/edits/applyEdit';
import type { AgentOpts } from '../src/agent/agent';

const TASK = `Add a per-turn tool-call budget to the agent loop, end to end:

1. Add a \`tiermux.agent.maxToolCallsPerTurn\` setting (number, default 40, 0 = unlimited) to package.json's configuration section, with a description.
2. Read it in src/agent/core/loop.ts and stop the turn once that many tool calls have been made in a single turn, reusing the existing stopWhen/stopReason machinery rather than inventing a new one.
3. When it trips, the user must get a clear message saying the budget was hit and what was done so far — not a silent stop.
4. Make sure the existing loop-control stops (stuck, budget, step cap) still work and you have not changed their behaviour.

Report which files you changed and why each change was needed.`;

/** The parts of the task, and a cheap check for whether the run actually touched each. */
const PARTS: Array<{ name: string; touched: (files: string[], text: string) => boolean }> = [
  { name: '1. setting in package.json', touched: (f) => f.some((p) => p.endsWith('package.json')) },
  { name: '2. loop.ts stop wiring', touched: (f) => f.some((p) => p.endsWith('src/agent/core/loop.ts')) },
  { name: '3. user-visible message', touched: (_f, t) => /budget|maxToolCalls|tool[- ]call/i.test(t) },
  { name: '4. existing stops preserved', touched: (_f, t) => /stuck|step cap|stopWhen|stopReason/i.test(t) },
];

(async () => {
  const root = process.argv[2];
  if (!root || !fs.existsSync(root)) { console.error('usage: complex-task <worktree-path>'); process.exit(2); }
  const resolved = fs.realpathSync(root);
  if (resolved === fs.realpathSync(process.cwd())) {
    console.error('REFUSING to run against the current working tree — pass a disposable git worktree.');
    process.exit(2);
  }

  setWorkspaceRoot(resolved);
  // Auto-approve everything: there is no human here, and the worktree is disposable.
  setGates(new EditGate(() => false), new CommandGate(() => 'always', () => 20_000, () => []));
  await syncRemoteProviders().catch(() => {});
  const { router } = buildHarness({});

  const tools: string[] = [];
  const edited = new Set<string>();
  let model = '';
  let todos: Array<{ content?: string; status?: string }> = [];

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 900_000); // 15 min — a huge task deserves room
  const t0 = Date.now();

  const opts = {
    messages: [{ role: 'user', content: TASK }],
    mode: 'agent',
    effort: 'medium',
    sessionId: 'complex-1',
    abortSignal: ac.signal,
    onChunk: () => {},
    onTool: (e: { state: string; name: string; args?: unknown }) => {
      if (e.state !== 'running') return;
      tools.push(e.name);
      const p = (e.args as { path?: unknown })?.path;
      if (typeof p === 'string' && /^(write|edit|create|delete)/i.test(e.name)) edited.add(p);
    },
    onReasoning: () => {},
    onModel: (p: string, m: string) => { model = `${p}::${m}`; },
    onFailover: () => {},
    onStep: () => {},
    onTodos: (t: typeof todos) => { todos = t; },
    onAskUser: async () => '',
    onError: (m: string) => console.error('onError:', m),
  } as unknown as AgentOpts;

  const res = await runTurn(router, opts);
  clearTimeout(timer);
  const answer = (res.text ?? '').trim();
  const mins = ((Date.now() - t0) / 60_000).toFixed(1);

  // What actually changed on disk — the only claim that cannot be talked around.
  let diff = '';
  try {
    diff = require('child_process').execSync('git -C "' + resolved + '" diff --stat', { encoding: 'utf8' }).trim();
  } catch { /* best effort */ }

  console.log(`\n══════ complex task, agent mode, Auto ══════`);
  console.log(`model: ${model}   taskKind: ${res.taskKind}   ${mins} min`);
  console.log(`tool calls: ${tools.length}   stopReason: ${res.stopReason ?? '—'}   paused: ${res.paused}`);
  console.log(`tool sequence: ${tools.join(' → ').slice(0, 600)}`);
  console.log(`\ntodos kept (${todos.length}):`);
  todos.forEach((t) => console.log(`  [${t.status}] ${t.content}`));
  console.log(`\ngit diff --stat in the sandbox:\n${diff || '  (no changes made)'}`);
  console.log(`\npart coverage:`);
  const files = [...edited, ...diff.split('\n').map((l) => l.trim().split(' ')[0]).filter(Boolean)];
  PARTS.forEach((p) => console.log(`  ${p.touched(files, answer) ? '✓' : '✗'} ${p.name}`));
  console.log(`\nanswer (${answer.length} chars):\n${answer.slice(0, 1200)}`);
})();
