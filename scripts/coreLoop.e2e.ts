// Verifies the core architectural claims behind the AI-SDK-based agent core:
// 1. A denied `toolApproval` verdict means the tool's execute() never runs at all (not just
//    that its effect is later discarded) — the actual point of adopting the SDK's native
//    tool-execution gate instead of a hand-rolled permission wrapper.
// 2. The `tool-call` stream part (mapped to onTool state:'running') is processed BEFORE that
//    tool's own execute() mutates anything — chatViewProvider.ts's checkpoint recorder depends
//    on this exact ordering to snapshot pre-edit content.
// 3. An approved call only ever prompts once — guards against CommandGate/EditGate's own
//    internal approve()/previewAndConfirm() ask-flow firing again after toolApproval already
//    decided (the whole reason CommandGate.runApproved()/EditGate.*Approved() skip straight to
//    execution instead of re-running their combined ask-then-execute methods).
//
// Drives the REAL runTurn() -> createRouterProvider() -> streamText() -> tools pipeline, with
// a fake Router standing in for the actual multi-provider layer (Router.route() is the only
// seam faked — everything above it, including the AI SDK itself, is real).
//
// Run: npm run test:e2e:core
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTurn } from '../src/agent/core/loop';
import { collapseRepeatedSteps } from '../src/agent/core/collapseRepeat';
import { setGates } from '../src/agent/core/tools/gates';
import { CommandGate, type CommandApproval } from '../src/edits/commandGate';
import { EditGate } from '../src/edits/applyEdit';
import type { Router } from '../src/router/router';
import type { AgentOpts } from '../src/agent/agent';
import type { ChatMessage } from '../src/shared/types';

