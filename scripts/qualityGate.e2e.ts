// Deterministic end-to-end test of the FrugalGPT-style quality-gate WIRING in sdk.ts.
//
// Spins up a fake OpenCode HTTP/SSE server (createSession / prompt / global event
// stream) and drives the REAL runViaOc through runChatStream. Scripted answers are
// streamed over the fake SSE bus, so this exercises the full path:
//   session.idle → assessAnswerQuality → maybeEscalateWeak → tryEscalate → onFailover
// without needing a live OC engine or a human driving the chat UI.
//
// Run:  npm run test:e2e
// (bundles to dist/qualityGate.e2e.cjs — gitignored — and runs it)
import http from 'http';
import { setOcEngine, setQualityGate, setHotStandby, setHedging, runChatStream, type AgentOpts } from '../src/agent/sdk';
import type { OcConnection } from '../src/backend/ocLauncher';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

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
  // Global SSE event bus — handle at the TOP level (it's a bodyless, long-lived
  // GET; collecting a body first would deadlock the stream). Keep open; sdk.ts
  // attaches a reader. Flush headers so the client's fetch resolves immediately.
  if (url === '/global/event') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  // Read the request body for the remaining (JSON) routes.
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    // Create session.
    if (url === '/session' && req.method === 'POST') {
      const id = `s${sessionCounter++}`;
      createdCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
      return;
    }
    // Prompt (POST) vs. messages (GET) — same path, branch on method.
    const msgMatch = url.match(/^\/session\/(s\d+)\/message$/);
    if (msgMatch) {
      const sid = msgMatch[1];
      if (req.method === 'GET') {
        // Messages fallback (only hit when `out` is empty; we stream text so rarely used).
        const idx = parseInt(sid.slice(1), 10);
        const text = scripts[idx] ?? '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ info: { role: 'assistant' }, parts: [{ type: 'text', text }] }]));
        return;
      }
      // POST /message — OC blocks until the run finishes. Emit the scripted answer
      // over the SSE bus (after a tiny delay so the reader is attached), then respond 2xx.
      const idx = parseInt(sid.slice(1), 10);
      const text = scripts[idx] ?? '';
      setTimeout(() => {
        sendSSE({ type: 'message.part.updated', properties: { sessionID: sid, part: { type: 'text', text, id: 'p1', role: 'assistant' } } });
        sendSSE({ type: 'session.idle', properties: { sessionID: sid } });
        setTimeout(() => { res.writeHead(200); res.end('{}'); }, 30);
      }, 60);
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
  // Hot standby pre-warms the next hop's session, and hedging races fast+smart on turn 1 —
  // both independent of the quality gate. Disable both so session-count assertions below
  // stay scoped to gate behavior.
  setHotStandby(false);
  setHedging(false);

  // --- Test 1: weak (refusal) answer on fast → escalates to smart, smart gives good answer
  reset([REFUSAL, GOOD]);
  {
    const { o, events, ac } = makeOpts('Refactor the auth module to use async validation.');
    const result = await timeout(runChatStream(null as any, o), 5000, ac);
    ok('T1 weak→escalate: exactly one failover', events.failovers.length === 1);
    ok('T1 weak→escalate: reason is weak_answer:refusal', events.failovers[0]?.startsWith('weak_answer:refusal'));
    ok('T1 weak→escalate: two sessions created (hop0 + hop1)', createdCount === 2);
    ok('T1 weak→escalate: final text is the GOOD answer', result.text.trim() === GOOD.trim());
    ok('T1 weak→escalate: no error surfaced', events.errors.length === 0);
    console.log('   debug:', JSON.stringify({ failovers: events.failovers, models: events.models, created: createdCount, textLen: result.text.length, textHead: result.text.slice(0, 60), chunksLen: events.chunks.length }));
  }

  // --- Test 2: good answer on fast → no escalation
  reset([GOOD]);
  {
    const { o, events, ac } = makeOpts('Explain how the router picks a model.');
    const result = await timeout(runChatStream(null as any, o), 5000, ac);
    ok('T2 good: NO failover', events.failovers.length === 0);
    ok('T2 good: only one session created', createdCount === 1);
    ok('T2 good: final text is the good answer', result.text.trim() === GOOD.trim());
    ok('T2 good: no error surfaced', events.errors.length === 0);
  }

  // --- Test 3: pinned model → weak answer but nowhere to escalate, accepted as-is
  reset([REFUSAL]);
  {
    const { o, events, ac } = makeOpts('Do something disallowed.', { pinnedModel: 'tm_testpinned' });
    const result = await timeout(runChatStream(null as any, o), 5000, ac);
    ok('T3 pinned: NO failover (nowhere to go)', events.failovers.length === 0);
    ok('T3 pinned: only one session created', createdCount === 1);
    ok('T3 pinned: weak answer accepted as-is', result.text.trim() === REFUSAL.trim());
    ok('T3 pinned: no error surfaced', events.errors.length === 0);
  }

  // --- Test 4: quality gate disabled → weak answer accepted (byte-identical to today)
  setQualityGate(false);
  reset([REFUSAL, GOOD]);
  {
    const { o, events, ac } = makeOpts('Refactor the auth module to use async validation.');
    const result = await timeout(runChatStream(null as any, o), 5000, ac);
    ok('T4 gate off: NO failover', events.failovers.length === 0);
    ok('T4 gate off: only one session created', createdCount === 1);
    ok('T4 gate off: weak answer accepted', result.text.trim() === REFUSAL.trim());
  }
  setQualityGate(true);

  server.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
