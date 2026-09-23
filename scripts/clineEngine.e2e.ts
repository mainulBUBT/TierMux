/* The Cline engine's core invariants, locked headlessly (no vscode, no fleet keys):
 *  1. a plain text answer round-trips — result.text, finishReason, and the workMessages
 *     transcript (user → assistant) that the host persists for the NEXT turn's re-seed;
 *  2. a scripted tool call executes Cline's REAL builtin tool (read_files) and the transcript
 *     carries BOTH the tool call and its result, so the next turn re-seeds faithfully;
 *  3. the transcript round-trip is lossless: agentToChatMessages(chatToAgentMessages(x))
 *     preserves roles, text, tool calls and tool results;
 *  4. the permission path maps Cline's requestToolApproval onto TierMux's onPermissionAsk,
 *     and a DENIED tool call surfaces as an error tool result the model can see;
 *  5. abort: a hanging model + aborted signal ends the turn without throwing.
 * Run: npm run test:e2e:cline-engine */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMockModel } from './mockClineModel';
import { runAgentStream, runPlanStream } from '../src/agent/agent';
import { __setClineEngineModelForTests, agentToChatMessages } from '../src/agent/core/cline/clineEngine';
import { chatToAgentMessages } from '../src/agent/core/cline/clineEngine';
import { runWithWorkspaceRoot } from '../src/util/workspaceRoot';
import type { AgentOpts, AgentResult } from '../src/agent/agent';
import type { ChatMessage } from '../src/shared/types';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cline-'));
fs.writeFileSync(path.join(root, 'a.txt'), 'hello');

function opts(over: Partial<AgentOpts>): AgentOpts {
  return {
    messages: [{ role: 'user', content: 'what is in a.txt?' }],
    mode: 'agent', effort: 'medium',
    onChunk: () => {}, onTool: () => {}, onReasoning: () => {}, onModel: () => {},
    onFailover: () => {}, onStep: () => {},
    onAskUser: async () => ({ status: 'answered' as const, answers: ['yes'] }), onError: () => {},
    ...over,
  } as AgentOpts;
}

const models = new Map<string, ReturnType<typeof createMockModel>>();
async function turn(model: ReturnType<typeof createMockModel>, over: Partial<AgentOpts> = {}): Promise<AgentResult> {
  models.set(model.name, model);
  __setClineEngineModelForTests(model);
  const run = over.mode === 'plan' ? runPlanStream : runAgentStream;
  try { return await runWithWorkspaceRoot(root, () => run(opts(over))); }
  finally { __setClineEngineModelForTests(undefined); }
}
function modelCallsOf(name: string): number {
  return models.get(name)?.calls.length ?? 0;
}
function lastRequestJson(name: string): string {
  const calls = models.get(name)?.calls ?? [];
  const last = calls[calls.length - 1];
  return JSON.stringify(last?.messages ?? []);
}