// Keep the planner step out of these runs: mixturePipeline 'auto' now plans for EVERY action
// task (see loop.ts), which would consume a route() call and shift the scripted sequences
// below. These tests are about tool-approval/execution ordering and retry shapes, not the
// mixture pipeline — read by the vscode mock's getConfiguration (scripts/vscodeMock.cjs).
(globalThis as any).__tiermuxTestConfig = { mixturePipeline: 'off' };

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
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-engine-e2e-'));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot, path: workspaceRoot } }];

  let currentPolicy: CommandApproval = 'always';
  const commandGate = new CommandGate(() => currentPolicy, () => 5000, () => []);
  const editGate = new EditGate(() => false);
  setGates(editGate, commandGate);

  function makeOpts(overrides: Partial<AgentOpts>): { opts: AgentOpts; toolStates: string[] } {
    const toolStates: string[] = [];
    const opts: AgentOpts = {
      messages: [{ role: 'user', content: 'run a command' }],
      mode: 'agent',
      effort: 'medium',
      onChunk: () => {},
      onTool: (e) => { toolStates.push(`${e.name}:${e.state}`); },
      onReasoning: () => {},
      onModel: () => {},
      onFailover: () => {},
      onStep: () => {},
      onTodos: () => {},
      onAskUser: async () => '',
      onError: (m) => console.error('onError:', m),
      ...overrides,
    };
    return { opts, toolStates };
  }

  // --- Test 1: denied toolApproval means execute() never runs ---
  {
    const marker = path.join(workspaceRoot, 'denied-marker.txt');
    let routeCalls = 0;
    const fakeRouter = {
      async route() {
        routeCalls++;
        if (routeCalls === 1) {
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: `touch ${JSON.stringify(marker)}` }) } }] }),
          };
        }
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'done' }) };
      },
      // A strong executor (low intelligenceRank); the mixture pipeline is disabled globally at
      // the top of this file so the planner step never consumes a route() call — these tests
      // are about tool-approval/execution ordering, not the mixture pipeline.
      peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
    } as unknown as Router;

    const { opts } = makeOpts({ onPermissionAsk: async () => 'reject' });
    const result = await runTurn(fakeRouter, opts);
    ok('denied call: marker file NOT created (execute() never ran)', !fs.existsSync(marker));
    ok('denied call: run still completed to a final answer', result.text.startsWith('done'));
  }

  // --- Test 2: onTool("running") fires before the tool's own execute() mutates anything ---
  {
    const marker = path.join(workspaceRoot, 'ordering-marker.txt');
    let routeCalls = 0;
    const fakeRouter = {
      async route() {
        routeCalls++;
        if (routeCalls === 1) {
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'c2', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: `touch ${JSON.stringify(marker)}` }) } }] }),
          };
        }
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'done' }) };
      },
      // A strong executor (low intelligenceRank); the mixture pipeline is disabled globally at
      // the top of this file so the planner step never consumes a route() call — these tests
      // are about tool-approval/execution ordering, not the mixture pipeline.
      peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
    } as unknown as Router;

    let markerExistedAtRunningState: boolean | undefined;
    const { opts } = makeOpts({
      onPermissionAsk: async () => 'once',
      onTool: (e) => {
        if (e.name === 'runCommand' && e.state === 'running' && markerExistedAtRunningState === undefined) {
          markerExistedAtRunningState = fs.existsSync(marker);
        }
      },
    });
    const result = await runTurn(fakeRouter, opts);
    ok('ordering: marker did NOT exist yet when onTool state=running fired', markerExistedAtRunningState === false);
    ok('ordering: marker DOES exist after the run completes (command actually ran)', fs.existsSync(marker));
    ok('ordering: run completed to a final answer', result.text.startsWith('done'));
  }

  // --- Test 3: an approved call prompts for permission EXACTLY once ---
  // Regression guard for the CommandGate/EditGate decide/execute split: toolApproval asks and
  // approves, then the tool calls CommandGate.runApproved()/EditGate.*Approved() — if those ever
  // regressed back to calling the combined approve()-then-execute methods, the user would be
  // asked twice for the same call.
  {
    const marker = path.join(workspaceRoot, 'once-marker.txt');
    let routeCalls = 0;
    const fakeRouter = {
      async route() {
        routeCalls++;
        if (routeCalls === 1) {
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'c3', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: `touch ${JSON.stringify(marker)}` }) } }] }),
          };
        }
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'done' }) };
      },
      // A strong executor (low intelligenceRank); the mixture pipeline is disabled globally at
      // the top of this file so the planner step never consumes a route() call — these tests
      // are about tool-approval/execution ordering, not the mixture pipeline.
      peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
    } as unknown as Router;

    let permissionAskCalls = 0;
    const { opts } = makeOpts({
      onPermissionAsk: async () => { permissionAskCalls++; return 'once'; },
    });
    const result = await runTurn(fakeRouter, opts);
    ok('approval-once: onPermissionAsk fired exactly once for one approved tool call', permissionAskCalls === 1);
    ok('approval-once: the approved command actually ran', fs.existsSync(marker));
    ok('approval-once: run completed to a final answer', result.text.startsWith('done'));
  }

  // Tests 4-6 (announced-action continuation, forced multi-step continuation, pasted-code
  // conversion) were removed with the 2026-08-24 judgment-tower reset — they locked the
  // force-action retry machinery the simple execution core deletes by design. The mechanical
  // approval/ordering contract above is the evergreen part of this suite; the new fundamental
  // execution contract lives in scripts/simpleTurn.e2e.ts.

  // --- Test 4: a model re-issuing the IDENTICAL tool call is stopped as stuck ---
  // 2026-08-25 live repro: a degenerate loop ran the same grep ~50 times (280k in / 41.5k out)
  // before the step cap noticed. The stuck stop must fire after the 3rd identical call (ids
  // differ each time — detection is on name+arguments, not ids), and the persisted transcript
  // must collapse the repeats to first + marker + last instead of three full records.
  {
    let routeCalls = 0;
    const fakeRouter = {
      async route() {
        routeCalls++;
        return {
          platform: 'custom' as const, model: 'fake',
          response: baseResponse({ tool_calls: [{ id: `c4-${routeCalls}`, type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: 'echo hi' }) } }] }),
        };
      },
      peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
    } as unknown as Router;

    const { opts } = makeOpts({ onPermissionAsk: async () => 'once' });
    const result = await runTurn(fakeRouter, opts);
    ok('stuck: stopped with stopReason "stuck" on identical repeated calls', result.stopReason === 'stuck');
    ok('stuck: NOT a resumable pause (continuing would just resume the loop)', result.paused !== true);
    ok('stuck: exactly 3 model calls (stop fired after the 3rd identical call)', routeCalls === 3);
    ok('stuck: honest stop message instead of a blank turn', result.text.includes('same tool call'));
    const markerMsgs = (result.workMessages ?? []).filter((m) => typeof m.content === 'string' && m.content.includes('repeated 1 more time'));
    const toolMsgs = (result.workMessages ?? []).filter((m) => m.role === 'tool');
    ok('stuck: transcript collapsed the 3 repeats to first + marker + last (2 records, 1 marker)', markerMsgs.length === 1 && toolMsgs.length === 2);
    const lastWork = (result.workMessages ?? [])[(result.workMessages ?? []).length - 1];
    ok('stuck: transcript ends with a turn-boundary closer (next message reads as a NEW instruction)',
      !!lastWork && lastWork.role === 'assistant' && typeof lastWork.content === 'string' && lastWork.content.includes('[Turn stopped'));
  }

  // --- Test 5: the step cap produces a resumable PAUSE ---
  // Guards the revived paused flag: the old `finishReason === 'max-steps'` check was dead code
  // on ai@7 ('max-steps' is never a FinishReason the SDK emits), so a capped turn silently
  // finalized as a normal stop. Distinct arguments each call so the stuck detector stays out.
  {
    (globalThis as any).__tiermuxTestConfig.maxStepsPerTurn = 3;
    let routeCalls = 0;
    const fakeRouter = {
      async route() {
        routeCalls++;
        return {
          platform: 'custom' as const, model: 'fake',
          response: baseResponse({ tool_calls: [{ id: `c5-${routeCalls}`, type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: `echo step-${routeCalls}` }) } }] }),
        };
      },
      peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
    } as unknown as Router;

    try {
      const { opts } = makeOpts({ onPermissionAsk: async () => 'once' });
      const result = await runTurn(fakeRouter, opts);
      ok('step-cap: turn is a resumable pause', result.paused === true);
      ok('step-cap: no guardrail stopReason (it is a cutoff, not pathology)', result.stopReason === undefined);
      ok('step-cap: exactly 3 model calls (cap fired, no 4th)', routeCalls === 3);
      const lastWork = (result.workMessages ?? [])[(result.workMessages ?? []).length - 1];
      ok('step-cap: transcript ends with a turn-boundary closer',
        !!lastWork && lastWork.role === 'assistant' && typeof lastWork.content === 'string' && lastWork.content.includes('[Turn paused'));
    } finally {
      delete (globalThis as any).__tiermuxTestConfig.maxStepsPerTurn;
    }
  }

  // --- Test 6: collapseRepeatedSteps (unit) ---
  {
    const rec = (id: string, args: string): ChatMessage[] => [
      { role: 'assistant', content: null, tool_calls: [{ id, type: 'function' as const, function: { name: 'grep', arguments: args } }] },
      { role: 'tool', content: 'x'.repeat(500), tool_call_id: id },
    ];
    const ARGS = JSON.stringify({ pattern: 'country' });
    const runOf5 = [
      { role: 'user' as const, content: 'find it' },
      ...rec('a1', ARGS), ...rec('a2', ARGS), ...rec('a3', ARGS), ...rec('a4', ARGS), ...rec('a5', ARGS),
      { role: 'assistant' as const, content: 'done' },
    ];
    const collapsed = collapseRepeatedSteps(runOf5);
    const ids = (msgs: ChatMessage[]) => msgs.flatMap((m) => (m.tool_calls ?? []).map((tc) => tc.id)).concat(msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id ?? ''));
    ok('collapse: 5 identical records → 7 messages (first + marker + last kept, middle gone)', collapsed.length === 7);
    ok('collapse: first and last repeat survive', ['a1', 'a5'].every((id) => ids(collapsed).includes(id)));
    ok('collapse: middle repeats dropped', ['a2', 'a3', 'a4'].every((id) => !ids(collapsed).includes(id)));
    ok('collapse: marker counts the omitted middle', collapsed.some((m) => typeof m.content === 'string' && m.content.includes('repeated 3 more time(s)')));
    ok('collapse: non-record messages preserved', collapsed[0].role === 'user' && collapsed[collapsed.length - 1].role === 'assistant');

    const runOf2 = [...rec('b1', ARGS), ...rec('b2', ARGS)];
    ok('collapse: a pair of repeats is kept verbatim (3+ is the threshold)', collapseRepeatedSteps(runOf2).length === 4);

    const different = [...rec('c1', ARGS), ...rec('c2', JSON.stringify({ pattern: 'phone' }))];
    ok('collapse: same tool but different arguments is NOT collapsed', collapseRepeatedSteps(different).length === 4);
  }

  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
