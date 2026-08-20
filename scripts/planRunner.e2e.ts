/* First-class plan execution (src/agent/core/planRunner.ts), driven through the REAL engine
 * (runTurn → runStepTask) with a scripted router, the same harness pattern as
 * stepExecutor.e2e.ts. Covers:
 *   - happy path: steps run in order, plan checklist flows to onTodos, history accumulates
 *     per-step prompt+summary pairs, terminal status 'done'
 *   - verify-failure handling: same-model retry with failure output, read-only plan repair
 *     rewriting the remaining steps, and the safety invariant that a verify failure NEVER
 *     changes routing constraints (no excludeModels, no new rank constraints on the retry)
 *   - pause/resume: an aborted run parks as 'paused' at currentStep and re-invocation
 *     continues from there without re-executing finished steps
 *
 * Run: npm run test:e2e:plan-runner
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runPlan, planTodos } from '../src/agent/core/planRunner';
import { setGates } from '../src/agent/core/tools/gates';
import { CommandGate, type CommandApproval } from '../src/edits/commandGate';
import { EditGate } from '../src/edits/applyEdit';
import type { Router } from '../src/router/router';
import type { AgentOpts } from '../src/agent/agent';
import type { PlanRunState } from '../src/shared/types';

let failures = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `   (${extra})` : ''}`);
  if (!cond) failures++;
};

function baseResponse(overrides: Record<string, unknown>) {
  return {
    id: 'r', object: 'chat.completion' as const, created: 0, model: 'fake',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant' as const, content: null, ...overrides } }],
  };
}
const toolCall = (id: string, name: string, args: unknown) =>
  ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

const PLAN_STEPS = [
  'Create src/a.ts with the config loader',
  'Update src/b.ts to use the loader',
  'Run the test suite to confirm nothing broke',
];

function makeState(steps: string[] = PLAN_STEPS): PlanRunState {
  return {
    id: `plan-${Date.now()}`,
    originalTask: 'add the config loader',
    steps: steps.map((text) => ({ text, status: 'pending', attempts: 0 })),
    currentStep: 0,
    status: 'running',
    repairs: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-require
  const vscode = require('vscode');
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-planrunner-e2e-'));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot, path: workspaceRoot } }];

  const commandGate = new CommandGate(() => 'always' as CommandApproval, () => 5000, () => []);
  const editGate = new EditGate(() => false);
  setGates(editGate, commandGate);

  function makeOpts(overrides: Partial<AgentOpts> = {}): AgentOpts {
    return {
      messages: [{ role: 'user', content: 'add the config loader' }],
      mode: 'agent',
      effort: 'medium',
      onChunk: () => {}, onTool: () => {}, onReasoning: () => {}, onModel: () => {},
      onFailover: () => {}, onStep: () => {}, onTodos: () => {},
      onAskUser: async () => '', onError: (m) => console.error('onError:', m),
      ...overrides,
    };
  }

  console.log('— planTodos maps plan state to the todo contract —');
  {
    const todos = planTodos(makeState());
    ok('every pending step is a pending todo', todos.length === 3 && todos.every((t) => t.status === 'pending'));
    ok('difficulty inferred from the step text', todos[0].difficulty !== undefined || todos[2].difficulty !== undefined);
  }

  console.log('\n— happy path: 3 steps run in order, verify off —');
  {
    (globalThis as any).__tiermuxTestConfig = { mixturePipeline: 'off', verifyCommand: 'off' };
    const script: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 3; i++) {
      script.push(
        { tool_calls: [toolCall(`t${i}`, 'todowrite', { todos: [{ content: `subtask ${i + 1}`, status: 'completed' }] })] },
        { tool_calls: [toolCall(`c${i}`, 'runCommand', { command: `printf step-${i + 1}` })] },
        { content: `Step ${i + 1} done.` },
      );
    }
    let n = 0;
    const stepPrompts: string[] = [];
    const fakeRouter = {
      async route(_m: unknown, opts: unknown) {
        n++;
        void opts;
        const next = script.shift();
        return { platform: 'custom' as const, model: 'fake', response: baseResponse(next ?? { content: 'done.' }) };
      },
      peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
    } as unknown as Router;

    const history: Array<{ role: string; content: string }> = [];
    const todoEmits: number[] = [];
    let lastTodos = 0;
    const state = makeState();
    const result = await runPlan(fakeRouter, makeOpts(), state, {
      onTodos: (todos) => { lastTodos = todos.filter((t) => t.status === 'completed').length; todoEmits.push(lastTodos); },
      onHistory: (msgs) => { for (const m of msgs) history.push({ role: m.role, content: String(m.content) }); },
      onState: (st) => void st,
    });
    ok('plan completed', result.state.status === 'done');
    ok('all steps done', result.state.steps.every((s) => s.status === 'done'));
    ok('steps ran in order without re-execution', n === 9, `${n} model calls`);
    ok('history carries per-step prompt+summary pairs', history.length === 6 && history[0].role === 'user' && history[1].role === 'assistant');
    ok('step prompts are bracketed and name later steps explicitly',
      history[0].content.includes('[Plan execution — step 1 of 3]') && history[0].content.includes('Update src/b.ts'));
    ok('final checklist fully completed', lastTodos === 3);
    ok('todos emitted at least once per step transition', todoEmits.length >= 3);
    ok('summary states completion with verification stats', result.summary.includes('3/3 step(s) done') && result.summary.includes('⚠️ 3 untested'));
  }

  console.log('\n— verify failure: same-model retry, plan repair, no routing escalation —');
  {
    (globalThis as any).__tiermuxTestConfig = { mixturePipeline: 'off', verifyCommand: 'false' };
    // Engine shape per round (verify always runs 'false'): mutation → natural finish → verify
    // fails → VERIFY_FAILED_NUDGE retry (text-only, so the gate settles) → round ends 'failed'.
    // Attempt 1 = round 1 + one unaccepted round; attempt 2 = the same shape; then the
    // repaired step runs with verification turned off and passes.
    const text = (s: string) => ({ content: s });
    const cmd = (id: string, c: string) => ({ tool_calls: [toolCall(id, 'runCommand', { command: c })] });
    const todoW = (id: string) => ({ tool_calls: [toolCall(id, 'todowrite', { todos: [{ content: 'Edit src/b.ts', status: 'completed', difficulty: 'hard' }] })] });
    const script: Array<Record<string, unknown>> = [
      // Attempt 1 — round 1
      todoW('t1'), cmd('c1', 'printf one'), text('Fixed it.'), text('Adjusted the import path.'),
      // Attempt 1 — unaccepted round 2
      cmd('c2', 'printf two'), text('Reran.'), text('Tweaked again.'),
      // Attempt 2 — round 1
      todoW('t2'), cmd('c3', 'printf three'), text('Fixed again.'), text('Adjusted once more.'),
      // Attempt 2 — unaccepted round 2
      cmd('c4', 'printf four'), text('Reran again.'), text('Tweaked differently.'),
      // Repaired step (verify off from here)
      todoW('t3'), cmd('c5', 'printf five'), text('Done.'),
    ];
    const routeOpts: any[] = [];
    const fakeRouter = {
      async route(_m: unknown, opts: unknown) {
        routeOpts.push(opts ?? {});
        const next = script.shift();
        return { platform: 'custom' as const, model: 'fake', response: baseResponse(next ?? { content: 'done.' }) };
      },
      peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
    } as unknown as Router;

    const repairCalls: Array<{ failure: string; remaining: string[] }> = [];
    const state = makeState(['Edit src/b.ts to add the guard']);
    const result = await runPlan(fakeRouter, makeOpts(), state, {
      repairSteps: async (failure, remaining) => {
        repairCalls.push({ failure, remaining });
        // Flip verification off — the repaired step is scripted to succeed.
        (globalThis as any).__tiermuxTestConfig = { mixturePipeline: 'off', verifyCommand: 'off' };
        return ['Edit src/b.ts differently and rerun the suite'];
      },
      onTodos: () => {},
      onHistory: () => {},
      onState: () => {},
    });
    ok('plan repair was consulted exactly once', repairCalls.length === 1, `${repairCalls.length} calls`);
    ok('repair saw the failing step in the remaining list', repairCalls[0]?.remaining.some((r) => r.includes('src/b.ts')) === true);
    ok('repaired plan finished', result.state.status === 'done' && result.state.repairs === 1);
    ok('the repaired step replaced the failing one', result.state.steps[0]?.text === 'Edit src/b.ts differently and rerun the suite');

    // THE invariant: verify failure must never become a model escalation.
    ok('no verify-failure call ever requested a model exclusion', routeOpts.every((o) => !o.excludeModels || !o.excludeModels.length));
    const constraintOf = (o: any) => JSON.stringify({ max: o?.maxIntelligenceRank ?? null, min: o?.minIntelligenceRank ?? null, excl: o?.excludeModels ?? null });
    // Attempt 1 = first 7 route calls, attempt 2 = next 7 — identical constraint sets.
    const a1 = new Set(routeOpts.slice(0, 7).map(constraintOf));
    const a2 = new Set(routeOpts.slice(7, 14).map(constraintOf));
    ok('retry attempt ran under the identical routing constraints', a1.size === a2.size && [...a1].every((c) => a2.has(c)), `a1=${[...a1].join('|')} a2=${[...a2].join('|')}`);
  }

  console.log('\n— pause & resume: an aborted run parks and continues without redoing work —');
  {
    (globalThis as any).__tiermuxTestConfig = { mixturePipeline: 'off', verifyCommand: 'off' };
    const script: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 9; i++) {
      const step = Math.floor(i / 3) + 1;
      if (i % 3 === 0) script.push({ tool_calls: [toolCall(`t${i}`, 'todowrite', { todos: [{ content: `subtask ${step}`, status: 'completed' }] })] });
      else if (i % 3 === 1) script.push({ tool_calls: [toolCall(`c${i}`, 'runCommand', { command: `printf s${step}` })] });
      else script.push({ content: `Step ${step} done.` });
    }
    let n = 0;
    let allowRun = true;
    const fakeRouter = {
      async route() {
        n++;
        return { platform: 'custom' as const, model: 'fake', response: baseResponse(script.shift() ?? { content: 'done.' }) };
      },
      peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
    } as unknown as Router;

    const state = makeState();
    // Abort right after step 1 completes.
    const first = await runPlan(fakeRouter, makeOpts(), state, {
      isActive: () => allowRun,
      onTodos: () => {},
      onHistory: () => {},
      onState: (st) => { if (st.steps[0]?.status === 'done' && st.steps[1]?.status !== 'done') allowRun = false; },
    });
    ok('aborted run parked as paused after step 1', first.state.status === 'paused' && first.state.currentStep === 1);
    ok('step 1 done, steps 2-3 still pending', first.state.steps[0].status === 'done' && first.state.steps.slice(1).every((s) => s.status === 'pending'));
    ok('only step 1 consumed model calls', n === 3, `${n} calls`);

    allowRun = true;
    const resumed = await runPlan(fakeRouter, makeOpts(), first.state, {
      isActive: () => allowRun,
      onTodos: () => {},
      onHistory: () => {},
      onState: () => {},
    });
    ok('resumed run finished', resumed.state.status === 'done');
    ok('resume did not redo step 1 (9 calls total)', n === 9, `${n} calls`);
    ok('resume summary counts all steps', resumed.summary.includes('3/3 step(s) done'));
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
