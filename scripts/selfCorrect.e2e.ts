// Regression test for the Ralph-Wiggum-style self-correct retry added to src/agent/core/loop.ts:
// when a mutating tool call's own result contains formatDiagnostics.ts's NEW_DIAGNOSTICS_MARKER
// (verifyNoteFor found a fresh error right after an edit/write), runTurn() now retries exactly
// once with a "fix it now" nudge instead of silently finishing on a broken file.
//
// Drives the REAL runTurn() -> createRouterProvider() -> streamText() -> tools pipeline with a
// fake Router, using the real `runCommand` tool (via CommandGate on a real temp dir) as the
// mutating call so the loop's own tool-execution/workMessages plumbing is genuinely exercised —
// only the marker text's origin is substituted (a crafted echo instead of a real language-server
// diagnostic), since editFile's real diagnostics path needs the full VS Code text-edit API that
// doesn't exist in this headless harness. The retry-detection logic under test (scanning
// workMessages for the marker after a mutating call) doesn't care which tool produced it.
//
// Run: npm run test:e2e:self-correct
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTurn } from '../src/agent/core/loop';
import { setGates } from '../src/agent/core/tools/gates';
import { CommandGate, type CommandApproval } from '../src/edits/commandGate';
import { EditGate } from '../src/edits/applyEdit';
import { NEW_DIAGNOSTICS_MARKER } from '../src/agent/core/tools/workspace/formatDiagnostics';
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
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-selfcorrect-e2e-'));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot, path: workspaceRoot } }];

  const commandGate = new CommandGate(() => 'always' as CommandApproval, () => 5000, () => []);
  const editGate = new EditGate(() => false);
  setGates(editGate, commandGate);

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

  // --- Test 1: mutating tool call's result carries the diagnostics marker -> one bounded self-correct retry ---
  {
    const echoMarker = `printf '%s\\n%s' ${JSON.stringify(NEW_DIAGNOSTICS_MARKER)} ${JSON.stringify('broken.ts:3:1 - ERROR: unexpected token')}`;
    let routeCalls: Array<{ messages: any[] }> = [];
    let n = 0;
    const fakeRouter = {
      async route(messages: any[]) {
        routeCalls.push({ messages });
        n++;
        if (n === 1) {
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: echoMarker }) } }] }),
          };
        }
        if (n === 2) {
          // First attempt's final answer — acknowledges nothing further, no fix.
          return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Edited the file.' }) };
        }
        // Retry attempt: confirm the nudge is actually present, then "fix" it.
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Fixed the error.' }) };
      },
          // A strong executor so the mixture-pipeline planner step (loop.ts's
      // WEAK_EXECUTOR_RANK gate) doesn't fire and consume a route() call — these tests
      // count exact route() calls for the self-correct retry logic.
      peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
    } as unknown as Router;

    const result = await runTurn(fakeRouter, makeOpts());
    ok('self-correct: exactly 3 router calls (attempt tool-call + attempt final + retry final)', n === 3);
    const retryMessages = routeCalls[2].messages;
    const retryText = JSON.stringify(retryMessages);
    ok('self-correct: retry prompt includes the fix-it nudge', retryText.includes('Fix it now'));
    ok('self-correct: retry prompt still carries the original diagnostic marker in context', retryText.includes(NEW_DIAGNOSTICS_MARKER));
    ok('self-correct: final answer is the retry\'s (fixed) text, not the first attempt\'s', result.text === 'Fixed the error.');
  }

  // --- Test 2: mutating tool call with a CLEAN result -> no self-correct retry ---
  {
    let n = 0;
    const fakeRouter = {
      async route() {
        n++;
        if (n === 1) {
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'c2', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: 'printf clean-output' }) } }] }),
          };
        }
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Edited the file, all clean.' }) };
      },
          // A strong executor so the mixture-pipeline planner step (loop.ts's
      // WEAK_EXECUTOR_RANK gate) doesn't fire and consume a route() call — these tests
      // count exact route() calls for the self-correct retry logic.
      peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
    } as unknown as Router;

    const result = await runTurn(fakeRouter, makeOpts());
    ok('clean edit: exactly 2 router calls (no self-correct retry)', n === 2);
    ok('clean edit: final answer is the first attempt\'s text', result.text === 'Edited the file, all clean.');
  }

  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
