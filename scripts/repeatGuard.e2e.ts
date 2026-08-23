// Stress test for the loop-control changes in src/agent/core/loop.ts:
//
// 1. stuckStop now counts a CONSECUTIVE run of identical calls (trailing run), not the
//    whole-turn total — a long edit→verify cycle (same test command after every edit) must
//    NOT be killed as "stuck" anymore. This was the false-positive that halted legitimate
//    long multi-file tasks.
// 2. An escalating reminder (repeatReminder) is injected as a user message the moment the same
//    exact call lands twice in a row — one full step BEFORE the ×3 hard stop, so the model can
//    change course (dsh's repeat-tool-reminder pattern).
// 3. A genuine ×3 consecutive loop still hard-stops with stopReason 'stuck'.
// 4. Bookkeeping calls (todowrite) neither count NOR break the run — a todowrite interleaved
//    between identical calls cannot launder the loop.
// 5. A budget stop (stopReason 'budget') now produces a HANDOFF synthesis (done / remaining /
//    next step) instead of a "final answer" — the handoff instruction must reach the model.
//
// Drives the REAL runTurn() -> createRouterProvider() -> streamText() -> stopWhen/prepareStep
// pipeline with a fake Router (only Router.route() is faked — same pattern as coreLoop.e2e.ts).
//
// Run: npm run test:e2e:repeat-guard
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTurn } from '../src/agent/core/loop';
import { setGates } from '../src/agent/core/tools/gates';
import { CommandGate } from '../src/edits/commandGate';
import { EditGate } from '../src/edits/applyEdit';
import type { Router } from '../src/router/router';
import type { AgentOpts } from '../src/agent/agent';

// Keep the planner out (same as coreLoop.e2e.ts) so scripted route() indexes are the model loop's.
(globalThis as any).__tiermuxTestConfig = { mixturePipeline: 'off' };

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

function baseResponse(overrides: Record<string, unknown>, usageTotal = 0) {
  return {
    id: 'r', object: 'chat.completion' as const, created: 0, model: 'fake',
    // routerProvider maps prompt_tokens/completion_tokens (not total_tokens) into the SDK's
    // usage — put the whole budget on prompt_tokens so step.usage reaches the stop conditions.
    usage: { prompt_tokens: usageTotal, completion_tokens: 0, total_tokens: usageTotal },
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant' as const, content: null, ...overrides } }],
  };
}

const tc = (id: string, name: string, args: unknown) => ({
  id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) },
});

/** Fake Router: returns scripted OpenAI-wire responses by call index and captures every
 *  call's message array (so injected harness messages — the repeat reminder, the budget
 *  handoff — are observable). Calls past the script repeat the last scripted response. */
interface Cap { n: number; messages: Array<any[]>; }
function scriptedRouter(script: Array<{ msg?: Record<string, unknown>; usageTotal?: number }>, cap: Cap) {
  return {
    async route(messages: any[]) {
      const idx = cap.n++;
      cap.messages[idx] = messages;
      const s = script[Math.min(idx, script.length - 1)];
      return { platform: 'custom' as const, model: 'fake', response: baseResponse(s.msg ?? { content: 'fallback' }, s.usageTotal ?? 0) };
    },
    // Strong executor stub (same as coreLoop.e2e.ts): no planner, no weak-model scaffling shifts.
    peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
    // The narration-wall retry paths call this on the router (learn-by-failure); a no-op keeps
    // the stub viable for the nudge scenarios below.
    noteToolSoftFailure: () => {},
  } as unknown as Router;
}

