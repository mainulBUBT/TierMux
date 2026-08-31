// v3 Foundation Gate (plan §13) — the scenarios that must ALL pass. 1-10 technical,
// 11-14 user-facing critical, 15-24 agent-parity (todoWrite, rules/env context, diagnostics
// feedback, permission persistence, incremental reasoning, nudge draft-retract, stream-error surfacing, failover classification). Scenarios 1-10 are the
// §8 technical cases (SDK-level, via the POC's runAgent + scripted LanguageModelV4 mock);
// 11-14 are the user-facing critical cases and drive the REAL engine (src/agent/agent.ts →
// core/engine.ts) through the __setEngineModelForTests seam.
//
//   #  Coverage
//   1. Tool call (basic)
//   2. Edit/diff correctness
//   3. Error recovery Path A (InvalidToolInputError → repairToolCall → budget)
//   4. Error recovery Path A (NoSuchToolError)
//   5. Error recovery Path B (SDK tool-error wrap)
//   6. Multi-step loop (stepCountIs(50) does NOT fire)
//   7. Cancellation (abortSignal + requestId shell-kill)
//   8. Permissions — toolApproval asks the user
//   9. Permissions — read auto-approved, mutating prompts
//  10. Permissions — Priority 1 wins (alwaysDeny cannot be bypassed, even in full-auto)
//  11. Plan mode flow (§12) — read/search free, shell ASKS, edit hard-deny; the plan is an
//      exitPlanMode tool call that ends the turn; approve → agent mode re-gates every tool
//      (approve ≠ blanket approval)
//  12. Context correctness — system prompt + user text + prior tool results reach the model
//      verbatim; nothing fabricated
//  13. Streaming + reasoning + think-tag — event order, reasoning channel, no <think> leak
//  14. Session persistence — transcript round-trip: turn 2 sees turn 1's tool results, no re-plan
//
// Pass criteria (§13): all 14 pass → steps 9-10 proceed. ANY failure → gate blocks; adapt the
// plan, do not delete. One file on purpose (over-engineering guardrail); mockProvider +
// scripts/vscodeMock.cjs reused throughout.
//
// Run: npm run test:e2e:foundation

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolSet } from 'ai';
import { createMockModel, type MockResponse } from '../src/agent/poc/mockModel';
import { buildStubTools } from '../src/agent/poc/tools';
import { runAgentStream } from '../src/agent/poc/runAgent';
import { defaultPolicy } from '../src/agent/poc/policy';
import { createReadFileTool } from '../src/agent/core/tools/v3/readFile';
import { createEditFileTool } from '../src/agent/core/tools/v3/editFile';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';
import { runAgentStream as engineRun, runPlanStream as engineRunPlan, runAskStream as engineRunAsk } from '../src/agent/agent';
import { __setEngineModelForTests } from '../src/agent/core/engine';
import { resolvePolicy, defaultPolicy as prodDefaultPolicy, policyFromSettings, clearSessionGrants } from '../src/permissions/policy';
import { createStreamTextSplitter } from '../src/agent/core/routerProvider';
import { composeSystemPrompt } from '../src/context/system';
import { gatherPromptContext, invalidatePromptContext } from '../src/context/promptContext';
import * as vscode from 'vscode';
import type { AgentOpts, AgentResult } from '../src/agent/agent';
import type { ChatMessage } from '../src/shared/types';

let failures = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

function makeWorkspace(): { root: string; read: (f: string) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-poc-'));
  fs.writeFileSync(path.join(root, 'foo.txt'), 'hello world', 'utf8');
  fs.writeFileSync(path.join(root, 'bar.txt'), 'second file', 'utf8');
  return { root, read: (f) => fs.readFileSync(path.join(root, f), 'utf8') };
}

/** The REAL v3 tools (plan step 3) + the POC-only stubs scenarios 5/10 still need. The real
 *  ones run through vscode.workspace.fs, scoped to the temp workspace via runWithWorkspaceRoot. */
function realToolSet(stubs: ReturnType<typeof buildStubTools>): ToolSet {
  return {
    readFile: createReadFileTool(),
    editFile: createEditFileTool(),
    writeFile: stubs.writeFile,
    throwingTool: stubs.throwingTool,
  };
}

/** Collects events so scenarios can assert what actually happened. */
function tracker() {
  const toolEvents: Array<{ toolName: string; status: string; input?: unknown }> = [];
  const chunks: string[] = [];
  const errors: unknown[] = [];
  const approvalRequests: Array<{ tool: string; input?: unknown }> = [];
  return {
    toolEvents, chunks, errors, approvalRequests,
    wire: (t: { onChunk?: (s: string) => void; onTool?: (e: { toolName: string; status: string; input?: unknown }) => void; onError?: (e: unknown) => void }) => ({
      onChunk: (s: string) => { chunks.push(s); t.onChunk?.(s); },
      onTool: (e: { toolName: string; status: string; input?: unknown }) => { toolEvents.push(e); t.onTool?.(e); },
      onError: (e: unknown) => { errors.push(e); t.onError?.(e); },
    }),
  };
}

async function run(opts: Parameters<typeof runAgentStream>[0]) {
  return runAgentStream(opts);
}

/** Real-tool runs are scoped to the temp workspace via ALS (same mechanism the fleet uses). */
async function runScoped(root: string, opts: Parameters<typeof runAgentStream>[0]) {
  return runWithWorkspaceRoot(root, () => runAgentStream(opts));
}

