// Attachment delivery contract: an image attached to a PINNED vision-capable model must
// physically reach the model request — user content `image_url` block → toUserContent
// FilePart → routerProvider → router.route() request body. Answers "did the attachment
// even get sent?" with a captured request instead of a guess.
//
// Run: npm run test:e2e:attach-delivery
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

const IMG_URL = 'data:image/png;base64,ICAGIHBORw==';

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-attach-e2e-'));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot, path: workspaceRoot } }];
  setGates(new EditGate(() => false), new CommandGate(() => 'always', () => 5000, () => []));

  const captured: Array<{ request: unknown; opts: Record<string, unknown> }> = [];
  const router = {
    async route(request: unknown, opts: Record<string, unknown> = {}) {
      captured.push({ request, opts });
      return {
        platform: 'testp', model: 'visionM',
        response: {
          id: 'r', object: 'chat.completion' as const, created: 0, model: 'visionM',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant' as const, content: 'I can see the image — it is a red square.' } }],
        },
      };
    },
    peekTopSelection: () => ({ entry: { platform: 'testp', modelId: 'visionM', enabled: true, priority: 0 }, model: { intelligenceRank: 1, contextWindow: 100_000, supportsVision: true } }),
    async pickUtilityModel() { return undefined; },
    async pickClassifierModel() { return undefined; },
  } as unknown as Router;

  const opts: AgentOpts = {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'explain this' },
        { type: 'image_url', image_url: { url: IMG_URL, mime: 'image/png', filename: 'shot.png' } },
      ] as never,
    }],
    mode: 'ask',
    pinnedModel: 'testp::visionM', // PINNED vision-capable model
    effort: 'medium',
    onChunk: () => {}, onTool: () => {}, onReasoning: () => {}, onModel: () => {},
    onFailover: () => {}, onStep: () => {}, onTodos: () => {}, onAskUser: async () => '',
    onError: () => {},
  };
  const result = await runTurn(router, opts);

  ok('turn completed', result.text.includes('red square'));
  ok('routed as a vision task', result.taskKind === 'vision');
  ok('exactly one model call (pinned model served it)', captured.length === 1);

  const req = JSON.stringify(captured[0]?.request ?? []);
  ok('image_url block reached the model request', req.includes('image_url'));
  ok('the image DATA reached the model request', req.includes(encodeURIComponent(IMG_URL).replace(/%3A/g, ':')) || req.includes('ICAGIHBORw'));
  ok('image mime preserved', req.includes('image/png'));
  ok('pinned model requested (not auto)', captured[0]?.opts.model === 'testp::visionM');

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
