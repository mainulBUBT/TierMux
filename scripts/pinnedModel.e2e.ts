// Deterministic end-to-end test for the pinned-model contract.
//
// Verifies that when a user explicitly pins a concrete model in Chat / Plan / Agent mode,
// the run does NOT fail over to another model in the chain, even when the first hop would
// otherwise escalate.
//
// Run:  npm run test:e2e
// (bundles to dist/pinnedModel.e2e.cjs — gitignored — and runs it)
import http from 'http';
import { setOcEngine, setQualityGate, setHotStandby, setHedging, runChatStream, type AgentOpts } from '../src/agent/sdk';
import type { OcConnection } from '../src/backend/ocLauncher';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// --- Fake OC server state (reset per test) -----------------------------------
let scripts: string[] = [];
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

const WEAK = 'I cannot help with that because it violates usage policy.';
const GOOD = 'The user asked how to fix this, and here is the answer: add a null check before dereferencing.';

async function main() {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  const conn: OcConnection = { port, baseURL: `http://127.0.0.1:${port}`, password: 'test' };
  setOcEngine(conn);
  setQualityGate(true);
  setHotStandby(false);
  setHedging(false);

  // ── Chat mode: pinned model, weak first-hop answer must stay on pinned model ──
  reset([WEAK]);
  {
    const { o, events, ac } = makeOpts('Do something disallowed.', { mode: 'chat', pinnedModel: 'tm_testpinned' });
    const result = await timeout(runChatStream(null as any, o), 5000, ac);
    ok('P1 chat+pinned: no failover', events.failovers.length === 0);
    ok('P1 chat+pinned: one session only', createdCount === 1);
    ok('P1 chat+pinned: result model preserved as pin', result.model === 'tm_testpinned');
    ok('P1 chat+pinned: no error surfaced', events.errors.length === 0);
  }

  // ── Agent plan mode: pinned model, runViaOc path ──────────────────────────
  // Without the router-layer fix, plan/agent runs also chain-route by default.
  // This smoke-test uses runChatStream directly with a pinned model because
  // the existing fake OC server only implements chat-style prompt flows, but
  // the same pinned contract is now enforced in runViaOc (chain collapses to 1).
  reset([GOOD]);
  {
    const { o, events, ac } = makeOpts('Explain the fix.', { mode: 'agent', pinnedModel: 'tm_pinned_agent' });
    const result = await timeout(runChatStream(null as any, o), 5000, ac);
    ok('P2 agent+pinned: no failover', events.failovers.length === 0);
    ok('P2 agent+pinned: result model preserved as pin', result.model === 'tm_pinned_agent');
  }

  // ── Contrast: auto mode with weak answer still escalates ──────────────────
  reset([WEAK, GOOD]);
  {
    const { o, events, ac } = makeOpts('Refactor the auth module.', { mode: 'chat' });
    const result = await timeout(runChatStream(null as any, o), 5000, ac);
    ok('P3 auto: weak→escalated failover', events.failovers.length === 1);
    ok('P3 auto: final text is the GOOD answer', result.text.trim() === GOOD.trim());
  }

  server.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
