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
      // A strong executor (low intelligenceRank) so the mixture-pipeline planner step
      // (loop.ts's WEAK_EXECUTOR_RANK gate) doesn't fire and consume a route() call — these
      // tests are about tool-approval/execution ordering, not the mixture pipeline.
      peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
    } as unknown as Router;

    const { opts } = makeOpts({ onPermissionAsk: async () => 'reject' });
    const result = await runTurn(fakeRouter, opts);
    ok('denied call: marker file NOT created (execute() never ran)', !fs.existsSync(marker));
    ok('denied call: run still completed to a final answer', result.text === 'done');
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
      // A strong executor (low intelligenceRank) so the mixture-pipeline planner step
      // (loop.ts's WEAK_EXECUTOR_RANK gate) doesn't fire and consume a route() call — these
      // tests are about tool-approval/execution ordering, not the mixture pipeline.
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
    ok('ordering: run completed to a final answer', result.text === 'done');
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
      // A strong executor (low intelligenceRank) so the mixture-pipeline planner step
      // (loop.ts's WEAK_EXECUTOR_RANK gate) doesn't fire and consume a route() call — these
      // tests are about tool-approval/execution ordering, not the mixture pipeline.
      peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
    } as unknown as Router;

    let permissionAskCalls = 0;
    const { opts } = makeOpts({
      onPermissionAsk: async () => { permissionAskCalls++; return 'once'; },
    });
    const result = await runTurn(fakeRouter, opts);
    ok('approval-once: onPermissionAsk fired exactly once for one approved tool call', permissionAskCalls === 1);
    ok('approval-once: the approved command actually ran', fs.existsSync(marker));
    ok('approval-once: run completed to a final answer', result.text === 'done');
  }

  // --- Test 4: announced-but-undone action AFTER tools already ran is continued ---
  // Regression for the 2026-08-13 symptom: a runCommand landed (real work), then the model ended
  // the turn on "Let me check the workspace structure first." with NO follow-up tool call. The
  // force-action retry was gated on `!first.hadToolCalls`, so this sailed through untouched and the
  // announcement became the final answer — the agent stopped mid-plan. The continuation path now
  // detects the announced-but-undone tail even after prior tool calls and nudges the model to
  // actually perform it.
  {
    const workMarker = path.join(workspaceRoot, 'work-marker.txt');
    const announcedMarker = path.join(workspaceRoot, 'announced-marker.txt');
    let routeCalls = 0;
    const fakeRouter = {
      async route() {
        routeCalls++;
        if (routeCalls === 1) {
          // Step 1 of the first attempt: real work (a runCommand that lands).
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'c4a', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: `touch ${JSON.stringify(workMarker)}` }) } }] }),
          };
        }
        if (routeCalls === 2) {
          // Step 2: ends on an announced action, no tool call — the bug shape.
          return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'The path might be different. Let me check the workspace structure first.' }) };
        }
        if (routeCalls === 3) {
          // The continuation attempt (only reached WITH the fix): perform the announced action.
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'c4b', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: `touch ${JSON.stringify(announcedMarker)}` }) } }] }),
          };
        }
        // Step 4: final answer.
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'done' }) };
      },
      // Strong executor so the mixture-pipeline planner step doesn't consume a route() call.
      peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
      noteToolSoftFailure: () => {},
    } as unknown as Router;

    const { opts } = makeOpts({ messages: [{ role: 'user', content: 'run a command' }] });
    const result = await runTurn(fakeRouter, opts);
    ok('announce-after-work: the initial real work ran', fs.existsSync(workMarker));
    ok('announce-after-work: the announced next action WAS performed (continuation fired)', fs.existsSync(announcedMarker));
    ok('announce-after-work: run completed to a final answer', result.text === 'done');
  }

  // --- Test 5: full agent-mode run through the continuation (multi-step, verified, synthesized) ---
  // Test 4 proves the announced action gets performed. This proves the continuation is a FULL
  // runAttempt — after the nudge the model can run several more real steps (the fix + a verify),
  // then synthesize a real answer, all in agent mode. Without the fix, the turn dies at route
  // call 2 on the announcement and none of fix/verify/answer ever happen.
  {
    const markers = {
      read: path.join(workspaceRoot, 'step-read.txt'),
      fix: path.join(workspaceRoot, 'step-fix.txt'),
      verify: path.join(workspaceRoot, 'step-verify.txt'),
    };
    let routeCalls = 0;
    const fakeRouter = {
      async route() {
        routeCalls++;
        // First attempt — step 1: a real read (work happens), step 2: announce-and-stop.
        if (routeCalls === 1) {
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'c5a', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: `touch ${JSON.stringify(markers.read)}` }) } }] }),
          };
        }
        if (routeCalls === 2) {
          return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'I see the typo. Let me fix it and verify the change.' }) };
        }
        // Continuation attempt — a full multi-step tool loop: fix → verify → final answer.
        if (routeCalls === 3) {
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'c5b', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: `touch ${JSON.stringify(markers.fix)}` }) } }] }),
          };
        }
        if (routeCalls === 4) {
          // Verify step (runCommand is in VERIFY_TOOLS) after the mutating fix.
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'c5c', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: `touch ${JSON.stringify(markers.verify)}` }) } }] }),
          };
        }
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Fixed: changed "Helo" to "Hello" and verified.' }) };
      },
      peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
      noteToolSoftFailure: () => {},
    } as unknown as Router;

    const { opts } = makeOpts({ messages: [{ role: 'user', content: 'fix the typo in greeting.txt and verify it' }] });
    const result = await runTurn(fakeRouter, opts);
    ok('full-agent: initial read ran (pre-announcement work)', fs.existsSync(markers.read));
    ok('full-agent: the announced fix WAS applied (continuation started)', fs.existsSync(markers.fix));
    ok('full-agent: the verify step ran too (continuation is multi-step, not one call)', fs.existsSync(markers.verify));
    ok('full-agent: turn synthesized a real final answer', result.text === 'Fixed: changed "Helo" to "Hello" and verified.');
    ok('full-agent: work transcript carries the continuation\'s tool calls', (result.workMessages ?? []).some((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.length > 0));
  }

  // --- Test 6: "pasted code instead of creating the file" AFTER reads ---
  // Regression for the user-reported 2026-08-14 symptom: the model read the project (so hadToolCalls
  // is true), then answered by PASTING the implementation as a fenced code block instead of calling
  // createFile — no file changed. The zero-tool force-action path was gated on !hadToolCalls, and
  // announcedAfterWork only matches an action-INTENT tail, so this exact shape slipped through both
  // and the agent "just responded in text". The pastedCodeAfterReads path now catches it.
  {
    const createdMarker = path.join(workspaceRoot, 'pasted-after-reads.txt');
    let routeCalls = 0;
    const fakeRouter = {
      async route() {
        routeCalls++;
        if (routeCalls === 1) {
          // Step 1: a real NON-MUTATING read (hadToolCalls becomes true, but hadMutatingToolCall stays false).
          // grep is a read-only tool (not in MUTATING_TOOLS), unlike runCommand.
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'c6a', type: 'function' as const, function: { name: 'grep', arguments: JSON.stringify({ pattern: 'test', path: workspaceRoot }) } }] }),
          };
        }
        if (routeCalls === 2) {
          // Step 2: ends by PASTING the code as a fenced block — the bug shape. No tool call.
          return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: "Here's the implementation:\n```php\n<?php echo 'hi';\n```\nDone." }) };
        }
        if (routeCalls === 3) {
          // The continuation (only reached WITH the fix): actually create the file.
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'c6b', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: `touch ${JSON.stringify(createdMarker)}` }) } }] }),
          };
        }
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Created the file.' }) };
      },
      peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
      noteToolSoftFailure: () => {},
    } as unknown as Router;

    const { opts } = makeOpts({ messages: [{ role: 'user', content: 'create a landing page file' }] });
    const result = await runTurn(fakeRouter, opts);
    ok('pasted-after-reads: the file WAS created (continuation converted the pasted block into a real tool call)', fs.existsSync(createdMarker));
    ok('pasted-after-reads: run reached a final answer', !!result.text.trim());
  }

  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
