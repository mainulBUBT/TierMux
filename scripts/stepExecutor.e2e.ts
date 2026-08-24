// End-to-end test for Phase 3's step engine (src/agent/core/stepEngine.ts):
//   - decideStepRound: the shared continue/stop decision (todos, stall recovery, fresh budget,
//     step-cap resume, and the NEW step-acceptance rule — a "completed" checklist whose verify
//     command failed is NOT accepted)
//   - runStepTask: the headless multi-round executor (rounds route by the executing step's
//     difficulty, continuation messages are produced but pushed nowhere UI-side)
//   - AgentResult.verifyOutcome plumbing from runTurn's command gate
//
// Run: npm run test:e2e:step-executor
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTurn } from '../src/agent/core/loop';
import { decideStepRound, runStepTask } from '../src/agent/core/stepEngine';
import type { StepRoundInput } from '../src/agent/core/stepEngine';
import { setGates } from '../src/agent/core/tools/gates';
import { CommandGate, type CommandApproval } from '../src/edits/commandGate';
import { EditGate } from '../src/edits/applyEdit';
import type { Router } from '../src/router/router';
import type { AgentOpts, AgentResult } from '../src/agent/agent';
import type { TodoItem } from '../src/shared/types';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
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

const todo = (content: string, status: TodoItem['status'], difficulty?: TodoItem['difficulty']): TodoItem =>
  ({ content, status, ...(difficulty ? { difficulty } : {}) });

