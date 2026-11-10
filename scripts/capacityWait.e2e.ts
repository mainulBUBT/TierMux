/* When every model is cooling down, an Auto step waits for the first one back instead of killing the
 * turn. agentBench 2026-11-04: ovh announced "quota spent, 49s", kilo/opencode answered 429, a task
 * died 18s in and every later task failed in 0.0s. Real timers, so this takes about 40s.
 * Run: npm run test:e2e:capacity-wait */
import { createRouterProvider } from '../src/agent/core/routerProvider';
import { setModelSources, recordOutcome, noteRetryAfter } from '../src/router/picker';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d.slice(0, 200)})` : ''}`); if (!c) bad++; };

const SSE = `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
let statuses: number[] = [];
let drops = 0;
let requests = 0;
globalThis.fetch = (async () => {
  requests++;
  if (drops > 0) { drops--; throw new TypeError('fetch failed'); }
  const status = statuses.shift() ?? 200;
  return status === 200
    ? new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    : new Response('{"error":{"message":"rate limited"}}', { status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const entry = { platform: 'groq', modelId: 'm', enabled: true, priority: 0 };
setModelSources({
  catalog: { find: () => ({ intelligenceRank: 1, speedRank: 1, supportsTools: false }) },
  settings: { getFallback: () => [entry], getDisabledProviders: () => [], enabledByPriority: () => [entry] },
  secrets: { getKeys: async () => ['sk-test'], getCloudflareAccountId: async () => undefined, isToolIncompatible: () => false },
} as never);

async function step(over: Record<string, unknown> = {}, signal?: AbortSignal) {
  const waits: number[] = [];
  const t0 = Date.now();
  let text = '';
  let error: string | undefined;
  try {
    const r = await createRouterProvider({ taskKind: 'chat', onCapacityWait: (s) => waits.push(s), ...over }).doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], abortSignal: signal,
    } as never);
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
  return { text, error, waits, ms: Date.now() - t0 };
}

async function main() {
  recordOutcome('groq', 'm', true);
  noteRetryAfter('groq', 'm', 5_000);
  requests = 0;
  const a = await step();
  ok('an empty chain waits for the model that announced its window, then serves', a.text === 'ok' && a.ms >= 4_500 && requests === 1, JSON.stringify(a));
  ok('and tells the caller how long', a.waits.length === 1 && a.waits[0] <= 6, JSON.stringify(a.waits));

  recordOutcome('groq', 'm', true);
  statuses = [429];
  requests = 0;
  const b = await step();
  ok('a chain that fails mid-step waits out the cooldown and tries again', b.text === 'ok' && requests === 2 && b.waits.length === 1, JSON.stringify({ ...b, requests }));

  recordOutcome('groq', 'm', true);
  statuses = [429];
  const c = await step({ pinnedModel: 'groq::m' });
  ok('a pinned model does not wait', !!c.error && c.waits.length === 0 && c.ms < 3_000, JSON.stringify(c));

  recordOutcome('groq', 'm', true);
  drops = 1;
  requests = 0;
  const net = await step({ pinnedModel: 'groq::m' });
  ok('one network drop is retried, even on a pinned model', net.text === 'ok' && requests === 2 && net.ms < 5_000, JSON.stringify({ ...net, requests }));

  recordOutcome('groq', 'm', true);
  drops = 2;
  const net2 = await step({ pinnedModel: 'groq::m' });
  ok('a second drop in the step stops it', !!net2.error && drops === 0, JSON.stringify(net2));

  recordOutcome('groq', 'm', true);
  noteRetryAfter('groq', 'm', 8_000);
  const abort = new AbortController();
  setTimeout(() => abort.abort(new Error('stop')), 200);
  const d = await step({}, abort.signal);
  ok('Stop ends the wait at once', !!d.error && d.ms < 2_000, JSON.stringify(d));

  noteRetryAfter('groq', 'm', 3_600_000);
  recordOutcome('groq', 'm', true);
  const e = await step();
  ok('a window longer than the budget fails now instead of hanging', /no model candidate/.test(e.error ?? '') && e.waits.length === 0 && e.ms < 2_000, JSON.stringify(e));

  console.log(bad === 0 ? '\nCapacity wait holds.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main().catch((e) => { console.error('THREW:', e); process.exit(1); });
