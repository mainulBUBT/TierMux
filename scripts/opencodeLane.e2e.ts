// OpenCode free-lane contract, end to end against a mock Zen: every request on
// the lane carries the official-client costume (opencode/ UA, gate-shaped
// x-opencode-session, per-call request id), the body streams with the two
// decoy tools the gate requires, and a non-streaming caller gets the forced
// stream folded back into one completion. A provider WITHOUT the lane must
// stay untouched. LIVE=1 replays the streaming half against the real Zen.
// Run: npm run test:e2e:opencode-lane   (LIVE=1 for the real upstream)

import { createServer } from 'http';
import { OpenAICompatProvider } from '../src/providers/openai-compat';
import { foldSseToCompletion, shapeOpenCodeRequest } from '../src/providers/opencodeLane';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : ` — ${d}`}`);
  if (!c) bad++;
};

interface Captured { headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }
const captured: Captured[] = [];

const SSE =
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"po"}}]}\n\n' +
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ng"}}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n' +
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n';

async function main(): Promise<void> {
  const live = Boolean(process.env.LIVE);
  const port = await new Promise<number>((resolve) => {
    const srv = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        captured.push({ headers: req.headers, body });
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(SSE);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv.address()!.port));
  });

  const lane = new OpenAICompatProvider({
    platform: 'opencode', name: 'OpenCode Zen',
    baseUrl: live ? 'https://opencode.ai/zen/v1' : `http://127.0.0.1:${port}/v1`,
    keyless: true, skipPreflight: true, opencodeFreeLane: true,
  });
  const model = live ? 'big-pickle' : 'mock-free';
  const msg = [{ role: 'user' as const, content: 'Reply with exactly one word: pong' }];

  /* ---- streaming through the lane ---- */
  {
    let text = '';
    for await (const c of lane.streamChatCompletion('', msg, model, { sessionId: 'conv-1', max_tokens: 64 })) {
      text += c.choices?.[0]?.delta?.content ?? '';
    }
    ok(live ? 'live streaming answered' : 'streaming yields the folded text', text.includes('pong'), `got "${text.slice(0, 40)}"`);
  }

  if (!live) {
    const first = captured[0];
    const h = (k: string) => String(first.headers[k] ?? '');
    ok('UA wears the opencode/ costume', h('user-agent').startsWith('opencode/'), h('user-agent'));
    ok('session id has the gate shape', /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(h('x-opencode-session')), h('x-opencode-session'));
    ok('per-call request id sent', /^msg_/.test(h('x-opencode-request')), h('x-opencode-request'));
    ok('body streams', first.body.stream === true);
    const names = ((first.body.tools as Array<{ function: { name: string } }>) ?? []).map((t) => t.function.name).sort();
    ok('decoy tools ride along', JSON.stringify(names) === '["bash","read"]', JSON.stringify(names));
    ok('decoys pinned off without caller tools', first.body.tool_choice === 'none');

    /* ---- session stability, request-id freshness ---- */
    await lane.chatCompletion('', msg, model, { sessionId: 'conv-1', max_tokens: 64 });
    await lane.chatCompletion('', msg, model, { sessionId: 'conv-2', max_tokens: 64 });
    const s = (i: number) => String(captured[i].headers['x-opencode-session']);
    const r = (i: number) => String(captured[i].headers['x-opencode-request']);
    ok('same conversation, same session', s(1) === s(0));
    ok('different conversation, different session', s(2) !== s(0));
    ok('request ids are per-call', r(1) !== r(0));

    /* ---- non-stream callers get the folded answer ---- */
    const folded = await lane.chatCompletion('', msg, model, { sessionId: 'conv-1', max_tokens: 64 });
    ok('folded content is the whole stream', folded.choices[0].message.content === 'pong', JSON.stringify(folded.choices[0].message.content));
    ok('folded finish reason kept', folded.choices[0].finish_reason === 'stop');

    /* ---- caller tools survive, decoys do not override ---- */
    const callerTool = { type: 'function' as const, function: { name: 'shell', description: 'run', parameters: { type: 'object' as const, properties: {} } } };
    await lane.chatCompletion('', msg, model, { sessionId: 'conv-3', max_tokens: 64, tools: [callerTool] });
    const sent = (captured[captured.length - 1].body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name).sort();
    ok('caller tool kept, decoys appended', JSON.stringify(sent) === '["bash","read","shell"]', JSON.stringify(sent));
    ok("caller's tool_choice spelling kept", captured[captured.length - 1].body.tool_choice === undefined);

    /* ---- a provider without the lane is untouched ---- */
    const plain = new OpenAICompatProvider({ platform: 'llm7', name: 'LLM7', baseUrl: `http://127.0.0.1:${port}/v1`, keyless: true });
    const before = captured.length;
    await plain.chatCompletion('', msg, 'mock-free', { sessionId: 'conv-1', max_tokens: 64 });
    const p = captured[before];
    ok('plain provider keeps its own UA', String(p.headers['user-agent']).startsWith('tiermux/'));
    ok('plain provider sends no session costume', p.headers['x-opencode-session'] === undefined);
    ok('plain provider is not forced to stream', p.body.stream === undefined);

    /* ---- unit: no duplicate decoys, split tool-call arguments merge ---- */
    const shaped = shapeOpenCodeRequest({ tools: [callerTool, { type: 'function', function: { name: 'bash', description: 'real', parameters: { type: 'object', properties: {} } } }] } as Record<string, unknown>);
    const shapedNames = (shaped.tools as Array<{ function: { name: string } }>).map((t) => t.function.name).sort();
    ok('no duplicate bash when the caller ships one', JSON.stringify(shapedNames) === '["bash","read","shell"]', JSON.stringify(shapedNames));

    const foldedCalls = foldSseToCompletion(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"shell","arguments":"{\\"cmd\\":"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
      'data: [DONE]\n\n', 'm');
    const tc = foldedCalls.choices[0].message.tool_calls?.[0];
    ok('tool-call fragments join across frames', tc?.function.name === 'shell' && tc?.function.arguments === '{"cmd":"ls"}',
      `${tc?.function.name} ${tc?.function.arguments}`);
  }

  console.log(bad === 0 ? '\nall opencode-lane checks passed' : `\n${bad} check(s) FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('e2e crashed:', e);
  process.exit(1);
});
