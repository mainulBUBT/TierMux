// Foundation Gate — THE contract. The agent is Cline (@cline/agents loop, @cline/core tools and
// prompt); this file locks what TierMux still owns around it, driving the REAL engine through
// the __setClineEngineModelForTests seam with Cline's real builtin tools on a temp workspace:
// tool results reach the model, the checkpoint baseline, approvals and their settings, plan mode
// enforcement, the ask card, rules in the prompt, MCP tools, abort, failures and the step cap.
// Run: npm run test:e2e:foundation
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMockModel, type MockResponse } from './mockClineModel';
import { runAgentStream, runPlanStream } from '../src/agent/agent';
import { __setClineEngineModelForTests, agentToChatMessages, chatToAgentMessages } from '../src/agent/core/cline/clineEngine';
import { clearSessionGrants } from '../src/permissions/policy';
import { setMcpManager, type McpManager } from '../src/mcp/mcpManager';
import { runWithWorkspaceRoot } from '../src/util/workspaceRoot';
import type { AgentOpts, AgentResult, ToolEvent } from '../src/agent/agent';
import type { ChatMessage } from '../src/shared/types';

let failures = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `   (${detail})` : ''}`);
  if (!cond) failures++;
};

function workspace(): { root: string; file: (f: string) => string; read: (f: string) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-foundation-'));
  fs.writeFileSync(path.join(root, 'foo.txt'), 'hello world', 'utf8');
  return { root, file: (f) => path.join(root, f), read: (f) => fs.readFileSync(path.join(root, f), 'utf8') };
}

function settings(values: Record<string, unknown>): void {
  (globalThis as { __tiermuxTestConfig?: Record<string, unknown> }).__tiermuxTestConfig = values;
}

interface Run {
  result: AgentResult;
  model: ReturnType<typeof createMockModel>;
  tools: ToolEvent[];
  asks: Array<{ toolName?: string; command?: string }>;
  errors: string[];
  reasoning: string[];
  questions: Array<{ question: string; options?: string[] }>;
  writes: Array<{ path: string; before: string | null }>;
}

let seq = 0;
async function turn(root: string, script: MockResponse[], over: Partial<AgentOpts> & { verdict?: 'once' | 'always' | 'reject' } = {}): Promise<Run> {
  const model = createMockModel(script, `m${++seq}`);
  const run: Omit<Run, 'result'> = { model, tools: [], asks: [], errors: [], reasoning: [], questions: [], writes: [] };
  const { verdict = 'once', ...rest } = over;
  const opts: AgentOpts = {
    messages: [{ role: 'user', content: 'do the task' }],
    mode: 'agent',
    effort: 'medium',
    sessionId: `s${seq}`,
    onChunk: () => {},
    onTool: (e) => { run.tools.push(e); },
    onReasoning: (t) => { run.reasoning.push(t); },
    onModel: () => {},
    onFailover: () => {},
    onStep: () => {},
    onError: (m) => { run.errors.push(m); },
    onAskUser: async (qs) => {
      run.questions.push(...qs.map((q) => ({ question: q.question, options: q.options })));
      return { status: 'answered', answers: ['Use TypeScript'] };
    },
    onPermissionAsk: async (info) => { run.asks.push(info); return verdict; },
    onBeforeWrite: (uri, before) => { run.writes.push({ path: uri.fsPath, before }); },
    ...rest,
  };
  __setClineEngineModelForTests(model);
  try {
    const result = await runWithWorkspaceRoot(root, () => (opts.mode === 'plan' ? runPlanStream(opts) : runAgentStream(opts)));
    return { ...run, result };
  } finally {
    __setClineEngineModelForTests(undefined);
  }
}

const requestText = (m: ReturnType<typeof createMockModel>, i: number): string => JSON.stringify(m.calls[i]?.messages ?? []);
const offered = (m: ReturnType<typeof createMockModel>): string[] => (m.calls[0]?.tools ?? []).map((t) => t.name);
const done = (r: Run, name: string) => r.tools.some((e) => e.name === name && e.state === 'done');

async function main() {
  settings({});

  console.log('— 1. a Cline tool result reaches the model and the transcript —');
  {
    const ws = workspace();
    const r = await turn(ws.root, [
      { toolCalls: [{ toolName: 'read_files', input: { files: [{ path: ws.file('foo.txt') }] } }] },
      { text: 'foo.txt says hello world.' },
    ]);
    ok('1a. read_files ran through Cline', done(r, 'read_files'));
    ok('1b. the file content reached the next request', requestText(r.model, 1).includes('hello world'));
    ok('1c. the answer shipped', r.result.text.includes('hello world'), r.result.text);
    const wm = r.result.workMessages ?? [];
    ok('1d. workMessages carry the call AND its result',
      wm.some((m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.function.name === 'read_files'))
      && wm.some((m) => m.role === 'tool' && String(m.content).includes('hello world')));
  }

  console.log('— 2. Cline\'s editor writes, and the checkpoint baseline is the TRUE pre-write content —');
  {
    const ws = workspace();
    const r = await turn(ws.root, [
      { toolCalls: [{ toolName: 'editor', input: { path: ws.file('foo.txt'), old_text: 'hello world', new_text: 'hello cline' } }] },
      { toolCalls: [{ toolName: 'editor', input: { path: ws.file('new.txt'), new_text: 'fresh' } }] },
      { text: 'Done.' },
    ], { autoApprove: true });
    ok('2a. the edit landed on disk', ws.read('foo.txt') === 'hello cline', ws.read('foo.txt'));
    ok('2b. the create landed on disk', fs.existsSync(ws.file('new.txt')) && ws.read('new.txt') === 'fresh');
    const baseline = r.writes.find((w) => w.path.endsWith('foo.txt'));
    ok('2c. baseline = pre-write content', baseline?.before === 'hello world', JSON.stringify(baseline));
    ok('2d. a new file\'s baseline is null', r.writes.find((w) => w.path.endsWith('new.txt'))?.before === null);
    const changed = r.result.changedFiles ?? [];
    ok('2e. changedFiles reports modified + created',
      changed.some((c) => c.path.endsWith('foo.txt') && c.status === 'modified')
      && changed.some((c) => c.path.endsWith('new.txt') && c.status === 'created'), JSON.stringify(changed));
  }

  console.log('— 3. a tool FAILURE reaches the model and the run continues —');
  {
    const ws = workspace();
    const r = await turn(ws.root, [
      { toolCalls: [{ toolName: 'read_files', input: { files: [{ path: ws.file('missing.txt') }] } }] },
      { text: 'That file does not exist.' },
    ]);
    ok('3a. the run completed', !r.result.failed && r.result.text.includes('does not exist'), r.result.text);
    ok('3b. the failure text reached the model', /missing\.txt/.test(requestText(r.model, 1)));
  }

  console.log('— 4. abort mid-stream is a resumable pause, not a failure —');
  {
    const ws = workspace();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const r = await turn(ws.root, [{ hang: true, text: 'thinking…' }], { abortSignal: ac.signal });
    ok('4a. paused', r.result.paused === true, JSON.stringify({ paused: r.result.paused, failed: r.result.failed }));
    ok('4b. not failed and no error surfaced', !r.result.failed && r.errors.length === 0, r.errors.join(' | '));
  }

  console.log('— 5. plan mode: Cline\'s read-only toolset, and the VS Code plan contract —');
  {
    const ws = workspace();
    const r = await turn(ws.root, [
      { toolCalls: [{ toolName: 'editor', input: { path: ws.file('foo.txt'), old_text: 'hello world', new_text: 'nope' } }] },
      { text: '1. Change foo.txt. Switch to Agent mode to apply it.' },
    ], { mode: 'plan', autoApprove: true });
    ok('5a. no editor in the offer', !offered(r.model).includes('editor'), offered(r.model).join(','));
    ok('5b. a hallucinated edit changed nothing', ws.read('foo.txt') === 'hello world');
    ok('5c. the prompt tells the model the USER flips to Act', String(r.model.calls[0]?.systemPrompt).includes('toggle to Act mode'));
    ok('5d. the plan shipped as the answer', r.result.text.includes('Change foo.txt'), r.result.text);
  }
  {
    const ws = workspace();
    const r = await turn(ws.root, [
      { toolCalls: [{ toolName: 'run_commands', input: { commands: ['ls'] } }] },
      { text: 'Listed.' },
    ], { mode: 'plan', verdict: 'reject' });
    ok('5e. a plan-mode shell command ASKS even when read-only', r.asks.some((a) => a.toolName === 'run_commands'), JSON.stringify(r.asks));
  }

  console.log('— 6. approvals and their settings —');
  {
    const ws = workspace();
    settings({ commandApproval: 'always' });
    const r = await turn(ws.root, [
      { toolCalls: [{ toolName: 'editor', input: { path: ws.file('foo.txt'), old_text: 'hello world', new_text: 'rejected' } }] },
      { text: 'Understood, leaving it.' },
    ], { verdict: 'reject' });
    ok('6a. an edit asks', r.asks.some((a) => a.toolName === 'editor'));
    ok('6b. a rejection blocks the write', ws.read('foo.txt') === 'hello world');
    ok('6c. the deny reason reaches the model', /denied/i.test(requestText(r.model, 1)));
    ok('6d. the run survives the rejection', r.result.text.includes('leaving it'), r.result.text);
  }
  {
    const ws = workspace();
    settings({ commandApproval: 'always', requireWriteConfirmation: false });
    const r = await turn(ws.root, [
      { toolCalls: [{ toolName: 'editor', input: { path: ws.file('foo.txt'), old_text: 'hello world', new_text: 'unprompted' } }] },
      { toolCalls: [{ toolName: 'run_commands', input: { commands: ['touch made-by-shell.txt'] } }] },
      { text: 'Done.' },
    ], { verdict: 'reject' });
    ok('6e. requireWriteConfirmation=false: the edit runs without a prompt', ws.read('foo.txt') === 'unprompted' && !r.asks.some((a) => a.toolName === 'editor'));
    ok('6f. …but a mutating shell command still asks', r.asks.some((a) => a.toolName === 'run_commands' && /touch/.test(a.command ?? '')), JSON.stringify(r.asks));
  }
  {
    const ws = workspace();
    settings({ commandApproval: 'always' });
    const r = await turn(ws.root, [
      { toolCalls: [{ toolName: 'run_commands', input: { commands: ['ls', 'git status'] } }] },
      { text: 'Listed.' },
    ], { verdict: 'reject' });
    ok('6g. read-only shell commands auto-run in agent mode', r.asks.length === 0 && done(r, 'run_commands'), JSON.stringify(r.asks));
  }
  {
    const ws = workspace();
    settings({ commandApproval: 'always' });
    const r = await turn(ws.root, [
      { toolCalls: [{ toolName: 'run_commands', input: { commands: ['ls', 'rm -rf foo.txt'] } }] },
      { text: 'Stopped.' },
    ], { verdict: 'reject' });
    ok('6h. one dangerous entry in a batch forces the prompt', r.asks.length === 1 && fs.existsSync(ws.file('foo.txt')), JSON.stringify(r.asks));
  }
  {
    const ws = workspace();
    settings({ commandApproval: 'never' });
    const r = await turn(ws.root, [
      { toolCalls: [{ toolName: 'run_commands', input: { commands: ['touch should-not-exist.txt'] } }] },
      { text: 'The shell is disabled.' },
    ], { autoApprove: true });
    ok('6i. commandApproval=never disables the shell, even with auto-approve', !fs.existsSync(ws.file('should-not-exist.txt')));
    ok('6j. …and says why', /disabled/.test(requestText(r.model, 1)));
  }
  {
    const ws = workspace();
    settings({ commandApproval: 'always' });
    clearSessionGrants('grant-session');
    const first = await turn(ws.root, [
      { toolCalls: [{ toolName: 'editor', input: { path: ws.file('foo.txt'), old_text: 'hello world', new_text: 'one' } }] },
      { text: 'ok' },
    ], { verdict: 'always', sessionId: 'grant-session' });
    const second = await turn(ws.root, [
      { toolCalls: [{ toolName: 'editor', input: { path: ws.file('foo.txt'), old_text: 'one', new_text: 'two' } }] },
      { text: 'ok' },
    ], { verdict: 'reject', sessionId: 'grant-session' });
    ok('6k. "Always" persists across turns in a session', first.asks.length === 1 && second.asks.length === 0 && ws.read('foo.txt') === 'two', `${first.asks.length}/${second.asks.length} ${ws.read('foo.txt')}`);
  }
  settings({});

  console.log('— 7. ask_question drives the ask card and the answer reaches the model —');
  {
    const ws = workspace();
    const r = await turn(ws.root, [
      { toolCalls: [{ toolName: 'ask_question', input: { question: 'Which language?', options: ['Use TypeScript', 'Use Python'] } }] },
      { text: 'Going with TypeScript.' },
    ]);
    ok('7a. the card got the question and options', r.questions[0]?.question === 'Which language?' && r.questions[0]?.options?.length === 2, JSON.stringify(r.questions));
    ok('7b. the answer reached the model', requestText(r.model, 1).includes('Use TypeScript'));
  }

  console.log('— 8. Cline\'s rules reach the system prompt —');
  {
    const ws = workspace();
    fs.mkdirSync(ws.file('.clinerules'));
    fs.writeFileSync(ws.file('.clinerules/style.md'), '---\nname: style\n---\nAlways answer in lowercase.\n');
    fs.writeFileSync(ws.file('AGENTS.md'), '# Agent rules\n\nNever touch the vendor folder.\n');
    const r = await turn(ws.root, [{ text: 'ok' }]);
    const sys = String(r.model.calls[0]?.systemPrompt ?? '');
    ok('8a. .clinerules/ reached the prompt', sys.includes('Always answer in lowercase.'));
    ok('8b. AGENTS.md reached the prompt', sys.includes('Never touch the vendor folder.'));
    ok('8c. the prompt is Cline\'s', sys.includes('You are Cline'));
  }

  console.log('— 9. MCP tools reach the model in agent mode only —');
  {
    const ws = workspace();
    let called = '';
    const fake = {
      agentTools: async () => [{
        name: 'mcp__demo__echo',
        description: 'Echo the input.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        execute: async (input: { text?: string }) => { called = input.text ?? ''; return `echo: ${input.text}`; },
      }],
    } as unknown as McpManager;
    setMcpManager(fake);
    const r = await turn(ws.root, [
      { toolCalls: [{ toolName: 'mcp__demo__echo', input: { text: 'ping' } }] },
      { text: 'Echoed.' },
    ], { autoApprove: true });
    ok('9a. offered in agent mode', offered(r.model).includes('mcp__demo__echo'));
    ok('9b. executed with the model\'s input', called === 'ping', called);
    const p = await turn(ws.root, [{ text: 'ok' }], { mode: 'plan' });
    ok('9c. withheld in plan mode', !offered(p.model).includes('mcp__demo__echo'));
    setMcpManager(undefined as unknown as McpManager);
  }

  console.log('— 10. the step cap is a resumable pause —');
  {
    const ws = workspace();
    const r = await turn(ws.root, [
      { toolCalls: [{ toolName: 'read_files', input: { files: [{ path: ws.file('foo.txt') }] } }] },
    ], { maxStepsPerTurn: 2 });
    ok('10a. paused, not failed', r.result.paused === true && !r.result.failed, JSON.stringify({ paused: r.result.paused, failed: r.result.failed }));
    ok('10b. no error notice for the cap', r.errors.length === 0, r.errors.join(' | '));
  }

  console.log('— 11. a provider failure is an honest failed result —');
  {
    const ws = workspace();
    const r = await turn(ws.root, [{ finishError: { error: 'invalid api key', errorClass: 'auth', errorRetryable: false } }]);
    ok('11a. failed with the message', r.result.failed === true && /invalid api key/.test(r.result.errorMessage ?? ''), r.result.errorMessage);
    ok('11b. the error reached the UI', r.errors.some((e) => /invalid api key/.test(e)));
  }

  console.log('— 12. reasoning streams incrementally —');
  {
    const ws = workspace();
    const r = await turn(ws.root, [{ reasoningDeltas: ['first ', 'second ', 'third'], text: 'answer' }]);
    ok('12a. three reasoning deltas, not one dump', r.reasoning.length >= 3, String(r.reasoning.length));
    ok('12b. the result carries the whole reasoning', r.result.reasoning === 'first second third', r.result.reasoning);
  }

  console.log('— 13. the persisted transcript round-trips into Cline\'s seed —');
  {
    const chat: ChatMessage[] = [
      { role: 'user', content: 'read foo' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_files', arguments: '{"files":[{"path":"/x/foo.txt"}]}' } }] },
      { role: 'tool', content: 'hello world', tool_call_id: 'c1' },
      { role: 'assistant', content: 'it says hello world' },
    ];
    const back = agentToChatMessages(chatToAgentMessages(chat, { n: 0 }));
    ok('13a. lossless', JSON.stringify(back) === JSON.stringify(chat), JSON.stringify(back));
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
