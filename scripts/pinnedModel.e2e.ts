// Deterministic end-to-end test for the pinned-model contract.
//
// Verifies that when a user explicitly pins a concrete model in Chat / Plan / Agent mode,
// the run does NOT fail over to another model in the chain, even when the first hop would
// otherwise escalate. Also verifies that empty/whitespace pins fall back to Auto.
//
// Run:  npm run test:e2e:pinned
// (bundles to dist/pinnedModel.e2e.cjs — gitignored — and runs it)
import http from 'http';
import { setOcEngine, setQualityGate, setHotStandby, setHedging, runChatStream, type AgentOpts } from '../src/agent/sdk';
import type { OcConnection } from '../src/backend/ocLauncher';
import type { Router, RouteResult, RouteOptions } from '../src/router/router';

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

/**
 * Minimal mock router for the direct (chat/trivial) path. Its single-candidate
 * `route()` mirrors the real Router's pinned-model behavior (router.ts:243) —
 * `model !== 'auto'` collapses the chain to exactly one attempt with no
 * failover. For Auto it returns the scripted answer; full escalation-chain
 * behavior is exercised in qualityGate.e2e.ts, not here.
 */
function makeMockRouter(answer: string): Router {
  const route = async (_messages: unknown, opts: RouteOptions) => {
    const forced = !!(opts.model && opts.model !== 'auto');
    if (opts.onChunk) opts.onChunk(answer);
    return {
      response: {
        id: 'mock', object: 'chat.completion', created: 0, model: opts.model ?? 'auto',
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      platform: 'groq' as any,
      model: forced ? opts.model! : 'auto',
    };
  };
  return { route } as unknown as Router;
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

  // ── P1: Chat mode + pinned model → no failover, model preserved ───────────
  // A weak (refusal-style) answer arrives on the pinned model. The run must NOT
  // hand off to another model — escalation only happens on Auto. Goes through
  // runViaOc (pinned collapses the chain to length 1, isFinalHop=true), so the
  // mock router is never reached.
  reset([WEAK]);
  {
    const { o, events, ac } = makeOpts('Do something disallowed.', { mode: 'chat', pinnedModel: 'tm_testpinned' });
    const result = await timeout(runChatStream(makeMockRouter(WEAK), o), 5000, ac);
    ok('P1 chat+pinned: no failover', events.failovers.length === 0);
    ok('P1 chat+pinned: one session only', createdCount === 1);
    ok('P1 chat+pinned: result model preserved as pin', result.model === 'tm_testpinned');
    ok('P1 chat+pinned: no error surfaced', events.errors.length === 0);
  }

  // ── P2: Agent mode + pinned model → no failover (runViaOc path) ───────────
  reset([GOOD]);
  {
    const { o, events, ac } = makeOpts('Explain the fix.', { mode: 'agent', pinnedModel: 'tm_pinned_agent' });
    const result = await timeout(runChatStream(makeMockRouter(GOOD), o), 5000, ac);
    ok('P2 agent+pinned: no failover', events.failovers.length === 0);
    ok('P2 agent+pinned: result model preserved as pin', result.model === 'tm_pinned_agent');
  }

  // ── P3: Auto mode → routing still works (no regression) ───────────────────
  // The pinned-model guard must not break the Auto path. A trivial chat question
  // with no pin resolves to a concrete routed model (e.g. `fast`) and returns an
  // answer — NOT the literal string 'auto' (that's just the request profile).
  reset([GOOD]);
  {
    const { o, events, ac } = makeOpts('Say hello.', { mode: 'chat' });
    const result = await timeout(runChatStream(makeMockRouter(GOOD), o), 5000, ac);
    ok('P3 auto: returns an answer', result.text.trim().length > 0);
    ok('P3 auto: routed to a concrete model', !!result.model && result.model !== 'auto');
  }

  // ── P4: Pinned model fails → NO cross-model failover ──────────────────────
  // The single most important contract: a pinned model that produces an empty /
  // error answer must NOT silently switch to another model in the chain. We
  // script an empty answer on the pinned model and assert the run surfaces it
  // (or errors) WITHOUT escalating — zero failover events.
  reset(['']);
  {
    const { o, events, ac } = makeOpts('Explain the fix.', { mode: 'agent', pinnedModel: 'tm_pinned_fail' });
    try {
      const result = await timeout(runChatStream(makeMockRouter(''), o), 5000, ac);
      // Either the empty answer is surfaced on the pinned model, or the run
      // errors — but it must NEVER hand off to a different model.
      ok('P4 pinned-fail: no cross-model failover', events.failovers.length === 0);
      ok('P4 pinned-fail: stays on pinned model', result.model === 'tm_pinned_fail' || events.errors.length > 0);
    } catch {
      // An error is an acceptable outcome (no silent failover); the key assertion
      // is that no failover event fired.
      ok('P4 pinned-fail: no cross-model failover', events.failovers.length === 0);
    }
  }

  // ── P5: Empty / whitespace pin → treated as Auto ──────────────────────────
  // normalizePinnedModel() in sdk.ts collapses null/undefined/''/'  '/'auto' to
  // "no pin", so a stray whitespace value can never force a (nonexistent) model.
  for (const bad of ['', '   ', 'auto']) {
    reset([GOOD]);
    const { o, events, ac } = makeOpts('Say hello.', { mode: 'chat', pinnedModel: bad as string | undefined });
    const result = await timeout(runChatStream(makeMockRouter(GOOD), o), 5000, ac);
    ok(`P5 whitespace('${bad === '' ? "''" : bad}'): no pin forced`, result.model !== bad);
    ok(`P5 whitespace('${bad === '' ? "''" : bad}'): treated as auto`, events.failovers.length === 0);
  }

  server.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
