/* The cline-agent engine's core invariants, locked headlessly (no vscode, no fleet keys):
 *  1. a plain text answer round-trips — result.text, finishReason, and the workMessages
 *     transcript (user → assistant) that the host persists for the NEXT turn's re-seed;
 *  2. a scripted tool call executes the REAL v3 tool (todoWrite) and the transcript carries
 *     BOTH the tool call and its result, so the next turn re-seeds faithfully;
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
import { runAgentStream } from '../src/agent/agent';
import { __setClineEngineModelForTests, agentToChatMessages } from '../src/agent/core/cline/clineEngine';
import { chatToAgentMessages } from '../src/agent/core/cline/clineEngine';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';
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
    onFailover: () => {}, onStep: () => {}, onTodos: () => {},
    onAskUser: async () => ({ status: 'answered' as const, answers: ['yes'] }), onError: () => {},
    ...over,
  } as AgentOpts;
}

async function turn(model: ReturnType<typeof createMockModel>, over: Partial<AgentOpts> = {}): Promise<AgentResult> {
  __setClineEngineModelForTests(model);
  try { return await runWithWorkspaceRoot(root, () => runAgentStream(opts(over))); }
  finally { __setClineEngineModelForTests(undefined); }
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

  console.log('\n— a scripted tool call runs the REAL v3 tool and round-trips —');
  {
    const todos: unknown[] = [];
    const r = await turn(createMockModel([
      { toolCalls: [{ toolName: 'todoWrite', input: { todos: [{ content: 'read a.txt', status: 'in_progress' }] } }] },
      { text: 'done — a.txt says hello.' },
    ], 'tool-call'), {
      onTodos: (t) => todos.push(t),
    });
    ok('todoWrite executed through Cline\'s loop', todos.length === 1, JSON.stringify(todos).slice(0, 80));
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
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'readFile', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', content: 'hello', tool_call_id: 'call_1' },
      { role: 'assistant', content: 'it says hello' },
    ];
    const back = agentToChatMessages(chatToAgentMessages(wire, { n: 0 }));
    ok('4 messages survive the round-trip', back.length === wire.length, `${back.length}`);
    ok('tool call preserved', JSON.stringify(back[1]?.tool_calls?.[0]?.function) === JSON.stringify({ name: 'readFile', arguments: '{"path":"a.txt"}' }));
    ok('tool result preserved', back[2]?.role === 'tool' && (back[2] as { content?: string }).content === 'hello'
      && (back[2] as { tool_call_id?: string }).tool_call_id === 'call_1');
  }

  console.log('\n— permissions: a denied tool call is visible to the model —');
  {
    const asks: string[] = [];
    const r = await turn(createMockModel([
      { toolCalls: [{ toolName: 'runCommand', input: { command: 'rm -rf /' } }] },
      { text: 'the command was denied.' },
    ], 'denied-tool'), {
      onPermissionAsk: async (info) => { asks.push(`${info.toolName}:${info.command ?? ''}`); return 'reject'; },
    });
    ok('the host was asked for permission', asks.length === 1 && asks[0].startsWith('runCommand'), asks.join('|'));
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

  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