function baseInput(overrides: Partial<StepRoundInput> = {}): StepRoundInput {
  return {
    todos: [],
    result: { text: 'done' } as AgentResult,
    stuckContinuations: 0, maxStuckContinuations: 1,
    budgetContinuations: 0, maxBudgetContinuations: 1,
    unacceptedContinuations: 0, maxUnacceptedContinuations: 1,
    allowModelExclusion: true,
    ...overrides,
  };
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-stepexec-e2e-'));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot, path: workspaceRoot } }];

  const commandGate = new CommandGate(() => 'always' as CommandApproval, () => 5000, () => []);
  const editGate = new EditGate(() => false);
  setGates(editGate, commandGate);
  (globalThis as any).__tiermuxTestConfig = { mixturePipeline: 'off', verifyCommand: 'off' };

  function makeOpts(overrides: Partial<AgentOpts> = {}): AgentOpts {
    return {
      messages: [{ role: 'user', content: 'edit the file' }],
      mode: 'agent',
      effort: 'medium',
      onChunk: () => {},
      onTool: () => {},
      onReasoning: () => {},
      onModel: () => {},
      onFailover: () => {},
      onStep: () => {},
      onTodos: () => {},
      onAskUser: async () => '',
      onError: (m) => console.error('onError:', m),
      ...overrides,
    };
  }

  const strongExecutor = () =>
    ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } });

  // ── Part A: decideStepRound ─────────────────────────────────────────────────────
  {
    ok('decide: no todos, not paused → stop', decideStepRound(baseInput()).action === 'stop');

    const pending = decideStepRound(baseInput({ todos: [todo('Read src/a.ts', 'in_progress', 'easy'), todo('Edit src/b.ts', 'pending', 'hard')] }));
    ok('decide: pending todos → continue (todos)', pending.action === 'continue' && pending.kind === 'todos');
    ok('decide: next round routes by the first remaining step (easy)', pending.difficulty === 'easy');
    ok('decide: continuation message spells out the remaining items', pending.message.includes('Read src/a.ts') && pending.message.includes('Remaining items'));

    const stuck1 = decideStepRound(baseInput({
      todos: [todo('Edit src/b.ts', 'in_progress')],
      result: { text: '', stopReason: 'stuck', platform: 'groq', model: 'm1' } as AgentResult,
    }));
    ok('decide: first stall → continue (stuck) with a different model excluded',
      stuck1.action === 'continue' && stuck1.kind === 'stuck' && stuck1.excludeModels?.[0] === 'groq::m1');
    const stuck2 = decideStepRound(baseInput({
      todos: [todo('Edit src/b.ts', 'in_progress')],
      result: { text: '', stopReason: 'stuck', platform: 'groq', model: 'm1' } as AgentResult,
      stuckContinuations: 1,
    }));
    ok('decide: second stall → stop (cap)', stuck2.action === 'stop');
    const stuckPinned = decideStepRound(baseInput({
      result: { text: '', stopReason: 'stuck', platform: 'groq', model: 'm1' } as AgentResult,
      allowModelExclusion: false,
    }));
    ok('decide: pinned model never excluded on a stall',
      stuckPinned.action === 'continue' && !stuckPinned.excludeModels);

    const budget1 = decideStepRound(baseInput({
      todos: [todo('Edit src/b.ts', 'in_progress')],
      result: { text: '', stopReason: 'budget' } as AgentResult,
    }));
    ok('decide: budget cutoff → continue with a fresh budget', budget1.action === 'continue' && budget1.kind === 'budget');
    const budget2 = decideStepRound(baseInput({
      result: { text: '', stopReason: 'budget' } as AgentResult,
      budgetContinuations: 1,
    }));
    ok('decide: repeated budget cutoff → stop (cap)', budget2.action === 'stop');

    const paused = decideStepRound(baseInput({ result: { text: '', paused: true } as AgentResult }));
    ok('decide: step-cap pause with no todos → continue (resumable)', paused.action === 'continue' && paused.kind === 'paused');

    const unaccepted = decideStepRound(baseInput({
      todos: [todo('Edit src/b.ts', 'completed', 'hard')],
      result: { text: 'all done', verifyOutcome: 'failed' } as AgentResult,
    }));
    ok('decide: checklist complete but verify FAILED → not accepted, one focused retry',
      unaccepted.action === 'continue' && unaccepted.kind === 'unaccepted');
    ok('decide: acceptance message names the failing verify command as the arbiter', unaccepted.message.includes('verify command still FAILS'));
    const unaccepted2 = decideStepRound(baseInput({
      todos: [todo('Edit src/b.ts', 'completed', 'hard')],
      result: { text: 'all done', verifyOutcome: 'failed' } as AgentResult,
      unacceptedContinuations: 1,
    }));
    ok('decide: acceptance retry cap → stop', unaccepted2.action === 'stop');
    const accepted = decideStepRound(baseInput({
      todos: [todo('Edit src/b.ts', 'completed', 'hard')],
      result: { text: 'all done', verifyOutcome: 'passed' } as AgentResult,
    }));
    ok('decide: checklist complete + verify PASSED → stop (goal met)', accepted.action === 'stop');
  }

  // ── Part B: runStepTask (headless multi-round) ──────────────────────────────────
  {
    const routeOpts: any[] = [];
    let n = 0;
    const fakeRouter = {
      async route(_messages: any[], opts: any) {
        routeOpts.push(opts ?? {});
        n++;
        // Round 1: write the checklist (one step done, one hard step left), mutate, report.
        if (n === 1) {
          return { platform: 'custom' as const, model: 'fake', response: baseResponse({ tool_calls: [toolCall('t1', 'todowrite', { todos: [
            { content: 'Read src/a.ts', status: 'completed', difficulty: 'easy' },
            { content: 'Edit src/b.ts to add the guard', status: 'in_progress', difficulty: 'hard' },
          ] })] }) };
        }
        if (n === 2) {
          return { platform: 'custom' as const, model: 'fake', response: baseResponse({ tool_calls: [toolCall('c1', 'runCommand', { command: 'printf edited' })] }) };
        }
        if (n === 3) {
          return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Step 1 done, starting step 2.' }) };
        }
        // Round 2: finish the checklist, mutate again, report.
        if (n === 4) {
          return { platform: 'custom' as const, model: 'fake', response: baseResponse({ tool_calls: [toolCall('t2', 'todowrite', { todos: [
            { content: 'Read src/a.ts', status: 'completed', difficulty: 'easy' },
            { content: 'Edit src/b.ts to add the guard', status: 'completed', difficulty: 'hard' },
          ] })] }) };
        }
        if (n === 5) {
          return { platform: 'custom' as const, model: 'fake', response: baseResponse({ tool_calls: [toolCall('c2', 'runCommand', { command: 'printf edited-again' })] }) };
        }
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'All steps done.' }) };
      },
      peekTopSelection: strongExecutor,
    } as unknown as Router;

    const out = await runStepTask(fakeRouter as any, makeOpts(), { originalTask: 'fix the bug' });
    ok('headless: ran exactly 2 rounds (stopped when the checklist completed)', out.rounds === 2 && n === 6);
    ok('headless: one continuation message, spelling out the remaining step',
      out.continuationMessages.length === 1 && out.continuationMessages[0].content.includes('Edit src/b.ts'));
    ok('headless: final todos all completed', out.todos.length === 2 && out.todos.every((t) => t.status === 'completed'));
    ok('headless: final result carried the last round text', out.result.text.includes('All steps done'));
  }

  // ── Part C: step acceptance — verify-failed "completed" checklist gets focused retries ──
  {
    (globalThis as any).__tiermuxTestConfig = { mixturePipeline: 'off', verifyCommand: 'false' };
    let n = 0;
    const fakeRouter = {
      async route() {
        n++;
        // Simple core: verify runs ONCE as observation (no fix rounds, no planner repair),
        // so each round is exactly three model calls — todowrite, mutation, report.
        // Round 1: checklist in_progress + mutation; verify 'false' fails.
        if (n === 1) return { platform: 'custom' as const, model: 'fake', response: baseResponse({ tool_calls: [toolCall('t8', 'todowrite', { todos: [
          { content: 'Edit src/b.ts', status: 'in_progress', difficulty: 'hard' },
        ] })] }) };
        if (n === 2) return { platform: 'custom' as const, model: 'fake', response: baseResponse({ tool_calls: [toolCall('a1', 'runCommand', { command: 'printf one' })] }) };
        if (n === 3) return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Fixed it.' }) };
        // Round 2 (todos continue): mark completed, mutate, report; verify fails again.
        if (n === 4) return { platform: 'custom' as const, model: 'fake', response: baseResponse({ tool_calls: [toolCall('t9', 'todowrite', { todos: [
          { content: 'Edit src/b.ts', status: 'completed', difficulty: 'hard' },
        ] })] }) };
        if (n === 5) return { platform: 'custom' as const, model: 'fake', response: baseResponse({ tool_calls: [toolCall('a2', 'runCommand', { command: 'printf two' })] }) };
        if (n === 6) return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Done.' }) };
        // Round 3 (unaccepted retry): explain, no mutation → gate skipped → loop stops.
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'The test failure predates this change.' }) };
      },
      peekTopSelection: strongExecutor,
    } as unknown as Router;

    const out = await runStepTask(fakeRouter as any, makeOpts({ messages: [{ role: 'user', content: 'fix the bug' }] }));
    // maxUnacceptedContinuations defaults to 2, but round 3's no-mutation response has no
    // verify signal (verifyOutcome undefined) — the acceptance rule needs 'failed' — so the
    // loop stops at 'goal met' after exactly ONE unaccepted retry, same as the old cap of 1.
    ok('acceptance: ran 3 rounds (work, complete-claim, acceptance retry)', out.rounds === 3);
    ok('acceptance: todos-continue first, then the acceptance rejection',
      out.continuationMessages.length === 2
      && out.continuationMessages[0].content.includes('unfinished items')
      && out.continuationMessages[1].content.includes('not accepted'));
    ok('acceptance: final round had no mutation → verify gate skipped, loop stopped', out.result.verifyOutcome === undefined);
  }

  // ── Part D: verifyOutcome plumbing through runTurn ──────────────────────────────
  {
    (globalThis as any).__tiermuxTestConfig = { mixturePipeline: 'off', verifyCommand: 'true' };
    const mutateThenFinal = (() => {
      let k = 0;
      return {
        async route() {
          k++;
          if (k === 1) return { platform: 'custom' as const, model: 'fake', response: baseResponse({ tool_calls: [toolCall('v1', 'runCommand', { command: 'printf x' })] }) };
          return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Done.' }) };
        },
        peekTopSelection: strongExecutor,
      } as unknown as Router;
    })();
    const passed = await runTurn(mutateThenFinal, makeOpts());
    ok('plumbing: passing verify command → verifyOutcome=passed', passed.verifyOutcome === 'passed');

    (globalThis as any).__tiermuxTestConfig = { mixturePipeline: 'off', verifyCommand: 'off' };
    const mutateOnly = (() => {
      let k = 0;
      return {
        async route() {
          k++;
          if (k === 1) return { platform: 'custom' as const, model: 'fake', response: baseResponse({ tool_calls: [toolCall('v2', 'runCommand', { command: 'printf x' })] }) };
          return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Done.' }) };
        },
        peekTopSelection: strongExecutor,
      } as unknown as Router;
    })();
    const unverified = await runTurn(mutateOnly, makeOpts());
    ok('plumbing: mutation with no verify command → verifyOutcome=unverified', unverified.verifyOutcome === 'unverified');

    const textOnly = (() => {
      return {
        async route() { return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Just an answer.' }) }; },
        peekTopSelection: strongExecutor,
      } as unknown as Router;
    })();
    const none = await runTurn(textOnly, makeOpts());
    ok('plumbing: no mutation → verifyOutcome undefined', none.verifyOutcome === undefined);
  }

  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
