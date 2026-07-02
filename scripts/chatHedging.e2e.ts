// Deterministic end-to-end test of Chat-Turn Request Hedging in sdk.ts: for a short first
// chat turn, `fast` and `smart` are raced concurrently and whichever answers well first wins.
//
// Spins up a fake OpenCode HTTP/SSE server (createSession / prompt / abort / global event
// stream) and drives the REAL runChatStream, same harness shape as the other e2e suites.
//
// Run:  npm run test:e2e:hedge
// (bundles to dist/chatHedging.e2e.cjs — gitignored — and runs it)
import http from 'http';
import { setOcEngine, setQualityGate, setHotStandby, setHedging, runChatStream, type AgentOpts } from '../src/agent/sdk';
import type { OcConnection } from '../src/backend/ocLauncher';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// --- Fake OC server: each session gets a scripted answer + reply delay, so tests control
// exactly which hedge leg "finishes" first. ------------------------------------------------
interface FakeSession { id: string; model: string; answer: string; delayMs: number }
let sessionSeq = 0;
const sessions = new Map<string, FakeSession>();
const createOrder: string[] = [];
const abortedIds: string[] = [];
let nextAnswers: string[] = []; // consumed in createSession order
let nextDelays: number[] = [];
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
      const parsed = body ? JSON.parse(body) : {};
      const model: string = parsed?.model?.id ?? 'unknown';
      const idx = createOrder.length;
      const id = `s${sessionSeq++}`;
      const answer = nextAnswers[idx] ?? 'GOOD default answer, nothing weak about it, plenty of words here.';
      const delayMs = nextDelays[idx] ?? 60;
      sessions.set(id, { id, model, answer, delayMs });
      createOrder.push(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
      return;
    }
    const msgMatch = url.match(/^\/session\/(s\d+)\/message$/);
    if (msgMatch) {
      const sid = msgMatch[1];
      const sess = sessions.get(sid);
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }
      const answer = sess?.answer ?? '';
      const delayMs = sess?.delayMs ?? 60;
      setTimeout(() => {
        sendSSE({ type: 'message.part.updated', properties: { sessionID: sid, part: { type: 'text', text: answer, id: 'p1', role: 'assistant' } } });
        sendSSE({ type: 'session.idle', properties: { sessionID: sid } });
        setTimeout(() => { res.writeHead(200); res.end('{}'); }, 10);
      }, delayMs);
      return;
    }
    if (url.match(/^\/session\/(s\d+)\/abort$/)) {
      const m = url.match(/^\/session\/(s\d+)\/abort$/)!;
      abortedIds.push(m[1]);
      res.writeHead(200); res.end('{}');
      return;
    }
    res.writeHead(404); res.end('not found');
  });
});

function makeOpts(text: string, opts: { pinnedModel?: string; sessionId?: string } = {}) {
  const events = { failovers: [] as string[], models: [] as string[], errors: [] as string[], chunks: '' };
  const ac = new AbortController();
  const o: AgentOpts = {
    messages: [{ role: 'user', content: text }],
    mode: 'chat',
    effort: 'medium',
    abortSignal: ac.signal,
    pinnedModel: opts.pinnedModel,
    sessionId: opts.sessionId ?? `test-${Math.random().toString(36).slice(2)}`,
    onChunk: (t) => { events.chunks += t; },
    onTool: () => {},
    onReasoning: () => {},
    onModel: (_p, m) => { events.models.push(m); },
    onFailover: (_from, reason) => { events.failovers.push(reason); },
    onStep: () => {},
    onTodos: () => {},
    onAskUser: async () => '',
    onError: (m) => { events.errors.push(m); },
  };
  return { o, events, ac };
}

function reset(answers: string[], delays: number[] = []) {
  sessions.clear();
  createOrder.length = 0;
  abortedIds.length = 0;
  sessionSeq = 0;
  nextAnswers = answers;
  nextDelays = delays;
}

async function timeout<T>(p: Promise<T>, ms: number, ac: AbortController): Promise<T> {
  const t = setTimeout(() => ac.abort(new Error('test timeout')), ms);
  try { return await p; } finally { clearTimeout(t); }
}

const GOOD = 'The simplest way to fix this bug is to add a null check before accessing the property, which prevents the crash and keeps the existing behavior intact for all callers.';
const REFUSAL = 'I cannot help with that request because it violates policy and I am programmed to decline such things entirely.';

