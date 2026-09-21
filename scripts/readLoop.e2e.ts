/* A model that explores several BIG files round-robin and never answers must be stopped by the
 * repeat-read guard, not run to the step cap. Live repro 2026-09-21 (ask mode, ~6 min, 70+ tool
 * calls, the same 4 files re-read ~7-9× each): ageToolOutputs stubs a big result once 3 newer tool
 * messages exist, so every re-read comes AFTER a stub. A first attempt to treat "re-read after a
 * stub" as a recovery (evicting the dedupe cache) reset the repeat count each time and removed the
 * backstop entirely — 30 reads ran, no stop. The count must survive stubbing.
 *
 * Ask mode then ends with an ANSWER instead of a silent pause: one tool-less continuation after the
 * stuck stop, and a tool-less last step at the step cap; Ask/Plan keep 10 tool results verbatim so a
 * round-robin rarely needs re-reading at all (Agent keeps 3).
 * Run: npm run test:e2e:read-loop */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMockModel } from './mockModel';
import { runAskStream, runAgentStream } from '../src/agent/agent';
import { __setEngineModelForTests } from '../src/agent/core/engine';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';
import type { AgentOpts } from '../src/agent/agent';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-loop-'));
const files = ['A.php', 'B.php', 'C.php', 'D.php'];
for (const f of files) fs.writeFileSync(path.join(root, f), Array.from({ length: 120 }, (_, i) => `// ${f} line ${i} ${'x'.repeat(40)}`).join('\n'));

const baseOpts = (mode: 'ask' | 'agent', over: Partial<AgentOpts> = {}): AgentOpts => ({
  messages: [{ role: 'user', content: 'why does it fail?' }], mode, effort: 'medium',
  onChunk: () => {}, onTool: () => {}, onReasoning: () => {}, onModel: () => {}, onFailover: () => {}, onStep: () => {}, onTodos: () => {},
  onAskUser: async () => ({ status: 'cancelled' as const, answers: [] }), onError: () => {},
  ...over,
} as AgentOpts);

async function run(model: ReturnType<typeof createMockModel>, mode: 'ask' | 'agent', over: Partial<AgentOpts> = {}) {
  __setEngineModelForTests(model);
  try { return await runWithWorkspaceRoot(root, () => (mode === 'ask' ? runAskStream : runAgentStream)(baseOpts(mode, over))); }
  finally { __setEngineModelForTests(undefined); }
}

const stubbed = (m: ReturnType<typeof createMockModel>, call: number) => JSON.stringify(m.calls[call]?.messages ?? '').includes('output elided');

async function main() {
  // ── 1. The repeat-read guard still stops a round-robin loop, and ask mode still ANSWERS ──────
  {
    // 13 reads, then the answer: the 4th identical read (A.php again, read #13) trips REPEAT_READ_LIMIT,
    // so the model's 14th call is the wrap-up continuation — where a real model would answer.
    const steps: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 13; i++) steps.push({ toolCalls: [{ toolName: 'readFile', input: { path: files[i % 4] } }] });
    steps.push({ text: 'The answer.' });
    const m = createMockModel(steps as never, 'read-loop');
    const r = await run(m, 'ask');
    // Ask keeps 10 tool messages verbatim, so the round-robin is served from cache and counted — no
    // stub-then-re-read cycle to reset anything. The guard fires at the 4th identical read.
    ok('the loop was stopped by the guard, then exactly one wrap-up call', m.calls.length === 14, `${m.calls.length} model calls`);
    ok('the stop is still a resumable pause (Continue stays available), not a failure', r.paused === true && !r.failed, JSON.stringify({ paused: r.paused, failed: r.failed }));
    ok('and it names the repeat-read guard', (r as { stopReason?: string }).stopReason === 'stuck', String((r as { stopReason?: string }).stopReason));
    const last = m.calls.at(-1);
    ok('ask mode then got ONE tool-less continuation asking for the answer',
      (last?.toolChoice as { type?: string } | undefined)?.type === 'none' && JSON.stringify(last?.messages).includes('Stop using tools and answer'), JSON.stringify(last?.toolChoice));
    ok('so the paused turn carries an answer instead of nothing', r.text.length > 0, JSON.stringify(r.text));
  }

  // ── 2. Agent mode is unchanged: the same loop pauses with no forced answer ─────────────────
  {
    const steps: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 30; i++) steps.push({ toolCalls: [{ toolName: 'readFile', input: { path: files[i % 4] } }] });
    steps.push({ text: 'The answer.' });
    const m = createMockModel(steps as never, 'read-loop-agent');
    const r = await run(m, 'agent');
    ok('agent mode still stops on the guard', r.paused === true && (r as { stopReason?: string }).stopReason === 'stuck');
    ok('and gets no extra wrap-up pass', !m.calls.some((c) => (c.toolChoice as { type?: string } | undefined)?.type === 'none'));
  }

  // ── 3. The step cap: the LAST budgeted step is tool-less and asks for the answer (ask only) ───
  {
    // Cap of 4: three grep steps, then the LAST budgeted step — where a real model, told no more tools,
    // answers (the mock cannot honour toolChoice, so its scripted 4th step is the answer).
    const steps: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 3; i++) steps.push({ toolCalls: [{ toolName: 'grep', input: { pattern: `p${i}`, path: '.' } }] });
    steps.push({ text: 'Answer from what I found.' });
    const m = createMockModel(steps as never, 'cap');
    const r = await run(m, 'ask', { maxStepsPerTurn: 4 });
    const lastCall = m.calls[3];
    ok('steps before the last leave toolChoice alone', m.calls.slice(0, 3).every((c) => (c.toolChoice as { type?: string } | undefined)?.type !== 'none'));
    ok('the last budgeted step is sent toolChoice none plus the wrap-up request',
      (lastCall?.toolChoice as { type?: string } | undefined)?.type === 'none' && JSON.stringify(lastCall?.messages).includes('Step budget used up'), JSON.stringify(lastCall?.toolChoice));
    ok('the capped ask turn ships an answer, not a pause', r.text.includes('Answer from what I found') && !r.paused, JSON.stringify({ text: r.text, paused: r.paused }));

    const agentSteps: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 6; i++) agentSteps.push({ toolCalls: [{ toolName: 'grep', input: { pattern: `p${i}`, path: '.' } }] });
    const ma = createMockModel(agentSteps as never, 'cap-agent');
    const ra = await run(ma, 'agent', { maxStepsPerTurn: 4 });
    ok('agent mode at the cap is unchanged (a resumable pause, no forced step)', ra.paused === true && !ma.calls.some((c) => (c.toolChoice as { type?: string } | undefined)?.type === 'none'));
  }

  // ── 4. Evidence retention: a big read survives ~10 tool results in ask, but only 3 in agent ───
  {
    const steps: Array<Record<string, unknown>> = [{ toolCalls: [{ toolName: 'readFile', input: { path: 'A.php' } }] }];
    for (let i = 0; i < 6; i++) steps.push({ toolCalls: [{ toolName: 'grep', input: { pattern: `q${i}`, path: '.' } }] });
    steps.push({ text: 'done' });
    const ask = createMockModel(steps as never, 'keep-ask');
    await run(ask, 'ask');
    ok('ask: after six more tool results A.php is still verbatim in the final request', !stubbed(ask, ask.calls.length - 1));
    const agent = createMockModel(steps as never, 'keep-agent');
    await run(agent, 'agent');
    ok('agent: the same read is already stubbed (3 kept)', stubbed(agent, agent.calls.length - 1));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(bad === 0 ? '\nRepeat-read backstop and ask-mode wrap-up hold.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();
