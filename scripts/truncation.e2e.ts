// Verifies the length-truncation fix: a turn cut off mid-answer (finish_reason: 'length') must
// (a) be detected now that the AI-SDK bridge propagates the real finish_reason instead of
// hardcoding 'stop', and (b) AUTO-CONTINUE — re-prompting the same model and stitching the
// continuation onto the partial so the user sees the FULL answer. Also checks the no-truncation
// case (no spurious continuation) and the cap (a model stuck returning 'length' stops after 4
// continuations with a visible notice).
//
// Like coreLoop.e2e.ts, this drives the REAL runTurn() -> createRouterProvider() -> streamText()
// pipeline with a fake Router (Router.route() is the only seam faked). The fake returns assembled
// non-streaming responses, so the bridge's post-stream fold path (chunkCount===0 → emit full
// content + the real finish_reason) is what fires — exactly the path a length-truncated reply
// takes in production.
//
// Run: npx esbuild scripts/truncation.e2e.ts --bundle --platform=node --format=cjs --external:vscode --external:@vscode/ripgrep --outfile=dist/truncation.e2e.cjs && node -r ./scripts/vscodeMock.cjs dist/truncation.e2e.cjs
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTurn } from '../src/agent/core/loop';
import { setGates } from '../src/agent/core/tools/gates';
import { CommandGate } from '../src/edits/commandGate';
import { EditGate } from '../src/edits/applyEdit';
import type { Router } from '../src/router/router';
import type { AgentOpts } from '../src/agent/agent';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

function resp(content: string, finish: string) {
  return {
    platform: 'custom' as const,
    model: 'fake',
    response: {
      id: 'r', object: 'chat.completion' as const, created: 0, model: 'fake',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant' as const, content } }],
    },
  };
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-trunc-e2e-'));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot, path: workspaceRoot } }];

  const commandGate = new CommandGate(() => 'always', () => 5000, () => []);
  const editGate = new EditGate(() => false);
  setGates(editGate, commandGate);

  function makeOpts(): AgentOpts {
    return {
      messages: [{ role: 'user', content: 'write a long plan' }],
      mode: 'ask',
      effort: 'medium',
      onChunk: () => {},
      onTool: () => {},
      onReasoning: () => {},
      onModel: () => {},
      onFailover: () => {},
      onStep: () => {},
      onTodos: () => {},
      onAskUser: async () => '',
      onPermissionAsk: async () => 'reject',
      onError: (m) => console.error('onError:', m),
    };
  }

  // --- Test 1: finish_reason 'length' auto-continues and stitches the full answer ---
  {
    let routeCalls = 0;
    const fakeRouter = {
      async route() {
        routeCalls++;
        // First call (the main turn): truncated mid-answer. Second call (the continuation): completes.
        return routeCalls === 1 ? resp('PART1-', 'length') : resp('PART2', 'stop');
      },
    } as unknown as Router;

    const result = await runTurn(fakeRouter, makeOpts());
    ok('length: route called twice (initial + 1 continuation)', routeCalls === 2);
    ok('length: partial + continuation stitched into the full answer', result.text === 'PART1-PART2');
    ok('length: no truncation notice when it completed on continuation', !/truncated/i.test(result.text));
  }

  // --- Test 2: finish_reason 'stop' does NOT trigger a spurious continuation ---
  {
    let routeCalls = 0;
    const fakeRouter = {
      async route() { routeCalls++; return resp('the whole answer', 'stop'); },
    } as unknown as Router;

    const result = await runTurn(fakeRouter, makeOpts());
    ok('stop: route called exactly once (no continuation)', routeCalls === 1);
    ok('stop: answer returned untouched', result.text === 'the whole answer');
  }

  // --- Test 3: a model stuck returning 'length' caps at 4 continuations + visible notice ---
  {
    let routeCalls = 0;
    const fakeRouter = {
      async route() { routeCalls++; return resp('x', 'length'); }, // never finishes
    } as unknown as Router;

    const result = await runTurn(fakeRouter, makeOpts());
    ok('cap: route called exactly 5 times (1 initial + 4 continuations, then stop)', routeCalls === 5);
    ok('cap: all continuations stitched (xxxxx)', /x{5}/.test(result.text));
    ok('cap: visible "still truncated" notice surfaced after hitting the cap', /still truncated/i.test(result.text));
  }

  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
