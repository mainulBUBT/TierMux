// Live-turn routing contract: after a step that issued tool calls, the NEXT step's answer
// must stream to the CHAT channel (onChunk) — never to reasoning. Regression lock for the
// phase-machine fix (start-step now retires 'planning'); before it, a tool-using turn's
// whole reply hid inside the collapsed Thinking block and the live chat showed nothing.
//
// Also exports the recorded callback stream (+ result) to /tmp/live-turn-events.json so the
// jsdom webview harness (webviewLiveTurn.js) can replay the EXACT host→webview sequence.
//
// Run: npm run test:e2e:live-turn
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

function makeScriptedRouter(script: Array<{ platform: string; model: string; response?: unknown; streamFirst?: string }>) {
  let n = 0;
  const router = {
    async route(_request: unknown, opts: Record<string, unknown> = {}) {
      const step = script[n++];
      if (!step) throw new Error('scripted router exhausted');
      // Real streaming providers deliver narration deltas through route()'s onChunk as they
      // land; mirror that so the loop sees the same shape a live turn produces.
      if (step.streamFirst) (opts.onChunk as ((t: string) => void) | undefined)?.(step.streamFirst);
      return { platform: step.platform, model: step.model, response: step.response };
    },
    peekTopSelection: () => ({ entry: { platform: 'testp', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1, contextWindow: 100_000 } }),
    async pickUtilityModel() { return undefined; },
  };
  return { router: router as unknown as Router };
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-live-turn-e2e-'));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot, path: workspaceRoot } }];
  setGates(new EditGate(() => false), new CommandGate(() => 'always', () => 5000, () => []));

  const NARRATION = 'Let me check the workspace first.';
  const ANSWER = 'FINAL_ANSWER_MARKER The workspace check is complete — nothing to report.';
  const { router } = makeScriptedRouter([
    { platform: 'testp', model: 'mA', streamFirst: NARRATION, response: baseResponse({ tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: 'echo probe' }) } }] }) },
    { platform: 'testp', model: 'mA', response: baseResponse({ content: ANSWER }) },
  ]);

  const chunks: string[] = [];
  const reasoning: string[] = [];
  const toolEvents: Array<{ name: string; state: string; detail?: string }> = [];
  let retracted = false;
  const opts: AgentOpts = {
    messages: [{ role: 'user', content: 'check the workspace' }],
    mode: 'agent',
    effort: 'medium',
    onChunk: (t) => chunks.push(t),
    onReasoning: (t) => reasoning.push(t),
    onTool: (e) => toolEvents.push({ name: e.name, state: e.state, detail: e.detail }),
    onRetractDraft: () => { retracted = true; },
    onModel: () => {}, onFailover: () => {}, onStep: () => {}, onTodos: () => {},
    onAskUser: async () => '', onError: () => {},
  };
  const result = await runTurn(router, opts);

  const chat = chunks.join('');
  const thought = reasoning.join('');
  ok('tool ran and completed', toolEvents.includes('runCommand:running' as never) || toolEvents.some((e) => e.name === 'runCommand' && e.state === 'done'));
  ok('post-tool answer streamed to the CHAT channel (onChunk)', chat.includes('FINAL_ANSWER_MARKER'));
  ok('post-tool answer NOT misrouted to reasoning', !thought.includes('FINAL_ANSWER_MARKER'));
  ok('pre-tool narration went to reasoning (draft retro-routed)', thought.includes('Let me check the workspace first.'));
  ok('draft retraction fired when the tool call landed', retracted);
  ok('result.text carries the answer', result.text.includes('FINAL_ANSWER_MARKER'));

  // Export the exact callback stream for the jsdom webview harness.
  fs.writeFileSync('/tmp/live-turn-events.json', JSON.stringify({
    userText: 'check the workspace',
    chunks, reasoning, toolEvents, retracted,
    result: { text: result.text, reasoning: result.reasoning, platform: result.platform, model: result.model },
  }));
  console.log('events exported to /tmp/live-turn-events.json');
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
