// End-to-end test for the end-of-turn command verify gate and the planner→todo seeding
// (loop.ts). Drives the REAL runTurn() → createRouterProvider() → streamText() → tools
// pipeline with a scripted fake Router (same seam as coreLoop/selfCorrect e2e): the fake's
// route() returns canned chat.completion responses, so the whole loop above it runs for real,
// including the CommandGate-backed verify command execution.
//
// Covers:
//   1. verify command passes → no caveat, no Unverified badge (observed pass counts as verified)
//   2. verify command fails → exactly one fix retry carrying the failure output; a retry that
//      mutates gets the command re-run, and a pass clears the failure
//   3. verify command still fails after the retry → deterministic "Verification failed" note
//   4. planner step (mixture 'on') seeds the todo checklist and its `Verify:` line drives the gate
//   5. verifyCommand 'off' → gate skipped, the old Unverified-claim badge still applies
//
// Run: npm run test:e2e:verify-gate
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTurn } from '../src/agent/core/loop';
import { setGates } from '../src/agent/core/tools/gates';
import { CommandGate, type CommandApproval } from '../src/edits/commandGate';
import { EditGate } from '../src/edits/applyEdit';
import type { Router } from '../src/router/router';
import type { AgentOpts } from '../src/agent/agent';

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

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-verifygate-e2e-'));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot, path: workspaceRoot } }];

  const commandGate = new CommandGate(() => 'always' as CommandApproval, () => 5000, () => []);
  const editGate = new EditGate(() => false);
  setGates(editGate, commandGate);

  const setConfig = (overrides: Record<string, unknown>) => { (globalThis as any).__tiermuxTestConfig = overrides; };

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

  // --- Test 1: verify command passes → no caveat of any kind ---
  {
    setConfig({ mixturePipeline: 'off', verifyCommand: 'true' });
    const steps: string[] = [];
    let n = 0;
    const fakeRouter = {
      async route() {
        n++;
        if (n === 1) {
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'g1', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: 'printf edited-the-file' }) } }] }),
          };
        }
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Fixed.' }) };
      },
      peekTopSelection: strongExecutor,
    } as unknown as Router;

    const result = await runTurn(fakeRouter, makeOpts({ onStep: (_p, label) => steps.push(label) }));
    ok('gate pass: exactly 2 router calls (no retry on a passing gate)', n === 2);
    ok('gate pass: the verify command actually ran', steps.some((s) => s.startsWith('Verifying with true')));
    ok('gate pass: no Verification-failed note', !result.text.includes('Verification failed'));
    ok('gate pass: observed pass satisfies the honesty backstop (no Unverified badge)', !result.text.includes('Unverified'));
  }

  // --- Test 2: verify fails → one retry with the output; a mutating retry is re-checked ---
  {
    const marker = path.join(workspaceRoot, 'gate-ok-marker.txt');
    const verifyCmd = `test -f ${JSON.stringify(marker)}`;
    setConfig({ mixturePipeline: 'off', verifyCommand: verifyCmd });
    const routeCalls: Array<{ messages: any[] }> = [];
    let n = 0;
    const fakeRouter = {
      async route(messages: any[]) {
        routeCalls.push({ messages });
        n++;
        if (n === 1) {
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'g2', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: 'printf edited-the-file' }) } }] }),
          };
        }
        if (n === 2) {
          return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Fixed.' }) };
        }
        if (n === 3) {
          // The gate retry: actually make the verify command pass.
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'g2b', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: `touch ${JSON.stringify(marker)}` }) } }] }),
          };
        }
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Now fixed for real.' }) };
      },
      peekTopSelection: strongExecutor,
    } as unknown as Router;

    const result = await runTurn(fakeRouter, makeOpts());
    ok('gate retry: exactly 4 router calls (attempt×2 + retry tool + retry final)', n === 4);
    const retryText = JSON.stringify(routeCalls[2].messages);
    // (Command substring is checked by marker name — JSON.stringify escapes the quoted path.)
    ok('gate retry: nudge carries the failure output and command', retryText.includes('FAILED') && retryText.includes('gate-ok-marker.txt'));
    ok('gate retry: a mutating retry gets re-checked and a pass clears the failure', !result.text.includes('Verification failed'));
    ok('gate retry: final answer is the retry\'s text', result.text.includes('Now fixed for real.'));
  }

  // --- Test 3: verify still fails after the retry → deterministic failure note ---
  {
    setConfig({ mixturePipeline: 'off', verifyCommand: 'false' });
    let n = 0;
    const fakeRouter = {
      async route() {
        n++;
        if (n === 1) {
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'g3', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: 'printf edited-the-file' }) } }] }),
          };
        }
        if (n === 2) {
          return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Fixed.' }) };
        }
        // Retry explains instead of mutating → verify is NOT re-run, note stands.
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Could not reproduce the failure locally.' }) };
      },
      peekTopSelection: strongExecutor,
    } as unknown as Router;

    const result = await runTurn(fakeRouter, makeOpts());
    ok('gate failed: exactly 3 router calls (no re-run after a non-mutating retry)', n === 3);
    ok('gate failed: final text carries the Verification-failed note', result.text.includes('Verification failed'));
    ok('gate failed: the note names the command', result.text.includes('`false`'));
  }

  // --- Test 4: planner seeds the todo checklist and its Verify: line drives the gate ---
  {
    setConfig({ mixturePipeline: 'on', verifyCommand: 'off' });
    const todoLists: any[][] = [];
    const steps: string[] = [];
    let n = 0;
    const plan = ''
      + 'Goal: fix the gate.\n'
      + 'Files: src/a.ts, src/b.ts\n'
      + 'Steps:\n'
      + '1. Edit src/a.ts to add the guard.\n'
      + '2. Edit src/b.ts to wire the guard in.\n'
      + 'Edge cases: none.\n'
      + 'Verify: true';
    const fakeRouter = {
      async route() {
        n++;
        if (n === 1) {
          // The planner step's (taskKind 'plan') single tool-less response.
          return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: plan }) };
        }
        if (n === 2) {
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'g4', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: 'printf edited-the-file' }) } }] }),
          };
        }
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Fixed.' }) };
      },
      peekTopSelection: strongExecutor,
    } as unknown as Router;

    const result = await runTurn(fakeRouter, makeOpts({
      onTodos: (todos) => todoLists.push(todos),
      onStep: (_p, label) => steps.push(label),
    }));
    ok('planner: exactly 3 router calls (planner + attempt tool + attempt final)', n === 3);
    ok('planner: todo checklist seeded from the plan steps', todoLists.length > 0 && todoLists[0].length === 2);
    ok('planner: first seeded todo is in_progress, rest pending', todoLists[0][0].status === 'in_progress' && todoLists[0][1].status === 'pending');
    ok('planner: Verify: line drove the command gate (overriding verifyCommand "off")', steps.some((s) => s.startsWith('Verifying with true')));
    ok('planner: gate passed, no caveats', !result.text.includes('Verification failed') && !result.text.includes('Unverified'));
  }

  // --- Test 5: verifyCommand 'off' (and no planner Verify: line) → gate skipped, badge path intact ---
  {
    setConfig({ mixturePipeline: 'off', verifyCommand: 'off' });
    const steps: string[] = [];
    let n = 0;
    const fakeRouter = {
      async route() {
        n++;
        if (n === 1) {
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'g5', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: 'printf edited-the-file' }) } }] }),
          };
        }
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Fixed.' }) };
      },
      peekTopSelection: strongExecutor,
    } as unknown as Router;

    const result = await runTurn(fakeRouter, makeOpts({ onStep: (_p, label) => steps.push(label) }));
    ok('gate off: no verifying step ran', !steps.some((s) => s.startsWith('Verifying with')));
    ok('gate off: unverified completion claim still gets the honesty badge', result.text.includes('Unverified'));
  }

  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
