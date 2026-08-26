// v3 Foundation Gate (plan §13) — the 14 scenarios that must ALL pass. Scenarios 1-10 are the
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
//  11. Plan mode flow (§12) — read/search free, shell ASKS, edit hard-deny; markdown plan;
//      approve → agent mode re-gates every tool (approve ≠ blanket approval)
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
import { resolvePolicy, defaultPolicy as prodDefaultPolicy } from '../src/permissions/policy';
import { createStreamTextSplitter } from '../src/agent/core/routerProvider';
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
      { text: '## Plan: Rename greeting\n### Step 1: Replace the word\n  - What: editFile search="hello" replace="goodbye"\n  - Files: foo.txt\n  - Verify: readFile again\n' },
    ], 's11-plan');

    const planTr = tracker();
    const planResult = await runWithWorkspaceRoot(ws.root, () => engineTurn(planModel, engineOpts({
      messages: [{ role: 'user', content: 'plan renaming hello to goodbye in foo.txt' }],
      mode: 'plan',
      ...planTr.wire({}),
    })));

    ok('11. plan toolset offers read+shell, NOT editors',
      planModel.calls[0].tools.includes('runCommand') && planModel.calls[0].tools.includes('readFile') && !planModel.calls[0].tools.includes('editFile'),
      `tools=${JSON.stringify(planModel.calls[0].tools)}`);
    ok('11. read executed during planning', planTr.toolEvents.some((e: { name?: string; state?: string }) => e.name === 'readFile' && e.state === 'done'));
    ok('11. output follows the ## Plan markdown convention', planResult.text.startsWith('## Plan:'), `text=${planResult.text.slice(0, 40)}`);

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

  // ── Failover chain depth (hardening — the live "1s, 0 tokens" regression) ────
  // A PINNED model must never be a single point of failure: the chain pads with the rest
  // of the usable enabled models, so a 429/dead pinned model fails over instead of dying.
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
      } as never,
      secrets: { getKeys: async (p: string) => store.get(p) ?? [], isToolIncompatible: () => false } as never,
    });
    store.set('groq', ['gsk-live']);

    const sel = await selectModel([], { pinnedModel: 'groq::openai/gpt-oss-120b' });
    ok('F. pinned model leads the chain', sel.model === 'groq::openai/gpt-oss-120b', JSON.stringify(sel));
    ok('F. chain has failover depth beyond the pinned model',
      sel.fallbackChain.length >= 2 && sel.fallbackChain.includes('kilo::kimi-k2'),
      `fallbackChain=${JSON.stringify(sel.fallbackChain)}`);

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

    // Web tools (restored) are offered in every mode.
    const { buildV3ToolSet } = await import('../src/agent/core/tools/v3');
    const agentTools = buildV3ToolSet('agent');
    ok('F. webSearch + fetchUrl offered in agent mode', 'webSearch' in agentTools && 'fetchUrl' in agentTools);
    const askTools = buildV3ToolSet('ask');
    ok('F. web tools offered in ask mode too', 'webSearch' in askTools && 'fetchUrl' in askTools);
  }

  console.log(failures === 0 ? '\nALL 14 FOUNDATION SCENARIOS PASS — gate open for steps 9-10' : `\n${failures} FAILURE(S) — FOUNDATION GATE BLOCKED, adapt the plan before deleting`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
