// E2e for the scripted mock model (src/router/mockFixture.ts + Router.fakeRoute):
//
//   1. MockPlayer queue semantics — per-taskKind queues stay independent, '*' serves any
//      taskKind without its own queue, an exhausted named queue does NOT fall through to '*',
//      `default` answers once every queue is empty, and no default ⇒ undefined (legacy fake).
//   2. Full-loop integration — TIERMUX_FAKE_MODEL=1 + a fixture file drives the REAL runTurn()
//      with a REAL Router: a native tool call executes, a text-dialect response is rescued into
//      a real call (the weak-model failure shape the loop must survive), and the final text
//      becomes the answer. Zero network, zero tokens.
//   3. Cassette round-trip — CassetteRecorder writes a JSON cassette, cassetteToFixture() turns
//      it back into a replayable fixture with tool calls and args intact.
//
// Run: npm run test:e2e:mock-fixture
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTurn } from '../src/agent/core/loop';
import { setGates } from '../src/agent/core/tools/gates';
import { CommandGate, type CommandApproval } from '../src/edits/commandGate';
import { EditGate } from '../src/edits/applyEdit';
import { Router } from '../src/router/router';
import type { SecretStore } from '../src/config/secrets';
import type { SettingsStore } from '../src/config/settingsStore';
import type { Catalog } from '../src/catalog/catalog';
import type { UsageTracker } from '../src/config/usage';
import { createMockPlayer, cassetteToFixture, type MockFixture } from '../src/router/mockFixture';
import type { AgentOpts } from '../src/agent/agent';
import type { Router as IRouter } from '../src/router/router';

let failures = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

// --- 1. MockPlayer queue semantics ---
function playerTests() {
  const fixture: MockFixture = {
    version: 1,
    steps: [
      { taskKind: 'agent', tool: 'readFile', args: { path: 'a' } },
      { taskKind: 'agent', text: 'agent done' },
      { taskKind: 'reasoning', text: 'sub-agent report' },
      { taskKind: '*', text: 'any-queue answer' },
    ],
    default: { text: '[default]' },
  };
  const p = createMockPlayer(fixture);

  // Interleave the two named queues — each plays its own script, in order.
  ok('agent queue plays its tool step', p.next('agent')?.respond.tool === 'readFile');
  ok('reasoning queue plays independently of agent', p.next('reasoning')?.respond.text === 'sub-agent report');
  ok('agent queue continues after the sub-agent interleaved', p.next('agent')?.respond.text === 'agent done');

  // An exhausted NAMED queue must not fall through to '*' — the script said agent is done.
  ok('exhausted named queue hits default, not the * queue', p.next('agent')?.respond.text === '[default]');

  // A taskKind with no queue of its own is served by '*'.
  ok('missing queue falls back to *', p.next('coding')?.respond.text === 'any-queue answer');
  // '*' now exhausted too → default.
  ok('fallback queue exhausted → default', p.next('coding')?.respond.text === '[default]');

  const noDefault = createMockPlayer({ version: 1, steps: [{ taskKind: 'agent', text: 'only' }] });
  noDefault.next('agent');
  ok('no default and exhausted → undefined (legacy fake behavior takes over)', noDefault.next('agent') === undefined);
}

