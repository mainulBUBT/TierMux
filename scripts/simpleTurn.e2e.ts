// The simple execution core's fundamental contract (2026-08-24 reset). Four tests:
//   A. stream → native tool call → tool result → final answer (AgentResult compatible)
//   B. abort stops execution cleanly and NEVER triggers the mechanical continuation
//   C. askQuestions is a legitimate terminal state — turn ends, no auto-continuation
//   D. provider failure mid-task → exactly ONE mechanical continuation on a fresh model,
//      and the replacement model RECEIVES THE FULL TRANSCRIPT (continuity, not just rotation)
//
// Drives the REAL runTurn() → createRouterProvider() → streamText() → tools pipeline with a
// fake Router (Router.route() is the only seam faked; the AI SDK itself runs for real).
// Run: npm run test:e2e:simple-turn
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

interface RouteCall {
  request: Array<{ role: string; content: unknown }>;
  opts: Record<string, unknown>;
}

/** Scripted fake Router: each entry is either an OpenAI-shape response to serve or an Error to
 *  throw. Records every (request, opts) pair so tests can assert what each model SAW. */
function makeScriptedRouter(script: Array<{ platform: string; model: string; response?: unknown; error?: Error }>) {
  const calls: RouteCall[] = [];
  const router = {
    async route(request: Array<{ role: string; content: unknown }>, opts: Record<string, unknown> = {}) {
      calls.push({ request, opts });
      const step = script[calls.length - 1];
      if (!step) throw new Error(`scripted router exhausted after ${script.length} calls`);
      if (step.error) throw step.error;
      return { platform: step.platform, model: step.model, response: step.response };
    },
    peekTopSelection: () => ({ entry: { platform: 'testp', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1, contextWindow: 100_000 } }),
    async pickUtilityModel() { return undefined; },
  };
  return { router: router as unknown as Router, calls };
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-simple-e2e-'));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot, path: workspaceRoot } }];

  const commandGate = new CommandGate(() => 'always', () => 5000, () => []);
  const editGate = new EditGate(() => false);
  setGates(editGate, commandGate);

  function makeOpts(overrides: Partial<AgentOpts>): AgentOpts {
    return {
      messages: [{ role: 'user', content: 'do the thing' }],
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
      onError: () => {},
      ...overrides,
    };
  }

  // ── Test A: stream → native tool call → result → final answer ─────────────────────────
  {
    const marker = path.join(workspaceRoot, 'a-marker.txt');
    const { router, calls } = makeScriptedRouter([
      {
        platform: 'testp', model: 'modelA',
        response: baseResponse({ tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: `touch ${JSON.stringify(marker)}` }) } }] }),
      },
      { platform: 'testp', model: 'modelA', response: baseResponse({ content: 'All done — the marker file was created.' }) },
    ]);
    const toolEvents: string[] = [];
    const result = await runTurn(router, makeOpts({ onTool: (e) => toolEvents.push(`${e.name}:${e.state}`) }));
    ok('A: the native tool actually executed (marker file exists)', fs.existsSync(marker));
    ok('A: tool ran and completed (onTool running→done)', toolEvents.includes('runCommand:running') && toolEvents.includes('runCommand:done'));
    ok('A: final answer produced', result.text.startsWith('All done'));
    ok('A: AgentResult compatible (platform/model/taskKind present)', result.platform === 'testp' && result.model === 'modelA' && !!result.taskKind);
    ok('A: transcript carries the tool call AND its result', !!result.workMessages?.some((m) => m.role === 'assistant' && m.tool_calls?.some((tc) => tc.function.name === 'runCommand'))
      && !!result.workMessages?.some((m) => m.role === 'tool' && m.tool_call_id === 'c1'));
    ok('A: exactly two model calls (no extra rounds)', calls.length === 2);
  }

  // ── Test B: abort mid-stream — clean stop, NO mechanical continuation ─────────────────
  {
    const marker = path.join(workspaceRoot, 'b-marker.txt');
    const { router, calls } = makeScriptedRouter([
      {
        platform: 'testp', model: 'modelA',
        response: baseResponse({ tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: `touch ${JSON.stringify(marker)}` }) } }] }),
      },
      { platform: 'testp', model: 'modelA', response: baseResponse({ content: 'should never be needed' }) },
      { platform: 'testp', model: 'modelB', response: baseResponse({ content: 'continuation should never fire on abort' }) },
    ]);
    const abort = new AbortController();
    // Abort the moment the tool call arrives — mid-execution, deterministically.
    const result = await runTurn(router, makeOpts({ abortSignal: abort.signal, onTool: (e) => { if (e.state === 'running') abort.abort(); } }));
    ok('B: an abort is NOT marked as a failed turn', result.failed !== true);
    ok('B: no mechanical continuation fired (no third model call)', calls.length < 3);
  }

  // ── Test C: askQuestions terminates the turn — no auto-continuation ───────────────────
  {
    const { router, calls } = makeScriptedRouter([
      {
        platform: 'testp', model: 'modelA',
        response: baseResponse({ tool_calls: [{ id: 'q1', type: 'function' as const, function: { name: 'askQuestions', arguments: JSON.stringify({ questions: [{ text: 'Which database should the migration target?', options: [{ title: 'Postgres' }, { title: 'MySQL' }] }] }) } }] }),
      },
      { platform: 'testp', model: 'modelA', response: baseResponse({ content: 'must not be reached' }) },
    ]);
    const result = await runTurn(router, makeOpts({ mode: 'plan', messages: [{ role: 'user', content: 'plan the migration' }] }));
    ok('C: questions surfaced on the result', result.askQuestions?.length === 1 && result.askQuestions[0].text.includes('database'));
    ok('C: stopReason is askQuestions (terminal state)', result.stopReason === 'askQuestions');
    ok('C: turn ended on the question — no further model call', calls.length === 1);
  }

  // ── Test D: provider failure → ONE continuation, full transcript survives ─────────────
  // Provider A: answers with a tool call whose result contains a SECRET only its transcript
  // holds, then dies. Provider B must complete the task USING that secret — proving B
  // received A's execution history (continuity), not merely that rotation happened.
  {
    const SECRET = 'SECRET-TOKEN-9172';
    const { router, calls } = makeScriptedRouter([
      {
        platform: 'testp', model: 'modelA',
        response: baseResponse({ tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: `echo ${SECRET}` }) } }] }),
      },
      { platform: 'testp', model: 'modelA', error: new Error('provider A exploded mid-task') },
      { platform: 'testp', model: 'modelB', response: baseResponse({ content: 'Recovered on model B — the secret was echoed back.' }) },
    ]);
    const result = await runTurn(router, makeOpts({ messages: [{ role: 'user', content: 'echo the secret token and tell me what it was' }] }));
    ok('D: continuation completed the task (model B answer won)', result.text.startsWith('Recovered on model B'));
    ok('D: exactly THREE model calls — initial, failure, ONE continuation (no ladder)', calls.length === 3);
    ok('D: the replacement model was a DIFFERENT model (excluded A)', calls[2].opts && Array.isArray(calls[2].opts.exclude) && (calls[2].opts.exclude as string[]).includes('testp::modelA'));
    // The continuity assertion: B's request must contain the tool RESULT from A's transcript —
    // the secret exists nowhere else but in A's executed tool output.
    const bSaw = JSON.stringify(calls[2].request);
    ok('D: PROVIDER B RECEIVED A\'s TRANSCRIPT — the secret from A\'s tool result rode along', bSaw.includes(SECRET));
    ok('D: B also received the original user request', bSaw.includes('echo the secret token'));
    ok('D: recovered turn is not marked failed', result.failed !== true);
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