/** All human-readable text of one captured message array (string contents only). */
function textOf(msgs: any[] | undefined): string {
  if (!msgs) return '';
  return msgs.map((m) => (typeof m?.content === 'string' ? m.content : '')).join('\n');
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-repeatguard-'));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot, path: workspaceRoot } }];

  const commandGate = new CommandGate(() => 'always' as const, () => 5000, () => []);
  const editGate = new EditGate(() => false);
  setGates(editGate, commandGate);

  function makeOpts(overrides: Partial<AgentOpts> = {}): AgentOpts {
    const opts: AgentOpts = {
      messages: [{ role: 'user', content: 'run a command' }],
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
    return opts;
  }

  // ── Scenario 1: long edit→verify cycle — same verify command ×3 across the turn, never
  // back-to-back. OLD whole-turn-total counter stopped this as 'stuck'; the consecutive-run
  // counter must let it run to completion.
  {
    const cap: Cap = { n: 0, messages: [] };
    const router = scriptedRouter([
      { msg: { tool_calls: [tc('s1a', 'runCommand', { command: 'echo edit-a' })] } },
      { msg: { tool_calls: [tc('s1t1', 'runCommand', { command: 'echo verify' })] } },
      { msg: { tool_calls: [tc('s1b', 'runCommand', { command: 'echo edit-b' })] } },
      { msg: { tool_calls: [tc('s1t2', 'runCommand', { command: 'echo verify' })] } },
      { msg: { tool_calls: [tc('s1c', 'runCommand', { command: 'echo edit-c' })] } },
      { msg: { tool_calls: [tc('s1t3', 'runCommand', { command: 'echo verify' })] } },
      { msg: { content: 'cycle-done' } },
    ], cap);
    const result = await runTurn(router, makeOpts());
    ok('S1 edit→verify cycle: NOT stopped as stuck (stopReason undefined)', result.stopReason === undefined);
    ok('S1 edit→verify cycle: completed to the scripted final answer', result.text.startsWith('cycle-done'));
    ok('S1 edit→verify cycle: no repeat reminder was needed (none injected)', !cap.messages.some((m) => textOf(m).includes('times in a row')));
  }

  // ── Scenario 2: genuine ×3 consecutive identical calls → hard stop 'stuck', with the
  // escalating reminder having been injected BEFORE the third call (one step of warning).
  {
    const cap: Cap = { n: 0, messages: [] };
    const echoX = () => ({ msg: { tool_calls: [tc(`s2-${Math.random()}`, 'runCommand', { command: 'echo x' })] } });
    const router = scriptedRouter([
      echoX(), echoX(), echoX(), echoX(), echoX(),
      { msg: { content: 'STUCK-SUMMARY' } }, // the forced synthesis call after the stop
    ], cap);
    const result = await runTurn(router, makeOpts());
    ok('S2 ×5 consecutive identical: stopReason === stuck', result.stopReason === 'stuck');
    ok('S2 ×5 consecutive identical: turn ended with the stuck progress report', result.text.startsWith('STUCK-SUMMARY'));
    ok('S2 reminder fired before the 4th call (run reached 3)', textOf(cap.messages[3]).includes('times in a row'));
    ok('S2 ×2 and ×3 consecutive did NOT stop the turn (thresholds tolerate legit re-reads)', result.stopReason === 'stuck');
    ok('S2 reminder was NOT present before the 3rd call (×2 is legitimate work)', !textOf(cap.messages[2]).includes('times in a row'));
  }

  // ── Scenario 3: reminder recovery — same call twice, then the model heeds the reminder and
  // does something else. Must NOT stop, and the reminder fires exactly once.
  {
    const cap: Cap = { n: 0, messages: [] };
    const echoY = () => ({ msg: { tool_calls: [tc(`s3-${Math.random()}`, 'runCommand', { command: 'echo y' })] } });
    const router = scriptedRouter([
      echoY(), echoY(), echoY(),
      { msg: { content: 'RECOVERED' } },
    ], cap);
    const result = await runTurn(router, makeOpts());
    ok('S3 reminder recovery: NOT stopped (stopReason undefined)', result.stopReason === undefined);
    ok('S3 reminder recovery: completed to the scripted final answer', result.text.startsWith('RECOVERED'));
    ok('S3 reminder reached the model after the 3rd identical call (×3 band)', textOf(cap.messages[3]).includes('times in a row'));
    const reminderCalls = cap.messages.filter((m) => textOf(m).includes('times in a row')).length;
    ok('S3 reminder fires exactly once per key', reminderCalls === 1);
  }

  // ── Scenario 4: bookkeeping (todowrite) interleaved between identical calls must NOT
  // launder the loop — the run still counts across it and ×3 still stops.
  {
    const cap: Cap = { n: 0, messages: [] };
    const todos = { todos: ['step one'] };
    const echoZ = (id: string) => ({ msg: { tool_calls: [tc(id, 'runCommand', { command: 'echo z' })] } });
    const w = (id: string) => ({ msg: { tool_calls: [tc(id, 'todowrite', todos)] } });
    const router = scriptedRouter([
      echoZ('s4a'), w('s4w1'),
      echoZ('s4b'), w('s4w2'),
      echoZ('s4c'), w('s4w3'),
      echoZ('s4d'), w('s4w4'),
      echoZ('s4e'),
      { msg: { content: 'STUCK-ACROSS-BOOKKEEPING' } },
    ], cap);
    const result = await runTurn(router, makeOpts());
    ok('S4 todowrite between identical calls does not launder the loop: still stuck', result.stopReason === 'stuck');
    ok('S4 stuck synthesis ran', result.text.startsWith('STUCK-ACROSS-BOOKKEEPING'));
  }

  // ── Scenario 5: pure bookkeeping repetition never counts — todowrite ×4 identical then a
  // normal answer must complete untouched (dsh excludes todo_write from the repeat guard).
  {
    const cap: Cap = { n: 0, messages: [] };
    const todos = { todos: ['only item'] };
    const router = scriptedRouter([
      { msg: { tool_calls: [tc('s5a', 'todowrite', todos)] } },
      { msg: { tool_calls: [tc('s5b', 'todowrite', todos)] } },
      { msg: { tool_calls: [tc('s5c', 'todowrite', todos)] } },
      { msg: { tool_calls: [tc('s5d', 'todowrite', todos)] } },
      { msg: { content: 'The todo list is fully updated and every item is marked completed. Nothing is pending and nothing is in progress; the list now shows the finished state.' } },
    ], cap);
    const result = await runTurn(router, makeOpts());
    ok('S5 bookkeeping-only repetition: NOT stopped', result.stopReason === undefined);
    ok('S5 bookkeeping-only repetition: completed to the final answer', result.text.startsWith('The todo list'));
  }

  // ── Scenario 6: budget stop mid-task → HANDOFF synthesis (not a "final answer" prompt).
  // maxTurnTokens=1 with a step reporting 10 total tokens trips budgetStop after step 1;
  // the forced synthesis call must carry the handoff instruction and its text becomes the turn.
  {
    const cap: Cap = { n: 0, messages: [] };
    const router = scriptedRouter([
      { msg: { tool_calls: [tc('s6a', 'runCommand', { command: 'echo work' })] }, usageTotal: 10 },
      { msg: { content: 'HANDOFF-OK' } },
    ], cap);
    (globalThis as any).__tiermuxTestConfig = { mixturePipeline: 'off', maxTurnTokens: 1 };
    try {
      const result = await runTurn(router, makeOpts());
      ok('S6 budget stop: stopReason === budget', result.stopReason === 'budget');
      ok('S6 budget stop: handoff synthesis text became the reply', result.text.startsWith('HANDOFF-OK'));
      ok('S6 budget stop: the model was asked for a HANDOFF (done/remaining/next), not a final answer', textOf(cap.messages[1]).includes('budget ran out'));
    } finally {
      (globalThis as any).__tiermuxTestConfig = { mixturePipeline: 'off' };
    }
  }

  // ── Scenario 7: STRESS — a long multi-file task. 10 files × (read + edit + the SAME verify
  // command), a todowrite after every 5th file — 32 tool steps + the final answer (33 route
  // calls). The same verify command appears ×10 across the turn (never back-to-back): the old
  // whole-turn-total counter killed this at the 3rd verify; the consecutive-run counter must let
  // the whole thing run with no stop and no reminder.
  {
    const cap: Cap = { n: 0, messages: [] };
    const script: Array<{ msg?: Record<string, unknown> }> = [];
    let callId = 0;
    const push = (name: string, args: unknown) =>
      script.push({ msg: { tool_calls: [tc(`s7-${++callId}`, name, args)] } });
    for (let file = 0; file < 10; file++) {
      push('runCommand', { command: `echo read src/file${file}.ts` });
      push('runCommand', { command: `echo edit src/file${file}.ts` });
      push('runCommand', { command: 'npm test -- --run' }); // SAME verify ×10, never adjacent
      if (file % 5 === 4) push('todowrite', { todos: [`file ${file} done`] }); // bookkeeping noise
    }
    script.push({ msg: { content: 'STRESS-DONE: all 10 files edited and verified.' } });
    const router = scriptedRouter(script, cap);
    const result = await runTurn(router, makeOpts());
    ok('S7 32-step stress: NOT stopped (stopReason undefined)', result.stopReason === undefined);
    ok('S7 32-step stress: ran to the scripted final answer', result.text.startsWith('STRESS-DONE'));
    ok('S7 32-step stress: no repeat reminder ever fired', !cap.messages.some((m) => textOf(m).includes('times in a row')));
    ok('S7 32-step stress: every scripted step was consumed by the model loop', cap.n >= script.length);
  }

  // ── Scenario 8: narration wall, ZERO tool calls, on a 'chat'-classified follow-up — the
  // live 2026-08-23 repro shape. "and more issues?" classifies as chat, so the old
  // wantsAction/actionTask-gated retries never fired and the narration became the answer.
  // The narrationWall detector must catch it and the nudge retry (which acts) must win.
  {
    const cap: Cap = { n: 0, messages: [] };
    const narration = 'Let me investigate more carefully. Let me look at what other issues exist '
      + 'beyond the duplicate command registrations. I should check the extension.ts file again '
      + 'for other problems. Let me search for duplicate command registrations or other issues.';
    const router = scriptedRouter([
      { msg: { content: narration } },
      { msg: { tool_calls: [tc('s8a', 'runCommand', { command: 'echo grep -r commands' })] } },
      { msg: { content: 'FOUND-IT: two more duplicate registrations exist in extension.ts.' } },
    ], cap);
    const result = await runTurn(router, makeOpts({ messages: [{ role: 'user', content: 'and more issues?' }] }));
    ok('S8 zero-tool narration wall on a chat-classified follow-up: nudge retry won',
      result.text.startsWith('FOUND-IT'));
    ok('S8 the nudge actually reached the model (call 2 carries the use-the-tool message)',
      textOf(cap.messages[1]).includes('did NOT use any tool'));
  }

  // ── Scenario 9: narration wall AFTER real work, with a NON-action last line — the tail
  // regex misses this reply, only the wall detector can fire the continuation.
  {
    const cap: Cap = { n: 0, messages: [] };
    const narration = 'Let me look at the extension.ts file next. I will examine the command '
      + 'registrations in it. Let me search for duplicates across the codebase. I will report '
      + 'back with a full summary.';
    const router = scriptedRouter([
      { msg: { tool_calls: [tc('s9a', 'runCommand', { command: 'echo audit extension.ts' })] } },
      { msg: { content: narration } },
      { msg: { tool_calls: [tc('s9b', 'runCommand', { command: 'echo grep -n registerCommand' })] } },
      { msg: { content: 'DONE-REPORT: no further duplicates found.' } },
    ], cap);
    const result = await runTurn(router, makeOpts({ messages: [{ role: 'user', content: 'and more issues?' }] }));
    ok('S9 narration wall after work, non-action tail: continuation retry won',
      result.text.startsWith('DONE-REPORT'));
  }

  // ── Scenario 10: stubborn model — the retry ALSO narrates without acting. The retry is
  // rejected (no tool calls), the original narration stays the answer, but now with the
  // honest-stop notice appended instead of a silent "still stopped" narration.
  {
    const cap: Cap = { n: 0, messages: [] };
    const narration = 'Let me re-read the extension.ts file I already saw. I should check for '
      + 'other duplicate commands too. Let me search the codebase for more issues. I will '
      + 'summarize everything afterwards.';
    const router = scriptedRouter([
      { msg: { tool_calls: [tc('s10a', 'runCommand', { command: 'echo first pass' })] } },
      { msg: { content: narration } },
      { msg: { content: 'Let me continue looking into it further. I will investigate some more shortly.' } },
      { msg: { content: 'Let me keep examining the remaining files. I will dig into it again shortly.' } },
    ], cap);
    const result = await runTurn(router, makeOpts({ messages: [{ role: 'user', content: 'and more issues?' }] }));
    ok('S10 stubborn narration: original narration kept as the answer', result.text.startsWith('Let me re-read'));
    ok('S10 Auto failover attempt actually ran (4th route call consumed)', cap.n >= 4);
    ok('S10 honest-stop notice appended (described-not-performed named plainly)',
      /describes actions without performing/i.test(result.text));
  }

  // ── Scenario 11: narration wall, same-model retry fails, AUTO FAILOVER model ACTS — the
  // new 2026-08-23 behavior: in Auto the harness swaps the model instead of telling the user
  // to switch. The failed-over attempt's answer becomes the turn.
  {
    const cap: Cap = { n: 0, messages: [] };
    const narration = 'Let me scan the project structure first. Let me check each command '
      + 'registration one by one. I will compare the lists afterwards carefully.';
    const router = scriptedRouter([
      { msg: { content: narration } },                                  // zero tools, narration wall
      { msg: { content: 'Let me look again at the files. I will inspect them shortly.' } }, // same-model retry: still narration
      { msg: { tool_calls: [tc('s11a', 'runCommand', { command: 'echo grep -n registerCommand' })] } }, // failover model: acts
      { msg: { content: 'DONE-ESCALATED: three duplicate registrations found and fixed.' } },
    ], cap);
    const result = await runTurn(router, makeOpts({ messages: [{ role: 'user', content: 'and more issues?' }] }));
    ok('S11 Auto failover after a narration wall: failed-over model\'s answer won',
      result.text.startsWith('DONE-ESCALATED'));
    ok('S11 no honest-stop notice (the failover model actually acted)',
      !/describes actions without performing/i.test(result.text));
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