async function main() {
  // ── Scenario 1: read (REAL v3 tool) ──────────────────────────────────────────
  {
    const ws = makeWorkspace();
    const stubs = buildStubTools(ws.root);
    const tools: ToolSet = realToolSet(stubs);
    const model = createMockModel([
      { toolCalls: [{ toolName: 'readFile', input: { path: 'foo.txt' } }] },
      { text: 'The file says: hello world' },
    ], 's1');
    const tr = tracker();
    const out = await runScoped(ws.root, {
      prompt: 'read foo.txt', model, tools,
      system: 'You are a test agent.',
      ...tr.wire({}),
    });
    ok('1. tool executed and succeeded', tr.toolEvents.some((e) => e.toolName === 'readFile' && e.status === 'succeeded'));
    ok('1. model saw the file content in step 2',
      model.calls.length === 2 && JSON.stringify(model.calls[1].messages).includes('hello world'),
      `call2=${JSON.stringify(model.calls[1]?.messages).slice(0, 200)}`);
    ok('1. read output is line-numbered file format',
      JSON.stringify(model.calls[1].messages).includes('<file path='),
      'real tool contract: cat -n style <file> wrapper');
    ok('1. streamed text arrived', tr.chunks.join('').includes('hello world') || out.text.includes('hello world'), `chunks=${JSON.stringify(tr.chunks)} text=${out.text}`);
    ok('1. natural finish', out.finishReason === 'stop', `finishReason=${out.finishReason}`);
    ok('1. two steps', out.steps === 2, `steps=${out.steps}`);
  }

  // ── Scenario 2: edit (REAL v3 tool) ──────────────────────────────────────────
  {
    const ws = makeWorkspace();
    const stubs = buildStubTools(ws.root);
    const model = createMockModel([
      { toolCalls: [{ toolName: 'editFile', input: { path: 'foo.txt', search: 'hello', replace: 'goodbye' } }] },
      { text: 'edited' },
    ], 's2');
    const out = await runScoped(ws.root, {
      prompt: 'change hello to goodbye in foo.txt', model,
      tools: realToolSet(stubs),
      policy: { ...defaultPolicy, mode: 'full-auto' },
    });
    ok('2. edit applied on disk', ws.read('foo.txt') === 'goodbye world', `content=${ws.read('foo.txt')}`);
    ok('2. no repairs needed', out.repairs === 0, `repairs=${out.repairs}`);

    // 2b. whitespace-tolerant tier: flush-left search against indented code still applies,
    // and the replacement is RE-INDENTED to the matched text's real indentation.
    fs.writeFileSync(path.join(ws.root, 'indented.ts'), 'function f() {\n  return 1;\n}\n', 'utf8');
    const model2 = createMockModel([
      { toolCalls: [{ toolName: 'editFile', input: { path: 'indented.ts', search: 'return 1;', replace: 'return 2;' } }] },
      { text: 'done' },
    ], 's2b');
    await runScoped(ws.root, {
      prompt: 'bump the return', model: model2,
      tools: realToolSet(stubs),
      policy: { ...defaultPolicy, mode: 'full-auto' },
    });
    ok('2b. flexible match + reindent', ws.read('indented.ts') === 'function f() {\n  return 2;\n}\n',
      `content=${JSON.stringify(ws.read('indented.ts'))}`);
  }

  // ── Scenario 3: malformed args → self-correct (REAL tool schema) ─────────────
  {
    const ws = makeWorkspace();
    const stubs = buildStubTools(ws.root);
    // Call 1 (outer): bad input — path is a number; the real zod union(string, array) rejects it.
    // Call 2 (repair-inner): corrected call. Call 3 (outer step 2): final answer.
    const model = createMockModel([
      { toolCalls: [{ toolName: 'readFile', input: '{"path": 42}' }] },
      { toolCalls: [{ toolName: 'readFile', input: { path: 'foo.txt' } }] },
      { text: 'recovered: the file says hello world' },
    ], 's3');
    const tr = tracker();
    const out = await runScoped(ws.root, {
      prompt: 'read foo.txt', model,
      tools: realToolSet(stubs),
      ...tr.wire({}),
    });
    ok('3. repair consumed exactly once', out.repairs === 1, `repairs=${out.repairs}`);
    ok('3. corrected call executed with valid input',
      tr.toolEvents.some((e) => e.toolName === 'readFile' && e.status === 'succeeded' && (e.input as { path?: string })?.path === 'foo.txt'),
      `events=${JSON.stringify(tr.toolEvents)}`);
    ok('3. turn still completed', out.finishReason === 'stop' && out.steps === 2, `finish=${out.finishReason} steps=${out.steps}`);
  }

  // ── Scenario 4: nonexistent tool → self-correct ──────────────────────────────
  {
    const ws = makeWorkspace();
    const stubs = buildStubTools(ws.root);
    const model = createMockModel([
      { toolCalls: [{ toolName: 'readTheFile', input: { path: 'foo.txt' } }] },
      { toolCalls: [{ toolName: 'readFile', input: { path: 'foo.txt' } }] },
      { text: 'recovered after name fix' },
    ], 's4');
    const out = await runScoped(ws.root, {
      prompt: 'read foo.txt', model,
      tools: realToolSet(stubs),
    });
    ok('4. unknown tool repaired to a real one', out.repairs === 1, `repairs=${out.repairs}`);
    ok('4. turn completed', out.finishReason === 'stop', `finish=${out.finishReason}`);
  }

  // ── Scenario 5: execute() throws → SDK tool-error (Path B) ────────────────────
  {
    const ws = makeWorkspace();
    const stubs = buildStubTools(ws.root);
    const model = createMockModel([
      { toolCalls: [{ toolName: 'throwingTool', input: {} }] },
      { text: 'the tool crashed; reporting the failure' },
    ], 's5');
    const tr = tracker();
    let crashed = false;
    try {
      await run({
        prompt: 'use the tool', model,
        tools: { throwingTool: stubs.throwingTool },
        policy: { ...defaultPolicy, mode: 'full-auto' },   // let it run so the throw actually happens
        ...tr.wire({}),
      });
    } catch (e) {
      crashed = true;
      console.log('      unexpected throw:', e);
    }
    ok('5. throw did NOT crash the turn', !crashed);
    ok('5. failure surfaced to the model',
      tr.toolEvents.some((e) => e.toolName === 'throwingTool' && e.status === 'failed'),
      `events=${JSON.stringify(tr.toolEvents)}`);
  }

  // ── Scenario 6: 3-5 consecutive tool calls, natural finish ────────────────────
  {
    const ws = makeWorkspace();
    const stubs = buildStubTools(ws.root);
    const model = createMockModel([
      { toolCalls: [{ toolName: 'readFile', input: { path: 'foo.txt' } }] },
      { toolCalls: [{ toolName: 'readFile', input: { path: 'bar.txt' } }] },
      { toolCalls: [{ toolName: 'readFile', input: { path: 'foo.txt' } }] },
      { text: 'read all three' },
    ], 's6');
    const out = await runScoped(ws.root, {
      prompt: 'read foo, bar, foo', model,
      tools: realToolSet(stubs),
    });
    ok('6. four steps ran naturally', out.steps === 4, `steps=${out.steps}`);
    ok('6. step cap not hit', out.finishReason === 'stop', `finish=${out.finishReason}`);
  }

  // ── Scenario 7: abort mid-stream ─────────────────────────────────────────────
  {
    const ws = makeWorkspace();
    const stubs = buildStubTools(ws.root);
    const model = createMockModel([{ hang: true }], 's7');
    const tr = tracker();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    let settled = false;
    let rejectReason: unknown = undefined;
    try {
      await run({
        prompt: 'stall forever', model,
        tools: { readFile: stubs.readFile },
        signal: controller.signal,
        ...tr.wire({}),
      });
      settled = true;
    } catch (e) {
      rejectReason = e;
      settled = true; // rejection with AbortError is an acceptable settle
    }
    const isAbort = rejectReason === undefined || (rejectReason as Error)?.name === 'AbortError';
    ok('7. abort settles the turn', settled && isAbort,
      `reason=${rejectReason ? String((rejectReason as Error).message) : 'resolved'} errors=${tr.errors.length}`);
    ok('7. no tool ran after abort', !tr.toolEvents.some((e) => e.status === 'succeeded'));
  }

  // ── Scenario 8: ask mode → mutating tool prompts ─────────────────────────────
  {
    const ws = makeWorkspace();
    const stubs = buildStubTools(ws.root);
    const model = createMockModel([
      { toolCalls: [{ toolName: 'editFile', input: { path: 'foo.txt', search: 'hello', replace: 'asked' } }] },
      { text: 'done after approval' },
    ], 's8');
    const tr = tracker();
    const out = await runScoped(ws.root, {
      prompt: 'edit foo.txt', model,
      tools: realToolSet(stubs),
      policy: { ...defaultPolicy, mode: 'ask' },
      requestApproval: async (req) => { tr.approvalRequests.push(req); return 'allow'; },
    });
    ok('8. user was asked once', tr.approvalRequests.length === 1 && tr.approvalRequests[0].tool === 'editFile',
      `requests=${JSON.stringify(tr.approvalRequests)}`);
    ok('8. approved edit applied', ws.read('foo.txt') === 'asked world', `content=${ws.read('foo.txt')}`);
    ok('8. turn completed', out.finishReason === 'stop');
  }

  // ── Scenario 9: auto mode → read auto, mutating prompts ───────────────────────
  {
    const ws = makeWorkspace();
    const stubs = buildStubTools(ws.root);
    const model = createMockModel([
      { toolCalls: [{ toolName: 'readFile', input: { path: 'foo.txt' } }] },
      { toolCalls: [{ toolName: 'editFile', input: { path: 'foo.txt', search: 'hello', replace: 'auto' } }] },
      { text: 'done' },
    ], 's9');
    const tr = tracker();
    await runScoped(ws.root, {
      prompt: 'read then edit', model,
      tools: realToolSet(stubs),
      policy: { ...defaultPolicy, mode: 'auto' },       // allowlist empty
      requestApproval: async (req) => { tr.approvalRequests.push(req); return 'allow'; },
    });
    ok('9. read-only ran without asking',
      tr.approvalRequests.length === 1 && tr.approvalRequests[0].tool === 'editFile',
      `requests=${JSON.stringify(tr.approvalRequests)}`);
    ok('9. mutating edit applied after ask', ws.read('foo.txt') === 'auto world', `content=${ws.read('foo.txt')}`);
  }

  // ── Scenario 10: full-auto, alwaysDeny wins ──────────────────────────────────
  {
    const ws = makeWorkspace();
    const stubs = buildStubTools(ws.root);
    const model = createMockModel([
      { toolCalls: [{ toolName: 'editFile', input: { path: 'foo.txt', search: 'hello', replace: 'DENIED' } }] },
      { toolCalls: [{ toolName: 'writeFile', input: { path: 'new.txt', content: 'written in full-auto' } }] },
      { text: 'done' },
    ], 's10');
    const tr = tracker();
    const out = await runScoped(ws.root, {
      prompt: 'edit then write', model,
      tools: realToolSet(stubs),
      policy: { ...defaultPolicy, mode: 'full-auto', alwaysDeny: new Set(['editFile']) },
      requestApproval: async (req) => { tr.approvalRequests.push(req); return 'allow'; },
    });
    ok('10. alwaysDeny blocked the edit', ws.read('foo.txt') === 'hello world', `content=${ws.read('foo.txt')}`);
    ok('10. no approval asked in full-auto', tr.approvalRequests.length === 0, `requests=${JSON.stringify(tr.approvalRequests)}`);
    ok('10. non-denied tool auto-ran', ws.read('new.txt') === 'written in full-auto');
    ok('10. turn completed', out.finishReason === 'stop', `finish=${out.finishReason}`);
  }

  // ── Scenarios 11-14: the REAL engine (src/agent/core/engine.ts) via the model seam ──

  /** Minimal AgentOpts for engine turns; scenarios override what they care about. */
  function engineOpts(over: Partial<AgentOpts> & { messages: ChatMessage[]; mode: AgentOpts['mode'] }): AgentOpts {
    return {
      effort: 'medium',
      onChunk: () => {},
      onTool: () => {},
      onReasoning: () => {},
      onModel: () => {},
      onFailover: () => {},
      onStep: () => {},
      onTodos: () => {},
      onAskUser: async () => 'yes',
      onError: () => {},
      ...over,
    };
  }

  async function engineTurn(model: ReturnType<typeof createMockModel>, opts: AgentOpts): Promise<AgentResult> {
    __setEngineModelForTests(model);
    // The public entries force their mode (same as production callers) — pick by requested mode.
    const entry = opts.mode === 'plan' ? engineRunPlan : opts.mode === 'ask' ? engineRunAsk : engineRun;
    try {
      return await entry(undefined as never, opts);
    } finally {
      __setEngineModelForTests(undefined);
    }
  }

  // ── Scenario 11: Plan mode flow (§12) ────────────────────────────────────────
  {
    const ws = makeWorkspace();
    const planModel = createMockModel([
      { toolCalls: [{ toolName: 'readFile', input: { path: 'foo.txt' } }] },
      // The plan arrives as an exitPlanMode TOOL CALL, not markdown the host has to recognize
      // (2026-08-31 redesign — see scripts/exitPlanMode.e2e.ts for the boundary's own suite).
      { toolCalls: [{ toolName: 'exitPlanMode', input: {
        title: 'Rename greeting',
        steps: [{ what: 'Replace "hello" with "goodbye"', files: ['foo.txt'], verify: 'read foo.txt again' }],
      } }] },
    ], 's11-plan');

    const planTr = tracker();
    const planResult = await runWithWorkspaceRoot(ws.root, () => engineTurn(planModel, engineOpts({
      messages: [{ role: 'user', content: 'plan renaming hello to goodbye in foo.txt' }],
      mode: 'plan',
      ...planTr.wire({}),
    })));

    ok('11. plan toolset offers read+shell+exitPlanMode, NOT editors',
      planModel.calls[0].tools.includes('runCommand') && planModel.calls[0].tools.includes('readFile')
      && planModel.calls[0].tools.includes('exitPlanMode') && !planModel.calls[0].tools.includes('editFile'),
      `tools=${JSON.stringify(planModel.calls[0].tools)}`);
    ok('11. read executed during planning', planTr.toolEvents.some((e: { name?: string; state?: string }) => e.name === 'readFile' && e.state === 'done'));
    ok('11. the plan reaches the host as validated structure, not prose to classify',
      planResult.plan?.title === 'Rename greeting' && planResult.plan?.steps[0]?.files?.[0] === 'foo.txt',
      `plan=${JSON.stringify(planResult.plan)}`);
    ok('11. exitPlanMode ends the planning turn', planModel.calls.length === 2, `calls=${planModel.calls.length}`);

    // §12 policy profile, asserted directly: read free, shell ASKS, edit hard-denied even
    // with alwaysAllow set (approve ≠ blanket approval).
    const planPolicy = { ...prodDefaultPolicy, sessionMode: 'plan' as const, alwaysAllow: new Set(['editFile']) };
    const readVerdict = await resolvePolicy({ toolName: 'readFile' }, planPolicy);
    const shellVerdict = await resolvePolicy({ toolName: 'runCommand' }, planPolicy, async () => { throw new Error('must ask'); }).catch(() => 'ASKED');
    const editVerdict = await resolvePolicy({ toolName: 'editFile' }, planPolicy);
    ok('11. policy: read auto-approved in plan mode', readVerdict === 'approved' || (readVerdict as { type: string }).type === 'approved');
    ok('11. policy: shell ASKS in plan mode', shellVerdict === 'ASKED', String(shellVerdict));
    ok('11. policy: edit hard-denied even with alwaysAllow', (editVerdict as { type: string }).type === 'denied');

    // Approve flow: setMode('agent') + history kept → every tool re-gated (no blanket).
    const agentTr = tracker();
    const approvals: string[] = [];
    const agentModel = createMockModel([
      { toolCalls: [{ toolName: 'editFile', input: { path: 'foo.txt', search: 'hello', replace: 'goodbye' } }] },
      { text: 'executed the plan' },
    ], 's11-agent');
    await runWithWorkspaceRoot(ws.root, () => engineTurn(agentModel, engineOpts({
      messages: [...(planResult.workMessages ?? []), { role: 'user', content: 'Approved. Execute the plan.' }],
      mode: 'agent',
      ...agentTr.wire({}),
      onPermissionAsk: async () => { approvals.push('editFile'); return 'once'; },
    })));
    ok('11. approve → agent mode, edit re-gated through ask', approvals.length === 1 && approvals[0] === 'editFile',
      `approvals=${JSON.stringify(approvals)}`);
    ok('11. approved edit applied', ws.read('foo.txt') === 'goodbye world', `content=${ws.read('foo.txt')}`);
  }

  // ── Scenario 12: Context correctness (engine-owned slice) ───────────────────
  {
    const ws = makeWorkspace();
    const m1 = createMockModel([
      { toolCalls: [{ toolName: 'readFile', input: { path: 'foo.txt' } }] },
      { text: 'it says hello world' },
    ], 's12a');
    const r1 = await runWithWorkspaceRoot(ws.root, () => engineTurn(m1, engineOpts({
      messages: [{ role: 'user', content: 'read foo.txt and remember it' }],
      mode: 'agent',
    })));

    const m2 = createMockModel([{ text: 'hello world, as I read earlier' }], 's12b');
    await runWithWorkspaceRoot(ws.root, () => engineTurn(m2, engineOpts({
      messages: [...(r1.workMessages ?? []), { role: 'user', content: 'what did foo.txt say? quote it exactly' }],
      mode: 'ask',
    })));

    const prompt2 = JSON.stringify(m2.calls[0].messages);
    ok('12. prior tool result reaches the next turn verbatim', prompt2.includes('hello world'));
    ok('12. user text reaches the model verbatim', prompt2.includes('quote it exactly'));
    ok('12. nothing fabricated — unmentioned file absent from context', !prompt2.includes('bar.txt'), 'bar.txt was never referenced');
  }

  // ── Scenario 13: Streaming + reasoning + think-tag ───────────────────────────
  {
    const ws = makeWorkspace();
    const events: string[] = [];
    const chunks: string[] = [];
    const m = createMockModel([
      { reasoning: 'locating the file first', toolCalls: [{ toolName: 'readFile', input: { path: 'foo.txt' } }] },
      { reasoning: 'now answering', text: 'The file says hello world' },
    ], 's13');
    const r = await runWithWorkspaceRoot(ws.root, () => engineTurn(m, engineOpts({
      messages: [{ role: 'user', content: 'read foo.txt' }],
      mode: 'agent',
      onChunk: (t) => { chunks.push(t); events.push(`text:${t}`); },
      onReasoning: (t) => { events.push(`reasoning:${t}`); },
      onTool: (e) => { events.push(`tool:${(e as { name: string }).name}:${(e as { state: string }).state}`); },
    })));
    ok('13. reasoning reached the reasoning channel', (r.reasoning ?? '').includes('locating the file first') && (r.reasoning ?? '').includes('now answering'),
      `reasoning=${JSON.stringify(r.reasoning)}`);
    ok('13. reasoning never leaked into chat text', !r.text.includes('locating the file first') && !chunks.join('').includes('locating'),
      `text=${r.text} chunks=${JSON.stringify(chunks)}`);
    ok('13. reasoning precedes text within a step', events.indexOf('reasoning:now answering') < events.findIndex((e) => e.startsWith('text:')),
      `events=${JSON.stringify(events)}`);
    ok('13. tool events fired', events.some((e) => e.startsWith('tool:readFile:')));

    // Think-tag no-leak through the STREAMING path's own splitter (full matrix in
    // thinkSplit.e2e.ts — this is the in-gate spot check, incl. the R1 regression shape).
    const splitter = createStreamTextSplitter();
    let leaked = '';
    let reasoning = '';
    for (const chunk of ['<thi', 'nk>secret reasoning</th', 'ink>visible answer']) {
      const out = splitter.feed(chunk, '');
      leaked += out.text;
      reasoning += out.reasoning;
    }
    const f = splitter.flush();
    leaked += f.text; reasoning += f.reasoning;
    ok('13. split <think> tags: zero leak, reasoning captured',
      leaked === 'visible answer' && reasoning === 'secret reasoning',
      `text=${JSON.stringify(leaked)} reasoning=${JSON.stringify(reasoning)}`);
    const dup = createStreamTextSplitter();
    const d1 = dup.feed('<think>same words</think>', 'same words');
    ok('13. duplicate reasoning suppressed (first channel wins)', d1.reasoning === 'same words', `reasoning=${JSON.stringify(d1.reasoning)}`);
  }

  // ── Scenario 14: Session persistence (transcript round-trip) ─────────────────
  {
    const ws = makeWorkspace();
    const m1 = createMockModel([
      { toolCalls: [{ toolName: 'readFile', input: { path: 'foo.txt' } }] },
      { text: 'read it, the greeting is hello world' },
    ], 's14a');
    const r1 = await runWithWorkspaceRoot(ws.root, () => engineTurn(m1, engineOpts({
      messages: [{ role: 'user', content: 'read foo.txt' }],
      mode: 'agent',
    })));

    // Simulated close/reopen: a FRESH engine turn seeded with the persisted transcript.
    // The model must already SEE foo.txt's content — no re-read, no re-plan.
    const tr2 = tracker();
    const m2 = createMockModel([
      { toolCalls: [{ toolName: 'editFile', input: { path: 'foo.txt', search: 'hello', replace: 'goodbye' } }] },
      { text: 'edited as planned' },
    ], 's14b');
    await runWithWorkspaceRoot(ws.root, () => engineTurn(m2, engineOpts({
      messages: [...(r1.workMessages ?? []), { role: 'user', content: 'now change hello to goodbye in foo.txt' }],
      mode: 'agent',
      ...tr2.wire({}),
      onPermissionAsk: async () => 'once',
    })));

    const prompt2 = JSON.stringify(m2.calls[0].messages);
    ok('14. reopened turn sees prior tool results', prompt2.includes('hello world'));
    ok('14. no re-read — readFile NOT called in turn 2', !tr2.toolEvents.some((e: { name?: string }) => e.name === 'readFile'),
      `events=${JSON.stringify(tr2.toolEvents.map((e: { name?: string }) => e.name))}`);
    ok('14. agent-mode toolset recovered (editFile offered)', m2.calls[0].tools.includes('editFile'));
    ok('14. edit applied from recovered context', ws.read('foo.txt') === 'goodbye world', `content=${ws.read('foo.txt')}`);
  }

  // ── Scenario 15: todoWrite tool end-to-end ──────────────────────────────────
  {
    const ws = makeWorkspace();
    const seenTodos: Array<Array<{ content: string; status: string }>> = [];
    const m = createMockModel([
      { toolCalls: [{ toolName: 'todoWrite', input: { todos: [
        { content: 'Fix the loop', status: 'in_progress' },
        { content: 'Add a test', status: 'pending' },
        { content: 'Update docs', status: 'pending' },
      ] } }] },
      { text: 'all done' },
    ], 's15');
    const out = await runWithWorkspaceRoot(ws.root, () => engineTurn(m, engineOpts({
      messages: [{ role: 'user', content: 'do the three things' }],
      mode: 'agent',
      onTodos: (todos) => { seenTodos.push(todos as never); },
    })));
    ok('15. onTodos fired once with parsed items', seenTodos.length === 1 && seenTodos[0].length === 3 && seenTodos[0][0].content === 'Fix the loop' && seenTodos[0][0].status === 'in_progress',
      `seen=${JSON.stringify(seenTodos)}`);
    const prompt2 = JSON.stringify(m.calls[1]?.messages ?? []);
    ok('15. confirmation reached step-2 messages', prompt2.includes('Task list updated') && prompt2.includes('Fix the loop'));
    ok('15. turn completed', out.finishReason === 'stop', `finish=${out.finishReason}`);

    const { buildV3ToolSet } = await import('../src/agent/core/tools/v3');
    ok('15. todoWrite offered in all 3 modes', ['agent', 'plan', 'ask'].every((mode) => 'todoWrite' in buildV3ToolSet(mode as never)));
  }

  // ── Scenario 16: project rules reach the system prompt ──────────────────────
  {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws.root, 'AGENTS.md'), 'ALWAYS use tabs. Never touch src/legacy/.', 'utf8');
    const prevFolders = vscode.workspace.workspaceFolders;
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file(ws.root), name: path.basename(ws.root), index: 0 },
    ];
    invalidatePromptContext();
    try {
      const m = createMockModel([{ text: 'noted the rules' }], 's16');
      await runWithWorkspaceRoot(ws.root, () => engineTurn(m, engineOpts({
        messages: [{ role: 'user', content: 'hello' }],
        mode: 'agent',
      })));
      const system = JSON.stringify(m.calls[0].messages);
      ok('16. AGENTS.md body reached the model', system.includes('ALWAYS use tabs'), system.slice(0, 200));
      ok('16. rules wrapped in <project_rules>', system.includes('<project_rules>'));

      // ── Scenario 17: environment context + prompt length pin ────────────────
      let ctx = await gatherPromptContext();
      const prompt = composeSystemPrompt('agent', ctx);
      ok('17. <environment_context> present with date + workspace', prompt.includes('<environment_context>') && prompt.includes(new Date().toISOString().slice(0, 10)) && prompt.includes(path.basename(ws.root)),
        prompt.slice(0, 400));
      // Length pin through the REAL pipeline: a 9K rules file → loadProjectRules caps 8K →
      // gatherPromptContext slices to MAX_RULES_INJECT → composed prompt stays bounded.
      fs.writeFileSync(path.join(ws.root, 'AGENTS.md'), 'x'.repeat(9_000), 'utf8');
      invalidatePromptContext();
      ctx = await gatherPromptContext();
      const fatPrompt = composeSystemPrompt('agent', ctx);
      ok('17. prompt length pinned < 8_000 with max-size rules', fatPrompt.length < 8_000 && fatPrompt.includes('[project rules truncated]'), `len=${fatPrompt.length}`);
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = prevFolders;
      invalidatePromptContext();
    }
  }

  // ── Scenario 18: editFile result carries the post-edit diagnostics note ─────
  {
    const ws = makeWorkspace();
    const diag = { severity: 0, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, message: 'new type error', code: 'T1' };
    let calls = 0;
    (globalThis as { __tiermuxTestDiagnostics?: unknown }).__tiermuxTestDiagnostics = () => {
      calls++;
      return calls >= 2 ? [diag] : []; // before-snapshot clean, after-write has a NEW error
    };
    const m = createMockModel([
      { toolCalls: [{ toolName: 'editFile', input: { path: 'foo.txt', search: 'hello', replace: 'goodbye' } }] },
      { text: 'fixed the error' },
    ], 's18');
    try {
      const out = await runWithWorkspaceRoot(ws.root, () => engineTurn(m, engineOpts({
        messages: [{ role: 'user', content: 'fix foo.txt' }],
        mode: 'agent',
        onPermissionAsk: async () => 'once',
      })));
      const step2 = JSON.stringify(m.calls[1]?.messages ?? []);
      ok('18. diagnostics note rode in the edit result', step2.includes('New diagnostics after this edit') && step2.includes('new type error'), step2.slice(0, 300));
      ok('18. edit itself still applied (success preserved)', ws.read('foo.txt') === 'goodbye world');
      ok('18. turn completed', out.finishReason === 'stop');
    } finally {
      delete (globalThis as { __tiermuxTestDiagnostics?: unknown }).__tiermuxTestDiagnostics;
    }
  }

  // ── Scenario 19: getDiagnostics tool ─────────────────────────────────────────
  {
    const ws = makeWorkspace();
    const diag = { severity: 0, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, message: 'boom', code: 'E1' };
    (globalThis as { __tiermuxTestDiagnostics?: unknown }).__tiermuxTestDiagnostics = [
      [vscode.Uri.file(path.join(ws.root, 'foo.txt')), [diag]],
    ];
    const m = createMockModel([
      { toolCalls: [{ toolName: 'getDiagnostics', input: { path: 'foo.txt' } }] },
      { text: 'there is an error' },
    ], 's19');
    try {
      const out = await runWithWorkspaceRoot(ws.root, () => engineTurn(m, engineOpts({
        messages: [{ role: 'user', content: 'any errors?' }],
        mode: 'agent',
      })));
      const step2 = JSON.stringify(m.calls[1]?.messages ?? []);
      ok('19. diagnostics returned in the formatted shape', step2.includes('ERROR') && step2.includes('boom'), step2.slice(0, 300));
      ok('19. turn completed', out.finishReason === 'stop', `finish=${out.finishReason}`);
    } finally {
      delete (globalThis as { __tiermuxTestDiagnostics?: unknown }).__tiermuxTestDiagnostics;
    }
  }

  // ── Scenario 20: always-allow persists across turns (session grants) ────────
  {
    clearSessionGrants('s20');
    // Unit half: the grant written via 'allow-always' survives a FRESH policyFromSettings.
    const cfg1 = policyFromSettings(false, 'agent', 's20');
    const d1 = await resolvePolicy({ toolName: 'editFile' }, cfg1, async () => 'allow-always');
    const cfg2 = policyFromSettings(false, 'agent', 's20');
    let asked = 0;
    const d2 = await resolvePolicy({ toolName: 'editFile' }, cfg2, async () => { asked++; return 'reject'; });
    ok('20. first ask resolves via approval channel', d1.type === 'approved');
    ok('20. grant persists in a fresh policy (no re-ask)', d2.type === 'approved' && asked === 0, `asked=${asked}`);
    clearSessionGrants('s20');

    // Engine half: two turns sharing a sessionId — turn 2's edit is auto-approved.
    const ws = makeWorkspace();
    const m1 = createMockModel([
      { toolCalls: [{ toolName: 'editFile', input: { path: 'foo.txt', search: 'hello', replace: 'goodbye' } }] },
      { text: 'done once' },
    ], 's20a');
    let askCount = 0;
    const ask = async () => { askCount++; return 'always' as const; };
    await runWithWorkspaceRoot(ws.root, () => engineTurn(m1, engineOpts({
      messages: [{ role: 'user', content: 'change hello to goodbye' }],
      mode: 'agent', sessionId: 's20-engine',
      onPermissionAsk: ask,
    })));
    const m2 = createMockModel([
      { toolCalls: [{ toolName: 'editFile', input: { path: 'foo.txt', search: 'goodbye', replace: 'farewell' } }] },
      { text: 'done twice' },
    ], 's20b');
    await runWithWorkspaceRoot(ws.root, () => engineTurn(m2, engineOpts({
      messages: [{ role: 'user', content: 'change goodbye to farewell' }],
      mode: 'agent', sessionId: 's20-engine',
      onPermissionAsk: ask,
    })));
    ok('20. engine: turn 2 edit auto-approved (asked only in turn 1)', askCount === 1 && ws.read('foo.txt') === 'farewell world', `askCount=${askCount} content=${ws.read('foo.txt')}`);
    clearSessionGrants('s20-engine');
  }

  // ── Scenario 21: reasoning streams INCREMENTALLY (not end-dumped) ───────────
  {
    // (a) Splitter-level: a long think block fed in 8 chunks must emit reasoning on
    // MULTIPLE feeds before flush — locks the incremental pass-through so nobody
    // "optimizes" the ThinkStripper back into end-of-stream buffering.
    const splitter = createStreamTextSplitter();
    const thinkBody = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
    const pieces: string[] = [];
    const chunkSize = Math.ceil(('<think>' + thinkBody + '</think>ok').length / 8);
    const whole = '<think>' + thinkBody + '</think>ok';
    for (let i = 0; i < whole.length; i += chunkSize) pieces.push(whole.slice(i, i + chunkSize));
    let emittingFeeds = 0;
    let reasoning = '';
    for (const p of pieces) {
      const out = splitter.feed(p, '');
      if (out.reasoning) emittingFeeds++;
      reasoning += out.reasoning;
    }
    const f = splitter.flush();
    if (f.reasoning) emittingFeeds++;
    ok('21. splitter emits reasoning incrementally (>=2 feeds before flush)', emittingFeeds >= 2, `emittingFeeds=${emittingFeeds}`);
    ok('21. splitter full think content captured', reasoning.includes(thinkBody), `reasoning=${JSON.stringify(reasoning)}`);

    // (b) Engine-level: multi-delta reasoning fires onReasoning per delta.
    const ws = makeWorkspace();
    const reasoningCalls: string[] = [];
    const m = createMockModel([
      { reasoningDeltas: ['part one ', 'part two ', 'part three'], text: 'answer' },
    ], 's21');
    const out = await runWithWorkspaceRoot(ws.root, () => engineTurn(m, engineOpts({
      messages: [{ role: 'user', content: 'think then answer' }],
      mode: 'agent',
      onReasoning: (t) => { reasoningCalls.push(t); },
    })));
    ok('21. engine: onReasoning fired per delta (>1)', reasoningCalls.length > 1, `calls=${reasoningCalls.length}`);
    ok('21. engine: reasoning concatenation matches', (out.reasoning ?? '') === 'part one part two part three', `reasoning=${JSON.stringify(out.reasoning)}`);
  }

  // ── Scenario 22: act-gap nudge retracts the pass-1 narration draft ──────────
  // Live repro (nemotron-3-ultra-free, 12:57 AM): pass 1 streamed narration ("The user is
  // asking me to… Let me grep…"), the act-gap nudge fired, and pass 2's text streamed into
  // the SAME draft — the reply bubble showed the narration TWICE. The engine must retract
  // the draft before the continuation pass so pass-1 narration becomes Chain-of-Thought and
  // pass 2 is the sole reply.
  {
    const ws = makeWorkspace();
    const retracts: number[] = [];
    const chunks: string[] = [];
    const m = createMockModel([
      { text: 'The user is asking me to search for hello. Let me grep for hello' },
      { text: 'The user is asking me to search for hello. Let me grep again' },
    ], 's22');
    const out = await runWithWorkspaceRoot(ws.root, () => engineTurn(m, engineOpts({
      messages: [{ role: 'user', content: 'Hello' }],
      mode: 'agent',
      onChunk: (t) => chunks.push(t),
      onRetractDraft: () => retracts.push(1),
    })));
    ok('22. nudge fired (two model calls)', m.calls.length === 2, `calls=${m.calls.length}`);
    ok('22. pass-1 narration retracted before pass 2', retracts.length === 1, `retracts=${retracts.length}`);
    ok('22. result.text is the continuation pass only', out.text === 'The user is asking me to search for hello. Let me grep again', `text=${JSON.stringify(out.text)}`);
    ok('22. both passes still streamed (host re-routes pass 1 to CoT)', chunks.length === 2, `chunks=${JSON.stringify(chunks)}`);
  }

  // ── Scenario 23: provider stream error → honest failed result, not a phantom turn ──
  // Live repro (1:18 AM, "@routes/web.php optimize this"): the provider chain died in ~1s,
  // but consumeStream() RESOLVES on stream errors (it never rejects), so the engine returned
  // finish 'unknown' / 0 in / 0 out as if the turn succeeded and the webview guessed "check
  // your model keys". The engine must surface the real error via failed+errorMessage.
  {
    const ws = makeWorkspace();
    const m = createMockModel([
      { error: new Error('TierMux: all candidates failed: 401 Unauthorized') },
    ], 's23');
    const out = await runWithWorkspaceRoot(ws.root, () => engineTurn(m, engineOpts({
      messages: [{ role: 'user', content: 'optimize this' }],
      mode: 'agent',
    })));
    ok('23. stream error → failed:true (not a silent empty success)', out.failed === true, `failed=${out.failed} finish=${out.finishReason}`);
    ok('23. errorMessage carries the real provider reason', !!out.errorMessage && out.errorMessage.includes('401 Unauthorized'), String(out.errorMessage));
    ok('23. no phantom text', out.text === '', `text=${JSON.stringify(out.text)}`);
  }

  // ── Scenario 24: quota/credit failures ARE failover-worthy ─────────────────
  // Live repro: "auto rotate not works" — free gateways answer out-of-credit with 402
  // (pollinations) and paid-only-model-with-$0-credit with 403 (new-api/TokenRouter), and
  // isFailoverWorthy only rotated on 401/429/5xx/network — so those errors threw straight
  // through the candidate loop and killed the turn with zero rotation.
  {
    const { isFailoverWorthy } = await import('../src/agent/core/routerProvider');
    const { ProviderHttpError } = await import('../src/providers/base');
    const http = (status: number) => new ProviderHttpError(`API error ${status}`, status);
    for (const status of [400, 401, 402, 403, 429, 500, 503]) {
      ok(`24. HTTP ${status} rotates to the next model`, isFailoverWorthy(http(status)));
    }
    ok('24. 200-class success never rotates', !isFailoverWorthy(new Error('some parse glitch')));
    ok('24. network errors rotate', isFailoverWorthy(new Error('fetch failed')));
  }

  // ── Scenario 25: checkpoint baseline is the TRUE pre-write content (undo restores) ──
  // Live repro (2026-08-28, "undo not restoreing files"): the only baseline capture for v3
  // write tools lived in chatViewProvider's onTool — which v3 fires from the engine's
  // onStepEnd, i.e. AFTER the tool had already written. Every "before" snapshot therefore
  // held the POST-edit content, so checkpoint restore rewrote files with the very content it
  // was supposed to undo: "Restored N files" with zero visible change. The tools now capture
  // the baseline themselves (onBeforeWrite) BEFORE mutating.
  {
    const ws = makeWorkspace(); // foo.txt = 'hello world', bar.txt = 'second file'
    const { CheckpointManager } = await import('../src/edits/checkpoints');
    const cps = new CheckpointManager(ws.root); // non-git tmp dir → snaps path (the broken one)
    await cps.begin('r1', 'undo restores'); // the host does this in handleSend before the turn
    const m = createMockModel([
      { toolCalls: [{ toolName: 'editFile', input: { path: 'foo.txt', search: 'hello', replace: 'goodbye' } }] },
      { toolCalls: [{ toolName: 'writeFile', input: { path: 'new.txt', content: 'brand new' } }] },
      { text: 'edited foo, created new' },
    ], 's25');
    await runWithWorkspaceRoot(ws.root, () => engineTurn(m, engineOpts({
      messages: [{ role: 'user', content: 'edit foo.txt and create new.txt' }],
      mode: 'agent',
      onBeforeWrite: (uri, before) => cps.record(uri, before),
      onPermissionAsk: async () => 'once',
    })));
    ok('25. edits landed on disk', ws.read('foo.txt') === 'goodbye world' && ws.read('new.txt') === 'brand new',
      `foo=${ws.read('foo.txt')} new=${ws.read('new.txt')}`);
    await cps.commit();
    ok('25. checkpoint kept (baselines recorded)', cps.list().length === 1, `list=${JSON.stringify(cps.list())}`);
    const changed = await cps.changedFiles(cps.list()[0].id);
    ok('25. changedFiles sees both files (true pre-state differs from disk)',
      changed.length === 2 && changed.every((f) => f.status === 'modified' || f.status === 'created'),
      JSON.stringify(changed));
    const n = await cps.restore(cps.list()[0].id);
    ok('25. restore reverts the edit AND un-creates the new file',
      n === 2 && ws.read('foo.txt') === 'hello world' && !fs.existsSync(path.join(ws.root, 'new.txt')),
      `n=${n} foo=${JSON.stringify(ws.read('foo.txt'))} newExists=${fs.existsSync(path.join(ws.root, 'new.txt'))}`);
  }

  // ── Pinned model runs ALONE (2026-08-31, user direction) ────────────────────
  // A SET model is an exact request: the selection is the pin and NOTHING else. The old
  // chain padded the pin with the task table and every usable enabled model, so a failing
  // pin was silently answered by a different provider's model while the footer still
  // credited the pin (live repro: openrouter GLM pinned, kilo Nemotron served). A dead pin
  // now fails the turn with the real error instead.
  {
    const { setModelSources, selectModel } = await import('../src/router/picker');
    const store = new Map<string, string[]>();
    setModelSources({
      // kimi-k2 is deliberately marked tool-incapable — the requireTools assertion below
      // proves the picker skips it (the old Router's router.ts:779 rule).
      catalog: { find: (_p: string, m: string) => ({ supportsTools: m !== 'kimi-k2' }) } as never,
      settings: {
        getFallback: () => [
          { platform: 'groq', modelId: 'openai/gpt-oss-120b', enabled: true, priority: 0 },
          { platform: 'kilo', modelId: 'kimi-k2', enabled: true, priority: 1 },
          { platform: 'opencode', modelId: 'glm-4.6-flash-free', enabled: true, priority: 2 },
        ],
        getDisabledProviders: () => [],
        // Mirrors the real SettingsStore: per-model `enabled` AND the provider-level switch.
        enabledByPriority(): Array<{ platform: string; modelId: string; enabled: boolean; priority: number }> {
          const off = new Set(this.getDisabledProviders());
          return this.getFallback().filter((e) => e.enabled && !off.has(e.platform)).sort((a, b) => a.priority - b.priority);
        },
      } as never,
      secrets: { getKeys: async (p: string) => store.get(p) ?? [], isToolIncompatible: () => false } as never,
    });
    store.set('groq', ['gsk-live']);

    const sel = await selectModel([], { pinnedModel: 'groq::openai/gpt-oss-120b' });
    ok('F. pinned model is the selection', sel.model === 'groq::openai/gpt-oss-120b', JSON.stringify(sel));
    ok('F. pinned selection has NO failover depth', sel.fallbackChain.length === 0,
      `fallbackChain=${JSON.stringify(sel.fallbackChain)}`);
    ok('F. pinned rationale names only the pin',
      sel.rationale?.entries.length === 1 && sel.rationale.entries[0].selected === true,
      JSON.stringify(sel.rationale));

    // An unroutable pin (no key for its platform) must NOT silently reroute either —
    // empty selection plus the skip reason, which resolveCandidates surfaces as the
    // turn's error message.
    const dead = await selectModel([], { pinnedModel: 'ollama::glm-5.2' });
    ok('F. unroutable pin yields no candidate', dead.model === '' && dead.fallbackChain.length === 0,
      JSON.stringify(dead));
    ok('F. unroutable pin reports its skip reason',
      !!dead.rationale?.entries[0]?.skip && !dead.rationale.picked, JSON.stringify(dead.rationale));

    // 'auto' is the webview selector's DEFAULT value (media/src/main.ts `let currentModel =
    // 'auto'`) and flows here as pinnedModel on every default Auto send — it means "no pin".
    // The pin-runs-alone branches above must not treat it as an unroutable pin: without the
    // guard this returned an empty selection and resolveCandidates killed every Auto turn
    // with "Pinned model auto could not run: no API key stored for this platform" (repro'd
    // 2026-09-01, caught in the pre-release scan).
    const autoSel = await selectModel([], { pinnedModel: 'auto' });
    ok('F. pinnedModel "auto" is not a pin — normal routing still happens',
      autoSel.model.length > 0 && autoSel.fallbackChain.length >= 2, JSON.stringify(autoSel));
    const { resolveCandidates } = await import('../src/agent/core/routerProvider');
    try {
      const autoChain = await resolveCandidates({ pinnedModel: 'auto' } as never);
      ok('F. resolveCandidates serves Auto (no pin error)', autoChain.length > 0,
        JSON.stringify(autoChain.map((c) => `${c.platform}::${c.modelId}`)));
    } catch (e) {
      ok('F. resolveCandidates serves Auto (no pin error)', false, (e as Error).message);
    }

    // No pin at all → table first, then the enabled tail.
    const sel2 = await selectModel([], {});
    ok('F. unpinned selection also has depth', sel2.model.length > 0 && sel2.fallbackChain.length >= 2,
      JSON.stringify(sel2));

    // requireTools (the old Router's rule, router.ts:779): catalog models marked
    // supportsTools=false must be skipped — they deflect instead of calling tools.
    const toolSel = await selectModel([], { requireTools: true });
    ok('F. requireTools skips non-tool models',
      toolSel.model !== 'kilo::kimi-k2' && !toolSel.fallbackChain.includes('kilo::kimi-k2'),
      JSON.stringify(toolSel));
    setModelSources(undefined as never);

    // Tail ordering: rank-sorted (best first), NOT raw settings order — a paper-strong model
    // sitting first in settings order used to serve every task after the table ids went dead.
    setModelSources({
      catalog: { find: (_p: string, m: string) => ({ supportsTools: true, intelligenceRank: m === 'a-model' ? 1 : m === 'b-model' ? 2 : 3 }) } as never,
      settings: {
        getFallback: () => [
          { platform: 'p1', modelId: 'c-model', enabled: true, priority: 0 },
          { platform: 'p1', modelId: 'b-model', enabled: true, priority: 1 },
          { platform: 'p1', modelId: 'a-model', enabled: true, priority: 2 },
        ],
        getDisabledProviders: () => [],
        // Mirrors the real SettingsStore: per-model `enabled` AND the provider-level switch.
        enabledByPriority(): Array<{ platform: string; modelId: string; enabled: boolean; priority: number }> {
          const off = new Set(this.getDisabledProviders());
          return this.getFallback().filter((e) => e.enabled && !off.has(e.platform)).sort((a, b) => a.priority - b.priority);
        },
      } as never,
      secrets: { getKeys: async () => ['k'], isToolIncompatible: () => false } as never,
    });
    const sel3 = await selectModel([], {});
    ok('F. tail ordered by intelligence rank, not settings order',
      sel3.model === 'p1::a-model'
      && sel3.fallbackChain[0] === 'p1::b-model' && sel3.fallbackChain[1] === 'p1::c-model',
      JSON.stringify(sel3));

    // "Why this model?" rationale must ride on the selection (the footer's (?) button renders
    // a popover from it — v3 selection used to produce nothing, so the button was dead).
    const rat = sel3.rationale;
    ok('F. selection carries a rationale report',
      !!rat && rat.picked === 'p1::a-model' && rat.entries.length >= 3,
      JSON.stringify(rat));
    ok('F. rationale marks the served model and numeric fields are popover-safe',
      !!rat && rat.entries[0].selected === true && Number.isFinite(rat.entries[0].score)
      && typeof rat.entries[0].reason === 'string' && rat.entries[0].reason.length > 0,
      JSON.stringify(rat?.entries[0]));
    const skipRow = rat?.entries.find((e) => e.skip);
    ok('F. skipped candidates carry a reason (or none exist)', skipRow === undefined || (typeof skipRow.skip === 'string' && skipRow.skip.length > 0),
      JSON.stringify(skipRow));
    setModelSources(undefined as never);

    // A model picked BY THE TASK TABLE keeps its table label — the enabled-tail loop used to
    // re-pick the same key with the generic 'enabled model' label and overwrite the popover's
    // why (live repro: table-picked opencode/hy3-free showed "enabled model — serves this turn").
    setModelSources({
      catalog: { find: (_p: string, m: string) => (m === 'gemini-2.5-flash' ? { supportsTools: true, intelligenceRank: 1 } : undefined) } as never,
      settings: {
        getFallback: () => [{ platform: 'google', modelId: 'gemini-2.5-flash', enabled: true, priority: 0 }],
        getDisabledProviders: () => [],
        // Mirrors the real SettingsStore: per-model `enabled` AND the provider-level switch.
        enabledByPriority(): Array<{ platform: string; modelId: string; enabled: boolean; priority: number }> {
          const off = new Set(this.getDisabledProviders());
          return this.getFallback().filter((e) => e.enabled && !off.has(e.platform)).sort((a, b) => a.priority - b.priority);
        },
      } as never,
      secrets: { getKeys: async () => ['k'], isToolIncompatible: () => false } as never,
    });
    const selT = await selectModel([], { taskKind: 'vision' }); // vision table = [google::gemini-2.5-flash]
    ok('F. task-table pick keeps its table label in the rationale',
      selT.model === 'google::gemini-2.5-flash' && !!selT.rationale
      && selT.rationale.entries[0].reason.startsWith('task table (vision)'),
      JSON.stringify(selT.rationale?.entries[0]));
    setModelSources(undefined as never);

    // Web tools (restored) are offered in every mode.
    const { buildV3ToolSet } = await import('../src/agent/core/tools/v3');
    const agentTools = buildV3ToolSet('agent');
    ok('F. webSearch + fetchUrl offered in agent mode', 'webSearch' in agentTools && 'fetchUrl' in agentTools);
    const askTools = buildV3ToolSet('ask');
    ok('F. web tools offered in ask mode too', 'webSearch' in askTools && 'fetchUrl' in askTools);
  }

  console.log(failures === 0 ? '\nALL 25 FOUNDATION SCENARIOS PASS — gate open for steps 9-10' : `\n${failures} FAILURE(S) — FOUNDATION GATE BLOCKED, adapt the plan before deleting`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