// --- 2. Full-loop integration through the real Router + runTurn ---
async function integrationTest() {
  process.env.TIERMUX_FAKE_MODEL = '1';
  // Fresh temp workspace + a fixture scripted against it. Set BEFORE the first getMockPlayer()
  // call so the singleton loads this file, not a stray .tiermux/mock/fixture.json.
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-mockfixture-e2e-'));
  fs.writeFileSync(path.join(workspaceRoot, 'README.md'), '# temp project\n');
  fs.writeFileSync(path.join(workspaceRoot, 'package.json'), '{ "name": "temp" }\n');
  const fixturePath = path.join(workspaceRoot, 'fixture.json');
  fs.writeFileSync(fixturePath, JSON.stringify({
    version: 1,
    steps: [
      { taskKind: 'agent', tool: 'readFile', args: { path: 'README.md' } },
      { taskKind: 'agent', dialect: '<function=readFile>{"path": "package.json"}</function>' },
      { taskKind: 'agent', text: 'Read both files — mock turn complete.' },
    ],
  }));
  process.env.TIERMUX_MOCK_FIXTURE = fixturePath;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot, path: workspaceRoot } }];

  const commandGate = new CommandGate(() => 'always' as CommandApproval, () => 5000, () => []);
  const editGate = new EditGate(() => false);
  setGates(editGate, commandGate);
  (globalThis as any).__tiermuxTestConfig = { mixturePipeline: 'off', verifyCommand: 'off' };

  // Real Router over stub stores (same shape as scripts/bench/routerHarness.ts) — route()
  // short-circuits to fakeRoute before any of these are consulted, but construction needs them.
  const catalog: Partial<Catalog> = { find: () => undefined };
  const settings: Partial<SettingsStore> = { enabledByPriority: () => [], getCustomEndpoints: () => [], getEndpoint: () => undefined };
  const secrets: Partial<SecretStore> = {
    cooldownRemaining: () => 0, resolveKey: async () => 'keyless', isToolIncompatible: () => false,
    isDeprecated: () => false, setStatus: () => {}, setCooldownForKey: () => {}, setCooldown: () => {},
    keyCooldownRemaining: () => 0, getKeys: async () => [], markToolIncompatible: () => {}, markDeprecated: () => {},
    // routerProvider's dialect-rescue path records a tool-soft-failure strike on the serving
    // model — without this stub the strike call throws and kills the stream mid-rescue.
    noteToolSoftFailure: () => {},
  };
  const usage: Partial<UsageTracker> = { add: () => {} };
  const router = new Router(secrets as SecretStore, settings as SettingsStore, catalog as Catalog, usage as UsageTracker);

  const toolEvents: Array<{ name: string; state: string }> = [];
  const opts: AgentOpts = {
    messages: [{ role: 'user', content: 'read the project files' }],
    mode: 'agent',
    effort: 'medium',
    onChunk: () => {},
    onTool: (e) => toolEvents.push({ name: e.name, state: e.state }),
    onReasoning: () => {},
    onModel: () => {},
    onFailover: () => {},
    onStep: () => {},
    onTodos: () => {},
    onAskUser: async () => '',
    onError: (m) => console.error('onError:', m),
  };

  const result = await runTurn(router, opts);

  const readFileRuns = toolEvents.filter((e) => e.name === 'readFile' && e.state === 'running');
  ok('native scripted tool call actually executed', readFileRuns.length >= 1);
  ok('dialect (<function=…>) response was rescued into a real tool call', readFileRuns.length >= 2,
    `readFile running events: ${readFileRuns.length}`);
  ok('final scripted text became the answer', result.text.includes('mock turn complete'), `text="${result.text.slice(0, 120)}"`);
  ok('no budget/stuck stop in a scripted happy path', !result.stopReason, `stopReason=${result.stopReason}`);
}

// --- 3. Cassette record → fixture replay round-trip ---
function cassetteTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-cassette-e2e-'));
  const cassettePath = path.join(dir, 'cassette.json');
  fs.writeFileSync(cassettePath, JSON.stringify({
    version: 1,
    entries: [
      {
        taskKind: 'agent',
        tools: ['readFile', 'editFile'],
        lastRole: 'user',
        response: {
          id: 'x', object: 'chat.completion', created: 0, model: 'real-model',
          choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'readFile', arguments: '{"path":"src/a.ts"}' } },
          ] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      },
      {
        taskKind: 'agent',
        lastRole: 'tool',
        response: {
          id: 'y', object: 'chat.completion', created: 0, model: 'real-model',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Fixed.' } }],
          usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
        },
      },
    ],
  }));

  const fixture = cassetteToFixture(cassettePath);
  ok('cassette converts to a fixture with steps', !!fixture && fixture.steps.length === 2);
  ok('recorded tool call survived as a scripted tool step',
    fixture?.steps[0].respond?.tool === 'readFile' && JSON.stringify(fixture?.steps[0].respond?.args) === JSON.stringify({ path: 'src/a.ts' }));
  ok('recorded final text survived as a text step', fixture?.steps[1].respond?.text === 'Fixed.');

  const p = fixture ? createMockPlayer(fixture) : undefined;
  ok('replayed cassette answers through the player', p?.next('agent')?.respond.tool === 'readFile');
}

async function main() {
  playerTests();
  await integrationTest();
  cassetteTest();
  console.log(failures ? `\n${failures} FAIL` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

void main();
