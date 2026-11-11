/* The bun shim (src/providers/bunTransport.ts): a keyless OpenCode lane request rides a local
 *  `bun -e` child because Zen's gate admits only that network family. This exercises the
 *  transport against a mock server — status/headers/body round-trip, streaming in more than
 *  one chunk, error statuses, timeout parity, abort, the meta+body-same-chunk edge, and the
 *  provider actually routing the lane through it (call counter) with a sane fallback when bun
 *  is absent. Every bun-dependent check is skipped (not failed) when bun is not installed.
 *  Run: npm run test:e2e:bun-shim   (TIERMUX_BUN=/path/to/bun to point at one off-PATH) */

import { createServer } from 'http';

import { bunFetch, bunShimCallCount, isBunAvailable, __resetBunShimCallCount } from '../src/providers/bunTransport';
import { OpenAICompatProvider } from '../src/providers/openai-compat';

let bad = 0;
let skipped = 0;
const ok = (n: string, c: boolean, d = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : ` — ${d}`}`);
  if (!c) bad++;
};
const skip = (n: string) => { console.log(`SKIP  ${n} (no bun on this machine)`); skipped++; };

const SSE_CHUNKS = [
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"po"}}]}\n\n',
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ng"}}]}\n\n',
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
];

async function main(): Promise<void> {
  /* A mock server that can drip its SSE body one chunk per tick, so incremental streaming is
   *  observable, and can answer before the client could possibly have buffered everything. */
  let drip = false;
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      if (body.model === 'mock-wait-forever') { /* never answer: the timeout path */ return; }
      // Sends the SSE headers and one chunk, then holds the connection open forever: the
      // transport's body-idle guard must abort it (the engine's stall gates are disarmed for
      // pinned models, so nothing else would).
      if (body.model === 'mock-stall') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(SSE_CHUNKS[0]);
        return;
      }
      if (body.model === 'mock-500') {
        res.writeHead(500, { 'content-type': 'application/json', 'x-probe': 'kept' });
        res.end(JSON.stringify({ error: { message: 'boom' } }));
        return;
      }
      if (body.model === 'mock-sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (!drip) { res.end(SSE_CHUNKS.join('')); return; }
        let i = 0;
        const timer = setInterval(() => {
          if (i >= SSE_CHUNKS.length) { clearInterval(timer); res.end(); return; }
          res.write(SSE_CHUNKS[i++]);
        }, 120);
        return;
      }
      if (body.stream) {
        // The lane always streams (the gate's body fingerprint demands it) — answer in kind.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(SSE_CHUNKS.join(''));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  const port = await new Promise<number>((resolve) => srv.listen(0, '127.0.0.1', () => resolve((srv.address() as { port: number }).port)));
  const base = `http://127.0.0.1:${port}/v1`;
  const post = (model: string) => JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] });

  const haveBun = await isBunAvailable();
  if (!haveBun) {
    console.log('bun is not installed here — running only the bun-independent checks.\n');
  }

  /* ---- bun-independent: the provider works without the shim (direct fetch) ---- */
  const lane = new OpenAICompatProvider({ platform: 'opencode', name: 'OpenCode Zen', baseUrl: base, keyless: true, keyOptional: true, skipPreflight: true, sessionHeader: 'x-opencode-session', opencodeFreeLane: true });
  const plain = await lane.chatCompletion('', [{ role: 'user', content: 'hi' }], 'mock-free', { sessionId: 'conv-1', max_tokens: 8, timeoutMs: 10_000 });
  ok('provider answers with the shim unavailable/direct', plain.choices[0].message.content === 'pong', JSON.stringify(plain.choices[0].message.content));

  /* ---- a missing bun binary must reject promptly, never hang (live 2026-11-11: the dev
   *  host's 42-minute "Orchestra…" turn was `spawn bun ENOENT` with no error listener, so the
   *  request promise never settled) ---- */
  process.env.TIERMUX_BUN = '/nonexistent/tiermux-test-bun';
  const goneStart = Date.now();
  let goneErr: unknown = null;
  try {
    const gone = await bunFetch({ url: `${base}/chat/completions`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: post('mock-free'), timeoutMs: 10_000 }, 'test');
    await gone.text(); // it must not come to this
  } catch (e) { goneErr = e; }
  const goneMs = Date.now() - goneStart;
  ok('a missing bun binary rejects, not hangs', goneErr instanceof Error && /could not start/.test(goneErr.message), `${goneErr ?? 'resolved cleanly'}`);
  ok('…within seconds, not the hard timeout', goneMs < 5000, `${goneMs}ms`);
  // …and the lane degrades to the direct fetch instead of dying with it
  const viaFallback = await lane.chatCompletion('', [{ role: 'user', content: 'hi' }], 'mock-free', { sessionId: 'conv-gone', max_tokens: 8, timeoutMs: 10_000 });
  ok('the lane falls back to direct when the shim cannot start', viaFallback.choices[0].message.content === 'pong', JSON.stringify(viaFallback.choices[0].message.content));
  delete process.env.TIERMUX_BUN;

  if (!haveBun) {
    skip('bunFetch round-trips status, headers and body');
    skip('bunFetch streams incrementally');
    skip('an error status comes back as a Response, not a throw');
    skip('a never-answering server times out as a 408 ProviderHttpError');
    skip('aborting kills the child and rejects');
    skip('meta line and body on the same stdout chunk');
    skip('a stalled body is cut by the idle guard');
    skip('the lane provider routes through the shim');
  } else {
    __resetBunShimCallCount();

    /* ---- status/headers/body round-trip ---- */
    const r1 = await bunFetch({ url: `${base}/chat/completions`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: post('mock-free'), timeoutMs: 10_000 }, 'test');
    ok('status round-trips', r1.status === 200, String(r1.status));
    ok('content-type round-trips', (r1.headers.get('content-type') ?? '').includes('application/json'), String(r1.headers.get('content-type')));
    const j1 = await r1.json() as { choices?: Array<{ message?: { content?: string } }> };
    ok('body round-trips', j1.choices?.[0]?.message?.content === 'pong', JSON.stringify(j1.choices?.[0]?.message?.content));

    /* ---- incremental streaming ---- */
    drip = true;
    const r2 = await bunFetch({ url: `${base}/chat/completions`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: post('mock-sse'), timeoutMs: 10_000 }, 'test');
    const reader = r2.body!.getReader();
    const arrivalTimes: number[] = [];
    const t0 = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivalTimes.push(Date.now() - t0);
    }
    const text = SSE_CHUNKS.join('');
    ok('dripped SSE body arrives complete', arrivalTimes.length >= 3, `${arrivalTimes.length} reads`);
    ok('…and incrementally, not as one buffered blob', arrivalTimes.length >= 3 && arrivalTimes[1] >= 80, `reads at ${arrivalTimes.join('ms,')}ms`);
    drip = false;

    /* ---- error status is a Response, not a throw ---- */
    let errStatus = 0;
    let probeHeader = '';
    let errBody = '';
    try {
      const r3 = await bunFetch({ url: `${base}/chat/completions`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: post('mock-500'), timeoutMs: 10_000 }, 'test');
      errStatus = r3.status;
      probeHeader = r3.headers.get('x-probe') ?? '';
      errBody = await r3.text();
    } catch { errStatus = -1; }
    ok('a 500 comes back as a Response (the caller judges res.ok)', errStatus === 500, String(errStatus));
    ok('custom response headers survive', probeHeader === 'kept', probeHeader);
    ok('the error body survives', errBody.includes('boom'), errBody.slice(0, 60));

    /* ---- timeout parity: 408 ProviderHttpError ---- */
    let timeoutErr: (Error & { status?: number }) | null = null;
    try {
      const r4 = await bunFetch({ url: `${base}/chat/completions`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: post('mock-wait-forever'), timeoutMs: 700 }, 'OpenCode Zen');
      await r4.text(); // headers never arrive; the promise itself must throw
    } catch (e) { timeoutErr = e as Error & { status?: number }; }
    ok('a never-answering server times out', !!timeoutErr && /timed out/.test(timeoutErr.message), timeoutErr?.message ?? 'no throw');
    ok('…as a 408 ProviderHttpError, like the direct path', timeoutErr?.status === 408, String(timeoutErr?.status));

    /* ---- abort ---- */
    const ac = new AbortController();
    let abortErr: unknown = null;
    const pending = bunFetch({ url: `${base}/chat/completions`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: post('mock-wait-forever'), timeoutMs: 30_000 }, 'test', ac.signal).catch((e) => (abortErr = e));
    setTimeout(() => ac.abort(new Error('user stopped the turn')), 150);
    await pending;
    ok('aborting rejects promptly', abortErr instanceof Error || abortErr !== null, String(abortErr));

    /* ---- meta and body on the same stdout chunk (the small-response edge) ---- */
    const r5 = await bunFetch({ url: `${base}/chat/completions`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: post('mock-free'), timeoutMs: 10_000 }, 'test');
    const j5 = await r5.json() as { choices?: Array<{ message?: { content?: string } }> };
    ok('body bytes sharing the meta chunk are not lost', j5.choices?.[0]?.message?.content === 'pong', JSON.stringify(j5.choices?.[0]?.message?.content));

    /* ---- a body that starts then goes silent is cut by the idle guard ----
     * The engine's stall gates are disarmed for pinned models, so a held-open stream would
     * hang a pinned turn forever (live repro 2026-11-11: 22 minutes and counting). */
    const stallStart = Date.now();
    let stallErr: unknown = null;
    let stallGot = 0;
    try {
      const r6 = await bunFetch({ url: `${base}/chat/completions`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: post('mock-stall'), timeoutMs: 30_000, bodyIdleMs: 1200 }, 'test');
      const reader6 = r6.body!.getReader();
      for (;;) {
        const { done, value } = await reader6.read();
        if (done) break;
        stallGot += value.length;
      }
    } catch (e) { stallErr = e; }
    const stallMs = Date.now() - stallStart;
    ok('a stalled body errors instead of hanging forever', stallErr !== null, `read ended cleanly after ${stallMs}ms with ${stallGot} bytes`);
    ok('…within the idle window, not the 30s timeout', stallMs < 5000, `${stallMs}ms`);
    // …while chunks arriving steadily keep a slow-but-live stream alive under the same guard
    const r7 = await bunFetch({ url: `${base}/chat/completions`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: post('mock-sse'), timeoutMs: 10_000, bodyIdleMs: 1000 }, 'test');
    const s7 = await r7.text();
    ok('a live stream outlives the idle guard (each chunk resets it)', s7.includes('"po') && s7.includes('[DONE]'), s7.slice(0, 40));

    /* ---- the provider really routes the lane through the shim ---- */
    __resetBunShimCallCount();
    const viaLane = await lane.chatCompletion('', [{ role: 'user', content: 'hi' }], 'mock-free', { sessionId: 'conv-shim', max_tokens: 8, timeoutMs: 10_000 });
    ok('the keyless lane went through the shim', bunShimCallCount() === 1, `shim calls: ${bunShimCallCount()}`);
    ok('…and still answers through it', viaLane.choices[0].message.content === 'pong', JSON.stringify(viaLane.choices[0].message.content));

    let streamed = '';
    for await (const c of lane.streamChatCompletion('', [{ role: 'user', content: 'hi' }], 'mock-free', { sessionId: 'conv-shim', max_tokens: 8, timeoutMs: 10_000 })) {
      streamed += c.choices?.[0]?.delta?.content ?? '';
    }
    ok('streaming goes through the shim too (2nd call)', bunShimCallCount() === 2, `shim calls: ${bunShimCallCount()}`);

    /* ---- keyed requests stay direct ---- */
    const keyed = new OpenAICompatProvider({ platform: 'opencode', name: 'OpenCode Zen', baseUrl: base, keyless: true, keyOptional: true, skipPreflight: true, sessionHeader: 'x-opencode-session', opencodeFreeLane: true });
    __resetBunShimCallCount();
    await keyed.chatCompletion('zen-key', [{ role: 'user', content: 'hi' }], 'mock-free', { sessionId: 'conv-keyed', max_tokens: 8, timeoutMs: 10_000 });
    ok('a keyed request never touches the shim', bunShimCallCount() === 0, `shim calls: ${bunShimCallCount()}`);
    void streamed;
  }

  srv.close();
  console.log(bad === 0
    ? `\nall bun-shim checks passed${skipped ? ` (${skipped} skipped — no bun installed)` : ''}`
    : `\n${bad} check(s) FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('e2e crashed:', e);
  process.exit(1);
});