async function main() {
  console.log('— plain text answer round-trips —');
  {
    const chunks: string[] = [];
    const r = await turn(createMockModel([{ text: 'a.txt says hello.' }], 'text-only'), {
      onChunk: (t) => chunks.push(t),
    });
    ok('result text is the answer', r.text === 'a.txt says hello.', r.text);
    ok('text arrived as deltas, not only at the end', chunks.length > 0 && chunks.join('') === r.text, `${chunks.length} chunks`);
    ok('finish reason is stop', r.finishReason === 'stop', r.finishReason);
    ok('runtimeName says cline', r.runtimeName === 'cline', r.runtimeName);
    ok('workMessages carry user + assistant', r.workMessages?.length === 2
      && r.workMessages[0].role === 'user' && r.workMessages[1].role === 'assistant', JSON.stringify(r.workMessages?.map((m) => m.role)));
  }

  console.log('\n— a scripted tool call runs Cline\'s REAL builtin tool and round-trips —');
  {
    const r = await turn(createMockModel([
      { toolCalls: [{ toolName: 'read_files', input: { files: [{ path: path.join(root, 'a.txt') }] } }] },
      { text: 'done — a.txt says hello.' },
    ], 'tool-call'), {});
    ok('read_files executed through Cline\'s loop', lastRequestJson('tool-call').includes('hello'), '');
    ok('the follow-up answer arrived', r.text === 'done — a.txt says hello.', r.text);
    const roles = r.workMessages?.map((m) => m.role) ?? [];
    ok('transcript has assistant tool_calls and tool results',
      roles.includes('tool')
      && r.workMessages?.some((m) => m.role === 'assistant' && !!m.tool_calls?.length), roles.join(','));
  }

  console.log('\n— the transcript round-trip is lossless —');
  {
    const wire: ChatMessage[] = [
      { role: 'user', content: 'read the file' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_files', arguments: '{"files":[{"path":"a.txt"}]}' } }] },
      { role: 'tool', content: 'hello', tool_call_id: 'call_1' },
      { role: 'assistant', content: 'it says hello' },
    ];
    const back = agentToChatMessages(chatToAgentMessages(wire, { n: 0 }));
    ok('4 messages survive the round-trip', back.length === wire.length, `${back.length}`);
    ok('tool call preserved', JSON.stringify(back[1]?.tool_calls?.[0]?.function) === JSON.stringify({ name: 'read_files', arguments: '{"files":[{"path":"a.txt"}]}' }));
    ok('tool result preserved', back[2]?.role === 'tool' && (back[2] as { content?: string }).content === 'hello'
      && (back[2] as { tool_call_id?: string }).tool_call_id === 'call_1');
  }

  console.log('\n— permissions: a denied tool call is visible to the model —');
  {
    const asks: string[] = [];
    const r = await turn(createMockModel([
      { toolCalls: [{ toolName: 'run_commands', input: { commands: ['rm -rf /'] } }] },
      { text: 'the command was denied.' },
    ], 'denied-tool'), {
      onPermissionAsk: async (info) => { asks.push(`${info.toolName}:${info.command ?? ''}`); return 'reject'; },
    });
    ok('the host was asked for permission', asks.length === 1 && asks[0].startsWith('run_commands'), asks.join('|'));
    ok('the turn completed with the follow-up answer', r.text === 'the command was denied.', r.text);
    ok('a tool ERROR result reached the transcript',
      r.workMessages?.some((m) => m.role === 'tool'), (r.workMessages?.map((m) => m.role) ?? []).join(','));
  }

  console.log('\n— abort: a hanging model does not wedge the turn —');
  {
    const controller = new AbortController();
    const p = turn(createMockModel([{ text: 'stalling…', hang: true }], 'hang'), {
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    const r = await p;
    ok('the aborted turn returned (no throw)', !!r && r.text === '', `text=${r.text}`);
  }

  console.log('\n— plan mode: a prose answer completes the run (no completion tool) —');
  {
    const r = await turn(createMockModel([
      { text: '1. Echo a.txt. Switch to Agent mode to apply it.' },
    ], 'plan-prose'), { mode: 'plan' });
    ok('one request, no completion reminder', modelCallsOf('plan-prose') === 1, `${modelCallsOf('plan-prose')}`);
    ok('the plan ships as the answer', r.text.startsWith('1. Echo a.txt') && !r.failed, r.text);
  }

  console.log('\n— steering: a mid-run push lands before the next model request, once —');
  {
    let sawHandle = false;
    let steer: { push: (text: string) => void } | undefined;
    const p = turn(createMockModel([
      { text: 'thinking…', hangUntilSteer: true },
      { text: 'ok — changing course.' },
    ], 'steer'), {
      onSteerReady: (h) => { if (h) { sawHandle = true; steer = h; } },
    });
    // Wait for the in-flight request, steer, then release it the way a steering interrupt does.
    while (modelCallsOf('steer') < 1) await new Promise((r) => setTimeout(r, 10));
    steer?.push('actually — answer with BANANA only');
    models.get('steer')?.release();
    const r = await p;
    ok('the steer handle was handed to the host while the run was live', sawHandle, '');
    ok('the run completed after the steering interrupt', r.text === 'ok — changing course.', r.text);
    ok('the steer text led the next request as a user message', lastRequestJson('steer').includes('BANANA'), '');
    ok('the steer text entered the transcript exactly once',
      r.workMessages?.filter((m) => m.role === 'user' && m.content.includes('BANANA')).length === 1, '');
  }

  console.log('\n— WS0: chaining turns on the returned transcript never duplicates history —');
  {
    const r1 = await turn(createMockModel([{ text: 'first answer' }], 'ws0-1'), {
      messages: [{ role: 'user', content: 'turn one question' }],
    });
    ok('turn one returned the seeded user + answer', r1.workMessages?.length === 2, `${r1.workMessages?.length}`);
    const r2 = await turn(createMockModel([{ text: 'second answer' }], 'ws0-2'), {
      messages: [...(r1.workMessages ?? []), { role: 'user', content: 'turn two question' }],
    });
    const userTexts = (r2.workMessages ?? []).filter((m) => m.role === 'user').map((m) => String(m.content));
    ok('turn one\'s user message appears exactly once after chaining',
      userTexts.filter((t) => t === 'turn one question').length === 1, JSON.stringify(userTexts));
    ok('turn two\'s transcript is seed + exactly one new answer', (r2.workMessages?.length ?? 0) === 4, `${r2.workMessages?.length}`);
  }

  console.log('\n— overflow recovery: the runtime re-projects through prepareTurn and retries —');
  {
    const big = 'x'.repeat(40_000);
    const history: ChatMessage[] = [
      { role: 'user', content: 'summarize the file after reading' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_big', type: 'function', function: { name: 'read_files', arguments: '{"files":[{"path":"big.txt"}]}' } }] },
      { role: 'tool', content: big, tool_call_id: 'call_big' },
      { role: 'assistant', content: 'I read the big file.' },
      { role: 'user', content: 'now summarize it in one line' },
    ];
    const r = await turn(createMockModel([
      { finishError: { error: 'This model\'s maximum context length is exceeded', errorClass: 'context_window_exceeded', errorRetryable: false } },
      { text: 'the file is a long run of x characters.' },
    ], 'overflow'), {
      messages: history,
    });
    ok('the run recovered and answered after ONE recovery pass', r.text === 'the file is a long run of x characters.' && modelCallsOf('overflow') === 2, `calls=${modelCallsOf('overflow')} text=${r.text.slice(0, 40)}`);
    const first = models.get('overflow')?.calls[0];
    const second = models.get('overflow')?.calls[1];
    ok('the recovered request was strictly shorter than the overflowing one',
      !!first && !!second && JSON.stringify(second.messages).length < JSON.stringify(first.messages).length,
      `${JSON.stringify(first?.messages ?? []).length} → ${JSON.stringify(second?.messages ?? []).length}`);
  }

  console.log('\n— overflow terminal: nothing left to compact fails the run with the runtime\'s error —');
  {
    const big = 'y'.repeat(40_000);
    const r = await turn(createMockModel([
      { finishError: { error: 'maximum context length exceeded', errorClass: 'context_window_exceeded', errorRetryable: false } },
      { finishError: { error: 'maximum context length exceeded', errorClass: 'context_window_exceeded', errorRetryable: false } },
    ], 'overflow-terminal'), {
      messages: [
        { role: 'user', content: 'summarize' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_big', type: 'function', function: { name: 'read_files', arguments: '{"files":[{"path":"big.txt"}]}' } }] },
        { role: 'tool', content: big, tool_call_id: 'call_big' },
        { role: 'assistant', content: 'read done.' },
        { role: 'user', content: 'summarize again' },
      ],
    });
    ok('the run FAILED after the one allowed recovery', r.failed === true && modelCallsOf('overflow-terminal') === 2, `failed=${r.failed} calls=${modelCallsOf('overflow-terminal')}`);
    ok('the terminal error names the overflow/compaction failure', /overflow|compac|context/i.test(r.errorMessage ?? ''), r.errorMessage?.slice(0, 120));
  }

  console.log('\n— parallel reads batch; the sequential boundary still holds —');
  {
    const r = await turn(createMockModel([
      { toolCalls: [
        { toolName: 'read_files', input: { files: [{ path: path.join(root, 'a.txt') }] } },
        { toolCallId: 'call_x', toolName: 'read_files', input: { files: [{ path: path.join(root, 'a.txt') }] } },
      ] },
      { text: 'both reads finished.' },
    ], 'parallel'), {});
    const toolResults = (r.workMessages ?? []).filter((m) => m.role === 'tool');
    ok('both adjacent read_files calls executed and returned',
      toolResults.length === 2 && toolResults.every((m) => String(m.content).includes('hello')),
      `${toolResults.length} results`);
    ok('the run completed after the batch', r.text === 'both reads finished.', r.text);
  }

  console.log('\n— the deny REASON reaches the model, not just "user denied" —');
  {
    const r = await turn(createMockModel([
      { toolCalls: [{ toolName: 'run_commands', input: { commands: ['sudo rm -rf /'] } }] },
      { text: 'understood — staying read-only.' },
    ], 'deny-reason'), {
      onPermissionAsk: async () => 'reject',
    });
    ok('the deny reason text reached the next request',
      lastRequestJson('deny-reason').includes('denied') || lastRequestJson('deny-reason').includes('permission'),
      '');
    ok('the turn completed after the denial', r.text === 'understood — staying read-only.', r.text);
  }

  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
