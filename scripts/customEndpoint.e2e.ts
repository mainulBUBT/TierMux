/* A custom OpenAI-compatible endpoint really serves a turn: the request reaches that URL, with the
 * upstream model id and the endpoint's key. Before 2026-11-04 the request path never saw the saved
 * endpoints, so a pinned one failed with "could not run" and no request left the machine.
 * Run: npm run test:e2e:custom-endpoint */
import * as http from 'node:http';
import { createRouterProvider } from '../src/agent/core/routerProvider';
import { setModelSources } from '../src/router/picker';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d.slice(0, 240)})` : ''}`); if (!c) bad++; };

const hits: Array<{ url?: string; auth?: string; model?: string }> = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    hits.push({ url: req.url, auth: req.headers.authorization, model: (JSON.parse(body || '{}') as { model?: string }).model });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
});

async function turn(over: Record<string, unknown>) {
  hits.length = 0;
  let text = '';
  let error = '';
  try {
    const r = await createRouterProvider({ taskKind: 'chat', ...over }).doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] } as never);
    const reader = (r as { stream: ReadableStream }).stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const v = value as { type?: string; delta?: string };
      if (v.type === 'text-delta') text += v.delta;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { text, error };
}

server.listen(0, async () => {
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const ep = (id: string) => ({ id, name: id, baseUrl, type: 'openai-chat', models: [{ id: 'my-model' }], createdAt: 1 });
  const entry = { platform: 'custom', modelId: 'c_key::my-model', enabled: true, priority: 0 };
  setModelSources({
    catalog: { find: () => undefined },
    settings: { getFallback: () => [entry], getDisabledProviders: () => [], enabledByPriority: () => [entry], getCustomEndpoints: () => [ep('c_key'), ep('c_open')] },
    secrets: {
      getKeys: async () => [], getCloudflareAccountId: async () => undefined, isToolIncompatible: () => false,
      getCustomKey: async (id: string) => (id === 'c_key' ? 'sk-custom' : undefined), getCustomModelKey: async () => undefined,
    },
  } as never);

  const pinned = await turn({ pinnedModel: 'custom::c_key::my-model' });
  ok('a pinned custom model serves the turn', pinned.text === 'hi', JSON.stringify(pinned));
  ok('the request carries the upstream id and the key', hits[0]?.url === '/v1/chat/completions' && hits[0]?.model === 'my-model' && hits[0]?.auth === 'Bearer sk-custom', JSON.stringify(hits));

  const auto = await turn({});
  ok('Auto can route to a ticked custom model', auto.text === 'hi' && hits.length === 1, JSON.stringify(auto));

  const open = await turn({ pinnedModel: 'custom::c_open::my-model' });
  ok('an endpoint with no key works and sends no auth header', open.text === 'hi' && hits[0]?.auth === undefined, JSON.stringify(hits));

  const gone = await turn({ pinnedModel: 'custom::c_gone::my-model' });
  ok('a removed endpoint fails with a reason', !gone.text && gone.error.length > 0 && hits.length === 0, JSON.stringify(gone));

  console.log(bad === 0 ? '\nCustom endpoints hold.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
});
