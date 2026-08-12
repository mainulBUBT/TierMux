// Regression test for the `askQuestions` tool (replaces the ???QUESTIONS??? text sentinel as
// plan mode's primary clarify channel — see clarify.ts's resolveClarifying).
//
// Verifies:
// 1. A plan-mode turn where the model calls `askQuestions` terminates in exactly one MAIN-model
//    step (the tool having no `execute` — the SDK's own "nothing to continue with" behavior for
//    a human-in-the-loop tool call — plus the askQuestionsStop safety net). Plan mode also runs a
//    SEPARATE best-effort "approaches considered" brainstorm pre-pass (runBrainstormStep) before
//    the main call — real, unrelated to this feature — so the fake router below answers that
//    call distinctly and counts it separately, rather than assuming a single call total.
// 2. The questions surface on AgentResult.askQuestions, validated/normalized (options defaults
//    to [], not undefined) — no regex/sentinel parsing involved.
// 3. workMessages contains a synthesized placeholder tool-result for the call (the orphaned-
//    tool-call risk flagged during plan review — the same invariant synth-shrink.e2e.ts guards:
//    "no tool-call survives without its result" / AI_MissingToolResultsError).
// 4. A weak model's TEXT-emitted `<function=askQuestions>{...}</function>` (no native tool call)
//    still gets rescued into a real call by rescueInlineToolCalls, since its registry is derived
//    from the live tool set, not a hardcoded list — askQuestions needs no special-casing there.
// 5. Agent mode does NOT expose `askQuestions` at all (plan-mode-only tool) — a model calling it
//    there anyway must NOT be treated as a real clarify request just because the name matches
//    (regression guard: the raw stream part reports whatever name the model invented, before
//    NoSuchToolError/repair even runs).
//
// Run: npm run test:e2e:ask-questions-flow
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

function baseResponse(overrides: Record<string, unknown>) {
  return {
    id: 'r', object: 'chat.completion' as const, created: 0, model: 'fake',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant' as const, content: null, ...overrides } }],
  };
}

// The brainstorm pre-pass (runBrainstormStep, loop.ts) uses generateObject with a system prompt
// that always contains this phrase — the simplest reliable way to recognize it in a fake router
// without depending on internal implementation details like response-format shape.
function isBrainstormCall(messages: unknown): boolean {
  const first = Array.isArray(messages) ? messages[0] : undefined;
  return typeof first?.content === 'string' && first.content.includes('genuine fork in approach');
}
function brainstormResponse() {
  return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: JSON.stringify({ hasFork: false, approaches: [] }) }) };
}

function makeOpts(mode: 'plan' | 'agent', overrides: Partial<AgentOpts> = {}): AgentOpts {
  return {
    messages: [{ role: 'user', content: 'add a new field to the User model' }],
    mode,
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

const QUESTIONS_ARGS = {
  questions: [
    { text: 'Which field should be added?', label: 'Field', options: [{ title: 'age', description: 'integer' }, { title: 'bio', description: 'text' }] },
  ],
};

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-askq-e2e-'));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot, path: workspaceRoot } }];
  setGates(new EditGate(() => false), new CommandGate(() => 'always', () => 5000, () => []));

  const peekTopSelection = () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } });

  // --- Test 1-3: native askQuestions tool call terminates in one main-model step, surfaces
  // normalized questions, and synthesizes a placeholder tool-result in workMessages. ---
  {
    let mainCalls = 0;
    const fakeRouter = {
      async route(messages: unknown) {
        if (isBrainstormCall(messages)) return brainstormResponse();
        mainCalls++;
        // Should NEVER be called a second time — the turn must terminate after the first call.
        return {
          platform: 'custom' as const, model: 'fake',
          response: baseResponse({ tool_calls: [{ id: 'aq1', type: 'function' as const, function: { name: 'askQuestions', arguments: JSON.stringify(QUESTIONS_ARGS) } }] }),
        };
      },
      peekTopSelection,
      noteToolSoftFailure() {},
    } as unknown as Router;

    const result = await runTurn(fakeRouter, makeOpts('plan'));
    ok('native call: terminates after exactly one main-model call (no hang/loop)', mainCalls === 1);
    ok('native call: result.stopReason is "askQuestions"', result.stopReason === 'askQuestions');
    ok('native call: result.askQuestions has the one question', result.askQuestions?.length === 1);
    ok('native call: question text preserved', result.askQuestions?.[0]?.text === 'Which field should be added?');
    ok('native call: options normalized (2 options present)', result.askQuestions?.[0]?.options?.length === 2);
    ok('native call: NOT paused (a resumable step-cap cutoff would be a different, wrong signal)', result.paused === false);
    const toolMsg = result.workMessages?.find((m) => m.role === 'assistant' && Array.isArray((m as any).tool_calls) && (m as any).tool_calls.some((tc: any) => tc.function?.name === 'askQuestions'));
    ok('workMessages: assistant tool_call message for askQuestions exists', !!toolMsg);
    const resultMsg = result.workMessages?.find((m) => m.role === 'tool' && (m as any).tool_call_id === 'aq1');
    ok('workMessages: synthesized placeholder tool-result exists for the orphaned call (no AI_MissingToolResultsError risk)', !!resultMsg && typeof (resultMsg as any).content === 'string' && (resultMsg as any).content.length > 0);
  }

  // --- Test 4: weak-model TEXT-emitted call still gets rescued into a real tool call. ---
  {
    let mainCalls = 0;
    const fakeRouter = {
      async route(messages: unknown) {
        if (isBrainstormCall(messages)) return brainstormResponse();
        mainCalls++;
        if (mainCalls === 1) {
          // No native tool_calls — the model emitted the dialect as plain content instead.
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ content: `<function=askQuestions>${JSON.stringify(QUESTIONS_ARGS)}</function>` }),
          };
        }
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'unreached' }) };
      },
      peekTopSelection,
      noteToolSoftFailure() {},
    } as unknown as Router;

    const result = await runTurn(fakeRouter, makeOpts('plan'));
    ok('text-rescued call: still resolves to a real askQuestions tool call (registry is live, not hardcoded)', result.stopReason === 'askQuestions');
    ok('text-rescued call: terminates after exactly one main-model call, same as a native call', mainCalls === 1);
    ok('text-rescued call: question surfaced', result.askQuestions?.[0]?.text === 'Which field should be added?');
  }

  // --- Test 5: agent mode never sees askQuestions at all — a model trying to call it there
  // must not be silently treated as a real clarify request just because the name matches. ---
  {
    let mainCalls = 0;
    const fakeRouter = {
      async route() {
        mainCalls++;
        if (mainCalls === 1) {
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'aq2', type: 'function' as const, function: { name: 'askQuestions', arguments: JSON.stringify(QUESTIONS_ARGS) } }] }),
          };
        }
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'done' }) };
      },
      async pickUtilityModel() { return undefined; },
      peekTopSelection,
      noteToolSoftFailure() {},
    } as unknown as Router;

    const result = await runTurn(fakeRouter, makeOpts('agent'));
    ok('agent mode: askQuestions is not registered — result.askQuestions stays undefined', result.askQuestions === undefined);
    ok('agent mode: no askQuestions stopReason leaked in', result.stopReason !== 'askQuestions');
  }

  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
