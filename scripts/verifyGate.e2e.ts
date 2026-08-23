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
//  5b. verifyCommand 'off' but a VERIFY_TOOLS call followed the mutation → 'changes-only'
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
    ok('gate pass: no Verification-failed note', result.workReport?.verifyOutcome !== 'failed' && !result.text.includes('Verification failed'));
    ok('gate pass: observed pass satisfies the honesty backstop (no Unverified badge)', result.workReport?.verifyOutcome === 'verified');
    ok('report: ✅ Verified outcome names the command', result.workReport?.verifyOutcome === 'verified' && result.workReport?.verifyCmd === 'true');
    ok('report: structured WorkReportData present (version 1)', result.workReport?.version === 1);
    ok('report: tool tally present with counts', (result.workReport?.toolTally ?? []).some((t) => t.name === 'runCommand' && t.count === 1));
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
    ok('gate retry: a mutating retry gets re-checked and a pass clears the failure', result.workReport?.verifyOutcome === 'verified');
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
    ok('gate failed: the turn reports verifyOutcome=failed', result.workReport?.verifyOutcome === 'failed');
    ok('report: ❌ Verification-failed carries fixRounds from the gate',
      result.workReport?.verifyOutcome === 'failed' && result.workReport!.fixRounds >= 1);
    ok('gate failed: the report names the command', result.workReport?.verifyCmd === 'false');
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
    ok('planner: gate passed, no caveats', result.workReport?.verifyOutcome === 'verified');
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
    ok('gate off: untested mutating turn still reports unverified', result.workReport?.verifyOutcome === 'unverified');
    ok('report: ⚠️ Unverified fires for EVERY untested mutating turn (not just claim-regex hits)',
      result.workReport?.verifyOutcome === 'unverified' && !result.workReport?.verifyCmd);
  }

  // --- Test 5b: gate off, but the AGENT verified its own work → 'changes-only', not 'unverified' ---
  // The distinction the gate alone can't make: no verify command exists, yet a VERIFY_TOOLS call
  // landed after the last mutation, so the changes WERE exercised. Claiming 'verified' would name
  // a command that never ran; claiming 'unverified' would scare the user about work that was
  // actually checked.
  {
    setConfig({ mixturePipeline: 'off', verifyCommand: 'off' });
    let n = 0;
    const fakeRouter = {
      async route() {
        n++;
        if (n === 1) {
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'g5b1', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: 'printf edited-the-file' }) } }] }),
          };
        }
        if (n === 2) {
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'g5b2', type: 'function' as const, function: { name: 'getDiagnostics', arguments: '{}' } }] }),
          };
        }
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Done.' }) };
      },
      peekTopSelection: strongExecutor,
    } as unknown as Router;

    const result = await runTurn(fakeRouter, makeOpts());
    ok('self-verified: outcome is changes-only, not the scary unverified copy',
      result.workReport?.verifyOutcome === 'changes-only', `outcome=${result.workReport?.verifyOutcome}`);
    ok('self-verified: no command is named (none ran)', !result.workReport?.verifyCmd);
  }

  // --- Test 6: verifyFixRounds=2 (default) — a second fix round runs when the first keeps failing ---
  {
    const marker = path.join(workspaceRoot, 'gate-round2-marker.txt');
    const verifyCmd = `test -f ${JSON.stringify(marker)}`;
    setConfig({ mixturePipeline: 'off', verifyCommand: verifyCmd });
    const steps: string[] = [];
    const routeOpts: any[] = [];
    const cmd = (id: string, c: string) => baseResponse({ tool_calls: [{ id, type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: c }) } }] });
    const script = [
      cmd('r1', 'printf first-edit'),          // initial turn mutation
      baseResponse({ content: 'Done for now.' }),
      cmd('r2', 'printf second-edit'),         // fix round 1 mutates, verify still fails
      baseResponse({ content: 'Adjusted.' }),
      cmd('r3', `touch ${JSON.stringify(marker)}`), // fix round 2 makes it pass
      baseResponse({ content: 'Now it passes.' }),
    ];
    let n = 0;
    const fakeRouter = {
      async route(_m: unknown, opts: unknown) {
        routeOpts.push(opts ?? {});
        n++;
        return { platform: 'custom' as const, model: 'fake', response: script.shift() ?? baseResponse({ content: 'done.' }) };
      },
      peekTopSelection: strongExecutor,
    } as unknown as Router;

    const result = await runTurn(fakeRouter, makeOpts({ onStep: (_p, label) => steps.push(label) }));
    ok('rounds: second fix round ran and the gate finally passed', result.verifyOutcome === 'passed', `n=${n}`);
    ok('rounds: exactly the scripted 6 model calls', n === 6, `n=${n}`);
    ok('rounds: the command was re-run after each mutating fix attempt', steps.filter((s) => s.startsWith('Re-running')).length === 2);
    ok('rounds: no Verification-failed outcome on the final pass', result.workReport?.verifyOutcome === 'verified');
    // THE invariant: verify failure must never become a model escalation.
    ok('rounds: no fix-round call ever excluded or re-ranked models',
      routeOpts.every((o) => !o.excludeModels?.length && o.maxIntelligenceRank === undefined && o.minIntelligenceRank === undefined));
  }

  // --- Test 7: verify still failing after ALL rounds + pending todos → read-only plan repair ---
  {
    setConfig({ mixturePipeline: 'off', verifyCommand: 'false' });
    const cmd = (id: string, c: string) => baseResponse({ tool_calls: [{ id, type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: c }) } }] });
    const todoW = baseResponse({ tool_calls: [{ id: 'tw', type: 'function' as const, function: { name: 'todowrite', arguments: JSON.stringify({ todos: [
      { content: 'Edit src/a.ts', status: 'completed' },
      { content: 'Fix the flaky teardown', status: 'pending' },
    ] }) } }] });
    const script = [
      todoW,
      cmd('p1', 'printf edit-one'),
      baseResponse({ content: 'First attempt done.' }),
      cmd('p2', 'printf edit-two'),            // fix round 1
      baseResponse({ content: 'Adjusted.' }),
      cmd('p3', 'printf edit-three'),          // fix round 2
      baseResponse({ content: 'Third try.' }),
      // The read-only planner repair call — served as structured-output JSON.
      baseResponse({ content: JSON.stringify({ steps: ['Replace the teardown with an afterAll in src/a.ts'] }) }),
    ];
    let n = 0;
    const todoLists: any[] = [];
    const fakeRouter = {
      async route() {
        n++;
        return { platform: 'custom' as const, model: 'fake', response: script.shift() ?? baseResponse({ content: 'done.' }) };
      },
      peekTopSelection: strongExecutor,
    } as unknown as Router;

    const result = await runTurn(fakeRouter, makeOpts({ onTodos: (t) => todoLists.push(t) }));
    ok('repair: gate ended failed after both fix rounds', result.verifyOutcome === 'failed', `outcome=${result.verifyOutcome}`);
    ok('repair: the deterministic failed verdict is reported', result.workReport?.verifyOutcome === 'failed');
    ok('repair: the plan-repair note is present', result.text.includes('Plan repaired'), result.text.slice(-160));
    ok('repair: the planner rewrote the pending step on the live checklist',
      todoLists.length > 0
      && todoLists[todoLists.length - 1].some((t: any) => t.content === 'Replace the teardown with an afterAll in src/a.ts' && t.status === 'pending'));
    ok('repair: the completed step survived the rewrite',
      todoLists[todoLists.length - 1].some((t: any) => t.content === 'Edit src/a.ts' && t.status === 'completed'));
    ok('repair: exactly the scripted calls (work + 2 fix rounds + 1 planner pass)', n === 8, `n=${n}`);
  }

  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