async function main() {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  const conn: OcConnection = { port, baseURL: `http://127.0.0.1:${port}`, password: 'test' };
  setOcEngine(conn);
  setQualityGate(true);
  setHotStandby(false); // isolate hedging behavior from hot standby's own session churn
  setHedging(true);

  // --- Test 1: fast weak, smart good -> smart wins, fast's session aborted -----------
  reset([REFUSAL, GOOD], [30, 60]);
  {
    const { o, events, ac } = makeOpts('What is 2 plus 2?');
    const result = await timeout(runChatStream(null as any, o), 5000, ac);
    // The loser's abort() is fire-and-forget (never awaited, matching every other cancel
    // call site in sdk.ts) — give its network round-trip a moment to land before asserting.
    await new Promise((r) => setTimeout(r, 100));
    ok('T1 both legs create their own session (2 createSession calls)', createOrder.length === 2);
    ok('T1 winner is smart (good answer)', result.text.trim() === GOOD.trim());
    ok('T1 loser (fast, the weak one) was aborted', abortedIds.includes(createOrder[0]));
    ok('T1 no chunks leaked from the losing leg', events.chunks.trim() === GOOD.trim());
    ok('T1 exactly one onModel call reached the caller', events.models.length === 1);
  }

  // --- Test 2: fast good and finishes first -> fast wins, smart aborted -------------
  reset([GOOD, GOOD], [20, 200]);
  {
    const { o, events, ac } = makeOpts('What is the capital of France?');
    const result = await timeout(runChatStream(null as any, o), 5000, ac);
    await new Promise((r) => setTimeout(r, 100)); // let the loser's fire-and-forget abort() land
    ok('T2 fast wins (finished first with a good answer)', result.text.trim() === GOOD.trim());
    ok('T2 smart (the loser) was aborted', abortedIds.includes(createOrder[1]));
    ok('T2 no chunks leaked from the losing leg', events.chunks.trim() === GOOD.trim());
    ok('T2 exactly one onModel call reached the caller', events.models.length === 1);
  }

  // --- Test 3: turn 2 of the same session -> no hedging (session already exists) ----
  reset([GOOD], [20]);
  {
    const sid = 'sess-turn2';
    const t1 = makeOpts('What is your name?', { sessionId: sid });
    await timeout(runChatStream(null as any, t1.o), 5000, t1.ac);
    ok('T3 turn 1: hedged (2 sessions created)', createOrder.length === 2);
    reset([GOOD], [20]);
    const t2msgs: AgentOpts['messages'] = [
      { role: 'user', content: 'What is your name?' },
      { role: 'assistant', content: GOOD },
      { role: 'user', content: 'What is your favorite color?' },
    ];
    const t2 = makeOpts('', { sessionId: sid });
    t2.o.messages = t2msgs;
    await timeout(runChatStream(null as any, t2.o), 5000, t2.ac);
    ok('T3 turn 2: NOT hedged (only the reused/escalation-path session activity, no fresh double-create)', createOrder.length <= 1);
  }

  // --- Test 4: a long first message -> not hedge-eligible, sequential as normal ------
  reset([GOOD], [20]);
  {
    const longText = 'x'.repeat(500);
    const { o, ac } = makeOpts(longText);
    const result = await timeout(runChatStream(null as any, o), 5000, ac);
    ok('T4 long message: only one session created (sequential, not hedged)', createOrder.length === 1);
    ok('T4 long message: run completes', result.text.length > 0);
  }

  // --- Test 5: pinned model -> not hedge-eligible ------------------------------------
  reset([GOOD], [20]);
  {
    const { o, ac } = makeOpts('What is your name?', { pinnedModel: 'tm_testpinned' });
    const result = await timeout(runChatStream(null as any, o), 5000, ac);
    ok('T5 pinned model: only one session created (not hedged)', createOrder.length === 1);
    ok('T5 pinned model: run completes', result.text.length > 0);
  }

  // --- Test 6: hedging disabled -> byte-identical sequential behavior ----------------
  setHedging(false);
  reset([GOOD], [20]);
  {
    const { o, ac } = makeOpts('What is the weather like?');
    const result = await timeout(runChatStream(null as any, o), 5000, ac);
    ok('T6 hedging off: only one session created', createOrder.length === 1);
    ok('T6 hedging off: no aborts happened', abortedIds.length === 0);
    ok('T6 hedging off: run completes', result.text.trim() === GOOD.trim());
  }
  setHedging(true);

  // --- Test 7: each leg reports its OWN routed model, never swapped -----------------
  reset([REFUSAL, GOOD], [30, 60]);
  {
    const { o, events, ac } = makeOpts('What time is it?');
    await timeout(runChatStream(null as any, o), 5000, ac);
    ok('T7 the single onModel call reflects the WINNING leg only', events.models.length === 1 && events.models[0] === 'smart');
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  server.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
