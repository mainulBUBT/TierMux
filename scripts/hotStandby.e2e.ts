// Deterministic end-to-end test of the Hot Standby Pre-warm WIRING in sdk.ts.
//
// Spins up a fake OpenCode HTTP/SSE server (createSession / prompt / global event
// stream) and drives the REAL runViaOc through runChatStream, same harness shape as
// qualityGate.e2e.ts. Captures console.log to assert on pre-warm/consume ordering
// without needing a live OC engine or a human driving the chat UI.
//
// Run:  npm run test:e2e:prewarm
// (bundles to dist/hotStandby.e2e.cjs — gitignored — and runs it)
import http from 'http';
import { setOcEngine, setQualityGate, setHotStandby, runChatStream, type AgentOpts } from '../src/agent/sdk';
import type { OcConnection } from '../src/backend/ocLauncher';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// --- Capture console.log so we can assert on sdk.ts's own [tiermux] log lines ---
const realLog = console.log;
let captured: string[] = [];
console.log = (...args: unknown[]) => {
  captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  realLog(...args);
};
const logsMatching = (re: RegExp) => captured.filter((l) => re.test(l));

// --- Fake OC server state (reset per test) -----------------------------------
let scripts: string[] = [];      // answer text per session, indexed by creation order
let sessionCounter = 0;
let createdCount = 0;
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
      createdCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
      return;
    }
    const msgMatch = url.match(/^\/session\/(s\d+)\/message$/);
    if (msgMatch) {
      const sid = msgMatch[1];
      if (req.method === 'GET') {
        const idx = parseInt(sid.slice(1), 10);
        const text = scripts[idx] ?? '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ info: { role: 'assistant' }, parts: [{ type: 'text', text }] }]));
        return;
      }
      // POST /message — OC blocks until the run finishes. Emit the scripted answer
      // over the SSE bus (after a delay so the reader is attached AND so a pre-warm
      // createSession() issued right after this POST has time to land first), then
      // respond 2xx.
      const idx = parseInt(sid.slice(1), 10);
      const text = scripts[idx] ?? '';
      setTimeout(() => {
        sendSSE({ type: 'message.part.updated', properties: { sessionID: sid, part: { type: 'text', text, id: 'p1', role: 'assistant' } } });
        sendSSE({ type: 'session.idle', properties: { sessionID: sid } });
        setTimeout(() => { res.writeHead(200); res.end('{}'); }, 30);
      }, 120);
      return;
    }
    if (url.match(/^\/session\/(s\d+)\/abort$/)) { res.writeHead(200); res.end('{}'); return; }
    res.writeHead(404); res.end('not found');
  });
});

function makeOpts(userText: string, opts: { mode?: AgentOpts['mode']; pinnedModel?: string } = {}) {
  const events = { failovers: [] as string[], models: [] as string[], errors: [] as string[], chunks: '' };
  const ac = new AbortController();
  const o: AgentOpts = {
    messages: [{ role: 'user', content: userText }],
    mode: opts.mode ?? 'chat',
    effort: 'medium',
    abortSignal: ac.signal,
    pinnedModel: opts.pinnedModel,
    sessionId: `test-${Math.random().toString(36).slice(2)}`,
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

function reset(answers: string[]) {
  scripts = answers;
  sessionCounter = 0;
  createdCount = 0;
  captured = [];
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
  setHotStandby(true);

  // --- Test 1: weak answer on fast → escalates to smart; hop1 must reuse the
  // pre-warmed session (no lazy createSession at escalation time).
  reset([REFUSAL, GOOD]);
  {
    const { o, events, ac } = makeOpts('Refactor the auth module to use async validation.');
    const result = await timeout(runChatStream(null as any, o), 5000, ac);
    ok('T1 escalates once', events.failovers.length === 1 && events.failovers[0]?.startsWith('weak_answer:refusal'));
    ok('T1 final text is GOOD', result.text.trim() === GOOD.trim());
    ok('T1 pre-warm fired for hop=1', logsMatching(/pre-warmed OC session .* for hop=1 profile=smart/).length === 1);
    ok('T1 escalation CONSUMED the pre-warmed session (no lazy create)', logsMatching(/using pre-warmed OC session/).length === 1);
    ok('T1 exactly 2 sessions created total (hop0 + prewarm)', createdCount === 2);
    console.log('   debug:', JSON.stringify({ failovers: events.failovers, created: createdCount }));
  }

  // --- Test 2: good answer, no escalation → pre-warm still fires (unconditional
  // on prompt-send) but is never consumed; still exactly 2 sessions created
  // (hop0 + the unused pre-warm), and cleanup drops the unused entry on finish.
  reset([GOOD]);
  {
    const { o, events } = makeOpts('Explain how the router picks a model.');
    const ac2 = new AbortController();
    const result = await timeout(runChatStream(null as any, { ...o, abortSignal: ac2.signal }), 5000, ac2);
    ok('T2 no failover', events.failovers.length === 0);
    ok('T2 pre-warm fired for hop=1', logsMatching(/pre-warmed OC session .* for hop=1 profile=smart/).length === 1);
    ok('T2 pre-warm never consumed', logsMatching(/using pre-warmed OC session/).length === 0);
    ok('T2 final text is GOOD', result.text.trim() === GOOD.trim());
    ok('T2 two sessions created (hop0 + unused prewarm)', createdCount === 2);
  }

  // --- Test 3: hotStandby disabled → behavior identical to pre-feature baseline
  // (lazy createSession only, on escalation).
  setHotStandby(false);
  reset([REFUSAL, GOOD]);
  {
    const { o, events } = makeOpts('Refactor the auth module to use async validation.');
    const ac3 = new AbortController();
    const result = await timeout(runChatStream(null as any, { ...o, abortSignal: ac3.signal }), 5000, ac3);
    ok('T3 (gate off) escalates once', events.failovers.length === 1);
    ok('T3 (gate off) NO pre-warm log', logsMatching(/pre-warmed OC session/).length === 0);
    ok('T3 (gate off) NO pre-warm-consumed log', logsMatching(/using pre-warmed OC session/).length === 0);
    ok('T3 (gate off) final text is GOOD', result.text.trim() === GOOD.trim());
    ok('T3 (gate off) two sessions created (hop0 + lazy hop1)', createdCount === 2);
  }
  setHotStandby(true);

  // --- Test 4: pinned model (length-1 chain) → no pre-warm attempted at all.
  reset([REFUSAL]);
  {
    const { o, events } = makeOpts('Do something disallowed.', { pinnedModel: 'tm_testpinned' });
    const ac4 = new AbortController();
    const result = await timeout(runChatStream(null as any, { ...o, abortSignal: ac4.signal }), 5000, ac4);
    ok('T4 pinned: NO failover', events.failovers.length === 0);
    ok('T4 pinned: NO pre-warm attempted (isFinalHop)', logsMatching(/pre-warmed OC session/).length === 0);
    ok('T4 pinned: only one session created', createdCount === 1);
    ok('T4 pinned: weak answer accepted as-is', result.text.trim() === REFUSAL.trim());
  }

  console.log = realLog;
  server.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.log = realLog; console.error('FATAL', err); process.exit(1); });
