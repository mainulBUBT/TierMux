/* The focus pulse (engine.ts, 2026-11-11): on every 6th step of a long turn, when the todo list
 * has CHANGED since the last pulse, the engine appends a compact <progress> note as the last
 * message — the system prompt's todo block is a turn-start snapshot and a long turn drifts
 * from it (Cline's Focus-Chain lesson). This drives a scripted 8-step turn and asserts the
 * pulse arrived at the pulse step, not before, and carried n/m + open items.
 * Run: npm run test:e2e:focus-pulse */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runAgentStream } from '../src/agent/agent';
import { __setEngineModelForTests, formatProgressPulse } from '../src/agent/core/engine';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';
import { createMockModel } from './mockModel';
import type { AgentOpts, AgentResult } from '../src/agent/agent';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : ` — ${d}`}`); if (!c) bad++; };

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-pulse-'));
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(tmp, 'b.txt'), 'two\n');

  // Script: mark 8 todos (6 open, 2 done), then read files until the pulse step, then answer.
  const todoCall = (statuses: string[]) => ({
    toolCallId: 'tc0', toolName: 'todoWrite',
    input: { todos: statuses.map((status, i) => ({ content: `item ${i + 1}`, status })) },
  });
  const read = (f: string) => ({ toolCallId: 'r' + f, toolName: 'readFile', input: { path: f } });
  const script = [
    { toolCalls: [todoCall(['completed', 'completed', 'in_progress', 'pending', 'pending', 'pending', 'pending', 'pending'])] },
    { toolCalls: [read('a.txt')] },
    { toolCalls: [read('b.txt')] },
    { toolCalls: [read('a.txt')] },
    { toolCalls: [read('b.txt')] },
    { toolCalls: [read('a.txt')] },
    { toolCalls: [read('b.txt')] },
    { text: 'done with the list' },
  ];

  const inner = createMockModel(script);
  const seenPrompts: string[] = [];
  const recording: typeof inner = {
    ...inner,
    doGenerate: async (opts) => { seenPrompts.push(JSON.stringify(opts.prompt)); return inner.doGenerate(opts); },
    doStream: async (opts) => { seenPrompts.push(JSON.stringify(opts.prompt)); return inner.doStream(opts); },
  };

  const opts: AgentOpts = {
    messages: [{ role: 'user', content: 'work the todos' }],
    mode: 'agent',
    effort: 'medium',
    onChunk: () => {}, onTool: () => {}, onReasoning: () => {}, onModel: () => {},
    onFailover: () => {}, onStep: () => {}, onTodos: () => {},
    onAskUser: async () => ({ status: 'answered' as const, answers: [] }),
    onError: () => {},
  };
  __setEngineModelForTests(recording);
  let result: AgentResult;
  try {
    result = await runWithWorkspaceRoot(tmp, () => runAgentStream(opts));
  } finally {
    __setEngineModelForTests(undefined);
  }

  ok('the scripted turn ran to its final answer', /done with the list/.test(result.text ?? ''), JSON.stringify(result.text).slice(0, 60));
  ok('it used every scripted step', seenPrompts.length === script.length, `${seenPrompts.length} model calls`);
  const pulseAt = seenPrompts.findIndex((p) => p.includes('<progress>'));
  ok('the pulse arrived', pulseAt !== -1, 'no <progress> in any step prompt');
  ok('…at the 6th step (index 6), not before', pulseAt === 6, `first at call ${pulseAt}`);
  ok('…carrying n/m and the open items',
    seenPrompts[6].includes('2/8 todos done') && seenPrompts[6].includes('item 3') && seenPrompts[6].includes('Last completed: item 2'),
    seenPrompts[6].slice(-400));
  ok('no pulse before the todo list could have drifted', seenPrompts.slice(0, 6).every((p) => !p.includes('<progress>')));

  // Pure helper: all-done list closes the turn instead of restating work.
  const closing = formatProgressPulse([{ content: 'x', status: 'completed' }, { content: 'y', status: 'completed' }]);
  ok('an all-done pulse says close the turn', /Everything on the list is done/.test(closing), closing.slice(0, 80));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(bad === 0 ? '\nall focus-pulse checks passed' : `\n${bad} check(s) FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error('e2e crashed:', e); process.exit(1); });
