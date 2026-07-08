// Regression test for the concurrent-session "topics get mixed" bug: sdk.ts's SSE
// listener used to let any event WITHOUT a sessionID sail through into every
// concurrently-open listener (`evSession && ocId && evSession !== ocId` only rejects
// when evSession is present and mismatched — a sessionID-less frame satisfied neither
// condition). Since `client.subscribe()` is ONE global SSE stream shared by every
// concurrently-running session (chatViewProvider.ts's acquireRunSlot() allows up to
// `maxConcurrentRuns` sessions to have client.prompt() in flight at once), a rogue
// frame with no sessionID would get delivered to EVERY session's onChunk at once —
// one session's text bleeding into another's chat bubble.
//
// The fix (sdk.ts): fail CLOSED — `if (evSession !== ocId) return;` — so a frame that
// doesn't explicitly carry OUR session's id is dropped, never processed on the
// assumption it's "probably fine".
//
// Run:  npm run test:e2e:concurrent
// (bundles to dist/concurrentSessions.e2e.cjs — gitignored — and runs it)
import http from 'http';
import { setOcEngine, setQualityGate, setHotStandby, setHedging, runChatStream, type AgentOpts } from '../src/agent/sdk';
import type { OcConnection } from '../src/backend/ocLauncher';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// --- Fake OC server: ONE global SSE broadcast shared by every session, exactly like
// the real `GET /global/event` — this is what makes the bug (and the fix) observable. ---
let sessionCounter = 0;
const sseClients = new Set<http.ServerResponse>();
function sendSSE(obj: unknown) {
  const frame = `data: ${JSON.stringify(obj)}\n\n`;
  for (const c of sseClients) c.write(frame);
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '';
  if (url === '/global/event') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (url === '/session' && req.method === 'POST') {
      const id = `s${sessionCounter++}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
      return;
    }
    const msgMatch = url.match(/^\/session\/(s\d+)\/message$/);
    if (msgMatch) {
      const sid = msgMatch[1];
      if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return; }
      // POST: respond once the scripted SSE sequence for this session finishes (real OC
      // semantics: prompt() blocks until the whole turn completes).
      const script = SCRIPTS[sid];
      script.run(() => { res.writeHead(200); res.end('{}'); });
      return;
    }
    if (url.match(/^\/session\/(s\d+)\/abort$/)) { res.writeHead(200); res.end('{}'); return; }
    res.writeHead(404); res.end('not found');
  });
});

// Per-session scripted SSE sequence, driven by delay so two sessions' turns genuinely
// overlap in wall-clock time (the precondition for the leak).
interface Script { run(onDone: () => void): void }
let SCRIPTS: Record<string, Script> = {};

function scriptFor(sid: string, ownText: string, ownDelayMs: number, rogueAt?: { text: string; delayMs: number }): Script {
  return {
    run(onDone) {
      if (rogueAt) {
        setTimeout(() => {
          // A frame with NO sessionID at all — simulates the real-world OC frames the
          // review flagged as sometimes lacking one.
          sendSSE({ type: 'message.part.updated', properties: { part: { type: 'text', text: rogueAt.text, id: 'rogue', role: 'assistant' } } });
        }, rogueAt.delayMs);
      }
      setTimeout(() => {
        sendSSE({ type: 'message.part.updated', properties: { sessionID: sid, part: { type: 'text', text: ownText, id: `p-${sid}`, role: 'assistant' } } });
        sendSSE({ type: 'session.idle', properties: { sessionID: sid } });
        setTimeout(onDone, 20);
      }, ownDelayMs);
    },
  };
}

function makeOpts(sessionId: string, text: string) {
  const events = { chunks: '' };
  const ac = new AbortController();
  const o: AgentOpts = {
    messages: [{ role: 'user', content: text }],
    mode: 'chat',
    effort: 'medium',
    abortSignal: ac.signal,
    sessionId,
    onChunk: (t) => { events.chunks += t; },
    onTool: () => {},
    onReasoning: () => {},
    onModel: () => {},
    onFailover: () => {},
    onStep: () => {},
    onTodos: () => {},
    onAskUser: async () => '',
    onError: () => {},
  };
  return { o, events, ac };
}

async function timeout<T>(p: Promise<T>, ms: number, ac: AbortController): Promise<T> {
  const t = setTimeout(() => ac.abort(new Error('test timeout')), ms);
  try { return await p; } finally { clearTimeout(t); }
}

async function main() {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  const conn: OcConnection = { port, baseURL: `http://127.0.0.1:${port}`, password: 'test' };
  setOcEngine(conn);
  setQualityGate(false);
  setHotStandby(false);
  setHedging(false);

  // --- Test: two concurrent sessions + a sessionID-less rogue frame must not leak ---
  sessionCounter = 0;
  SCRIPTS = {
    // Session A's own text arrives late (100ms); a rogue sessionID-less frame with a
    // distinctive payload fires in between (40ms), while B is also mid-flight.
    s0: scriptFor('s0', 'A-secret-answer', 100, { text: 'ROGUE-LEAK-NOT-MINE', delayMs: 40 }),
    s1: scriptFor('s1', 'B-secret-answer', 60),
  };
  const a = makeOpts('s0', 'What is my secret, session A?');
  const b = makeOpts('s1', 'What is my secret, session B?');
  // Fire both concurrently — this is exactly what acquireRunSlot() permits in the real
  // extension (up to maxConcurrentRuns sessions with client.prompt() in flight at once).
  const [ra, rb] = await Promise.all([
    timeout(runChatStream(null as any, a.o), 5000, a.ac),
    timeout(runChatStream(null as any, b.o), 5000, b.ac),
  ]);

  ok('A: got its own answer', ra.text.includes('A-secret-answer') || a.events.chunks.includes('A-secret-answer'));
  ok('B: got its own answer', rb.text.includes('B-secret-answer') || b.events.chunks.includes('B-secret-answer'));
  ok('A: did NOT receive the sessionID-less rogue frame', !a.events.chunks.includes('ROGUE-LEAK-NOT-MINE') && !ra.text.includes('ROGUE-LEAK-NOT-MINE'));
  ok('B: did NOT receive the sessionID-less rogue frame', !b.events.chunks.includes('ROGUE-LEAK-NOT-MINE') && !rb.text.includes('ROGUE-LEAK-NOT-MINE'));
  ok('A: did NOT receive B\'s answer', !a.events.chunks.includes('B-secret-answer') && !ra.text.includes('B-secret-answer'));
  ok('B: did NOT receive A\'s answer', !b.events.chunks.includes('A-secret-answer') && !rb.text.includes('A-secret-answer'));

  server.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
