/* routerProvider adopts tool calls a reply wrote as text — on an ordinary 200 stream, not only on
 * Groq's failed_generation path — and fills a split call's missing keys from its text. Drives the
 * real doStream against a scripted SSE body. Run: npm run test:e2e:inline-adopt-stream */
import { createRouterProvider } from '../src/agent/core/routerProvider';
import { setModelSources, recordOutcome } from '../src/router/picker';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d.slice(0, 220)})` : ''}`); if (!c) bad++; };

let sse = '';
const chunk = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
globalThis.fetch = (async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;

setModelSources({
  catalog: { find: () => ({ intelligenceRank: 1, speedRank: 1, supportsTools: true }) },
  settings: {
    getFallback: () => [{ platform: 'groq', modelId: 'm', enabled: true, priority: 0 }],
    getDisabledProviders: () => [],
    enabledByPriority: () => [{ platform: 'groq', modelId: 'm', enabled: true, priority: 0 }],
  },
  secrets: { getKeys: async () => ['sk-test'], getCloudflareAccountId: async () => undefined, isToolIncompatible: () => false },
} as never);
recordOutcome('groq', 'm', true);

const TOOLS = [
  { type: 'function', name: 'readFile', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { type: 'function', name: 'exitPlanMode', description: 'plan', inputSchema: { type: 'object', properties: {
    outcome: { type: 'string' }, title: { type: 'string' }, interpretation: { type: 'string' },
    steps: { type: 'array', items: { type: 'object', properties: { what: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } } } },
  } } },
];

async function toolCalls(): Promise<Array<{ toolName: string; input: string }>> {
  const r = await createRouterProvider({ taskKind: 'agent' }).doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], tools: TOOLS } as never);
  const reader = (r as { stream: ReadableStream }).stream.getReader();
  const calls: Array<{ toolName: string; input: string }> = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const v = value as { type?: string; toolName?: string; input?: string };
    if (v.type === 'tool-call') calls.push({ toolName: v.toolName!, input: v.input! });
  }
  return calls;
}

async function main() {
  console.log('— a text-only tool call on a 200 stream runs —');
  sse = chunk({ role: 'assistant', content: 'Reading it.\n<function=readFile>{"path":"src/a.ts"}</function>' }) + chunk({}, 'stop') + 'data: [DONE]\n\n';
  const a = await toolCalls();
  ok('becomes a real readFile call', a.length === 1 && a[0].toolName === 'readFile' && JSON.parse(a[0].input).path === 'src/a.ts', JSON.stringify(a));

  console.log('\n— a call split between the wire and the text is made whole —');
  sse = chunk({ role: 'assistant', content: '<parameter name="interpretation">Add discounts.</parameter>\n<parameter=steps>[{"what":"Parse it","files":["a.js"]}]</parameter>\n</invoke>' })
    + chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'exitPlanMode', arguments: '{"outcome":"plan","title":"T"}' } }] })
    + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
  const b = await toolCalls();
  const input = b[0] ? JSON.parse(b[0].input) : {};
  ok('exitPlanMode carries steps and interpretation', b.length === 1 && input.interpretation === 'Add discounts.' && input.steps?.[0]?.what === 'Parse it' && input.title === 'T', JSON.stringify(b));

  console.log('\n— a Harmony token leaked into a streamed tool name is stripped —');
  // pollinations openai-fast (gpt-oss) streamed `grep<|channel|>commentary`: every call was an unknown
  // tool and the turn looped to the bench's 10-minute cap (agentBench, 2026-10-12). sanitizeToolName
  // ran only on the non-streaming path.
  sse = chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'g1', type: 'function', function: { name: 'readFile<|channel|>commentary', arguments: '{"path":"src/a.ts"}' } }] })
    + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
  const h = await toolCalls();
  ok('the call reaches readFile', h.length === 1 && h[0].toolName === 'readFile', JSON.stringify(h));

  console.log('\n— ordinary prose stays prose —');
  sse = chunk({ role: 'assistant', content: 'The total is computed in invoice.js.' }) + chunk({}, 'stop') + 'data: [DONE]\n\n';
  ok('no tool call invented', (await toolCalls()).length === 0);

  console.log(bad === 0 ? '\nInline adoption on the stream holds.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main().catch((e) => { console.error('THREW:', e); process.exit(1); });
