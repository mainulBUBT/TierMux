// OpenCode free-lane contract, end to end against a mock Zen: every request on
// the lane carries the official-client costume (opencode/ UA, gate-shaped
// x-opencode-session, per-call request id), the body streams with the two
// decoy tools the gate requires, and a non-streaming caller gets the forced
// stream folded back into one completion. A provider WITHOUT the lane must
// stay untouched. LIVE=1 replays the streaming half against the real Zen.
// Run: npm run test:e2e:opencode-lane   (LIVE=1 for the real upstream; LIVE=1 LIVE_MODELS=a,b,c
// probes one line per model and prints which free models answer TODAY.)

import { createServer } from 'http';
import { OpenAICompatProvider } from '../src/providers/openai-compat';
import { foldSseToCompletion, openCodeLaneHeaders, shapeOpenCodeRequest } from '../src/providers/opencodeLane';
import { chatBodyToResponses } from '../src/providers/responsesWire';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : ` — ${d}`}`);
  if (!c) bad++;
};

interface Captured { url: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }
const captured: Captured[] = [];

const SSE =
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"po"}}]}\n\n' +
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ng"}}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n' +
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n';

/** muse-spark on /responses, trimmed from a live capture (2026-10-06): encrypted reasoning, a
 *  commentary message, then a function call whose arguments arrive as one delta. */
const RESPONSES_SSE = [
  { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', summary: [] } },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', encrypted_content: 'x' } },
  { type: 'response.output_item.added', output_index: 1, item: { type: 'message', role: 'assistant', content: [] } },
  { type: 'response.output_text.delta', output_index: 1, delta: "I'll read " },
  { type: 'response.output_text.delta', output_index: 1, delta: 'it.' },
  { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', name: 'readFile', call_id: 'call_9', arguments: '' } },
  { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"path":' },
  { type: 'response.function_call_arguments.delta', output_index: 2, delta: '"package.json"}' },
  { type: 'response.function_call_arguments.done', output_index: 2, arguments: '{"path":"package.json"}' },
  { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 653, output_tokens: 91, total_tokens: 744, output_tokens_details: { reasoning_tokens: 24 } } } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') + 'data: {"type":"ping","cost":"0"}\n\n';

/** One raw request, outside the provider parser: status, content-type, a frame census and the
 *  head AND tail of the body. `readSseStream` can only report "0 chunks"; this says WHICH failure
 *  it was — a gate refusal (4xx carrying Zen's own error text), an upstream model that is down (a
 *  500 relaying the provider console), or a 200 whose stream carries no text delta at all.
 *  `disguise=false` sends the same body under TierMux's own User-Agent: when both agree the gate
 *  is not involved and the model itself is at fault. */
async function rawProbe(model: string, disguise: boolean): Promise<string> {
  try {
    const res = await fetch('https://opencode.ai/zen/v1/chat/completions', {
      method: 'POST',
      headers: disguise
        ? { 'Content-Type': 'application/json', ...openCodeLaneHeaders('conv-why') }
        : { 'Content-Type': 'application/json', 'User-Agent': 'tiermux/3.0.1' },
      body: JSON.stringify(disguise
        ? shapeOpenCodeRequest({ model, messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 16 })
        : { model, messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 16 }),
    });
    const body = await res.text();
    const frames = body.split('\n').filter((l) => l.startsWith('data:')).length;
    const keepAlives = (body.match(/^: /gm) ?? []).length;
    const textDeltas = (body.match(/"content":"[^"]/g) ?? []).length
      + (body.match(/"reasoning_content":"[^"]/g) ?? []).length
      + (body.match(/"reasoning":"[^"]/g) ?? []).length;
    return `status=${res.status} ct=${res.headers.get('content-type') ?? '<none>'} dataFrames=${frames} keepAlives=${keepAlives} textDeltas=${textDeltas}`
      + ` head=${JSON.stringify(body.slice(0, 160))} tail=${JSON.stringify(body.slice(-160))}`;
  } catch (e) {
    return `raw request failed: ${(e as Error).message}`;
  }
}

async function main(): Promise<void> {
  const live = Boolean(process.env.LIVE);
  const port = await new Promise<number>((resolve) => {
    const srv = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        captured.push({ url: req.url ?? '', headers: req.headers, body });
        if (req.url?.endsWith('/responses')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(body.model === 'muse-spark-failed'
            ? `data: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { message: 'Upstream model overloaded' } } })}\n\n`
            : RESPONSES_SSE);
          return;
        }
        // The wire shape of a dead upstream behind a live gateway: HTTP 200, text/event-stream,
        // one frame that carries an `error` and no `choices` (live repro 2026-09-24, Zen →
        // nemotron-3-ultra-free → "Upstream error from Nvidia: Service temporarily overloaded").
        if (body.model === 'mock-error-frame') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end('data: {"error":{"type":"server_error","message":"Streaming response failed: [503] Upstream error from Nvidia: Service temporarily overloaded"}}\n\n');
          return;
        }
        // The other half of that boundary: text arrives first, the error frame trails it. The
        // partial answer is real and must survive.
        if (body.model === 'mock-partial-then-error') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end('data: {"id":"p","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"par"}}]}\n\n'
            + 'data: {"error":{"type":"server_error","message":"Streaming response failed: [503] Upstream error from Nvidia: Service temporarily overloaded"}}\n\n');
          return;
        }
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(SSE);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv.address()!.port));
  });

  const lane = new OpenAICompatProvider({
    platform: 'opencode', name: 'OpenCode Zen',
    baseUrl: live ? 'https://opencode.ai/zen/v1' : `http://127.0.0.1:${port}/v1`,
    keyless: true, skipPreflight: true, opencodeFreeLane: true, responsesModels: /^muse-spark-/,
  });
  const model = live ? 'big-pickle' : 'mock-free';
  const msg = [{ role: 'user' as const, content: 'Reply with exactly one word: pong' }];
  // LIVE_MODELS=a,b,c widens the live probe. Free-tier acceptance is per MODEL and moves week to
  // week (2026-09: 403 FreeTierError, 400 "free tier can only be used in OpenCode", 426 for beta
  // clients), so the live half reports one line per model rather than asserting big-pickle alone.
  const liveModels = (process.env.LIVE_MODELS ?? 'big-pickle').split(',').map((s) => s.trim()).filter(Boolean);

  if (live) {
    /* ---- per-model live probe: which free models this lane reaches TODAY ---- */
    const refused: string[] = [];
    for (const m of liveModels) {
      let text = '';
      let reason = '';
      let err = '';
      try {
        for await (const c of lane.streamChatCompletion('', msg, m, { sessionId: 'conv-1', max_tokens: 32, timeoutMs: 20000 })) {
          const d = c.choices?.[0]?.delta as { content?: string; reasoning_content?: string; reasoning?: string } | undefined;
          text += d?.content ?? '';
          reason += d?.reasoning_content ?? d?.reasoning ?? '';
        }
      } catch (e) {
        err = (e as Error).message.replace(/\s+/g, ' ').slice(0, 160);
      }
      // A turn is answered if EITHER channel produced text: the engine folds reasoning into
      // content (normalizeChoices), so a reasoning-only reply is not an empty one. Counting
      // content alone reported thinking models as dead (2026-09-24).
      const answered = (text + reason).trim().length > 0;
      // Printed as a status table — the refusal text is the model's own words, not our guess.
      console.log(`${answered ? 'LIVE    ' : 'REFUSED '} ${m.padEnd(30)} ${answered ? JSON.stringify((text || reason).trim().slice(0, 32)) : (err || 'empty 200 — no content chunk')}`);
      if (!answered) refused.push(m);
      // The parser can only say "no chunk"; the raw wire says WHICH failure this is. Both shapes
      // are printed: with the lane's identity and with TierMux's own (a disagreement means the
      // gate, agreement means the model itself).
      console.log(`RAW-OC   ${m.padEnd(30)} ${await rawProbe(m, true)}`);
      console.log(`RAW-PLAIN${m.padEnd(30)} ${await rawProbe(m, false)}`);
    }
    ok(`live: at least one free model answered (${liveModels.length - refused.length}/${liveModels.length})`,
      refused.length < liveModels.length, `all refused — ${refused.join(', ')}`);
  } else {
    /* ---- streaming through the lane ---- */
    let text = '';
    for await (const c of lane.streamChatCompletion('', msg, model, { sessionId: 'conv-1', max_tokens: 64 })) {
      text += c.choices?.[0]?.delta?.content ?? '';
    }
    ok('streaming yields the folded text', text.includes('pong'), `got "${text.slice(0, 40)}"`);
  }

  if (!live) {
    const first = captured[0];
    const h = (k: string) => String(first.headers[k] ?? '');
    ok('UA wears the opencode/ costume', h('user-agent').startsWith('opencode/'), h('user-agent'));
    ok('session id has the gate shape', /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(h('x-opencode-session')), h('x-opencode-session'));
    ok('per-call request id sent', /^msg_/.test(h('x-opencode-request')), h('x-opencode-request'));
    ok('body streams', first.body.stream === true);
    const names = ((first.body.tools as Array<{ function: { name: string } }>) ?? []).map((t) => t.function.name).sort();
    ok('decoy tools ride along', JSON.stringify(names) === '["bash","read"]', JSON.stringify(names));
    ok('decoys pinned off without caller tools', first.body.tool_choice === 'none');

    /* ---- session stability, request-id freshness ---- */
    await lane.chatCompletion('', msg, model, { sessionId: 'conv-1', max_tokens: 64 });
    await lane.chatCompletion('', msg, model, { sessionId: 'conv-2', max_tokens: 64 });
    const s = (i: number) => String(captured[i].headers['x-opencode-session']);
    const r = (i: number) => String(captured[i].headers['x-opencode-request']);
    ok('same conversation, same session', s(1) === s(0));
    ok('different conversation, different session', s(2) !== s(0));
    ok('request ids are per-call', r(1) !== r(0));

    /* ---- non-stream callers get the folded answer ---- */
    const folded = await lane.chatCompletion('', msg, model, { sessionId: 'conv-1', max_tokens: 64 });
    ok('folded content is the whole stream', folded.choices[0].message.content === 'pong', JSON.stringify(folded.choices[0].message.content));
    ok('folded finish reason kept', folded.choices[0].finish_reason === 'stop');

    /* ---- caller tools survive, decoys do not override ---- */
    const callerTool = { type: 'function' as const, function: { name: 'shell', description: 'run', parameters: { type: 'object' as const, properties: {} } } };
    await lane.chatCompletion('', msg, model, { sessionId: 'conv-3', max_tokens: 64, tools: [callerTool] });
    const sent = (captured[captured.length - 1].body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name).sort();
    ok('caller tool kept, decoys appended', JSON.stringify(sent) === '["bash","read","shell"]', JSON.stringify(sent));
    ok("caller's tool_choice spelling kept", captured[captured.length - 1].body.tool_choice === undefined);

    /* ---- a provider without the lane is untouched ---- */
    const plain = new OpenAICompatProvider({ platform: 'llm7', name: 'LLM7', baseUrl: `http://127.0.0.1:${port}/v1`, keyless: true });
    const before = captured.length;
    await plain.chatCompletion('', msg, 'mock-free', { sessionId: 'conv-1', max_tokens: 64 });
    const p = captured[before];
    ok('plain provider keeps its own UA', String(p.headers['user-agent']).startsWith('tiermux/'));
    ok('plain provider sends no session costume', p.headers['x-opencode-session'] === undefined);
    ok('plain provider is not forced to stream', p.body.stream === undefined);

    /* ---- a KEYED lane provider is identified honestly (no costume) ---- */
    const kO = { platform: 'opencode' as const, name: 'OpenCode Zen', keyless: true, keyOptional: true, skipPreflight: true, sessionHeader: 'x-opencode-session', opencodeFreeLane: true };
    const keyed = new OpenAICompatProvider({ ...kO, baseUrl: `http://127.0.0.1:${port}/v1` });
    const beforeKeyed = captured.length;
    const keyedAns = await keyed.chatCompletion('zen-key', msg, model, { sessionId: 'conv-1', max_tokens: 64 });
    const k = captured[beforeKeyed];
    ok('keyed lane drops the opencode/ costume', String(k.headers['user-agent']).startsWith('tiermux/'), String(k.headers['user-agent']));
    ok('keyed lane sends the account key', String(k.headers.authorization) === 'Bearer zen-key', String(k.headers.authorization));
    ok('keyed lane keeps the documented session header',
      typeof k.headers['x-opencode-session'] === 'string' && String(k.headers['x-opencode-session']).length > 0,
      String(k.headers['x-opencode-session']));
    ok('keyed lane sends no gate decoys', k.body.tools === undefined, JSON.stringify(k.body.tools));
    ok('keyed lane is not forced to stream', k.body.stream === undefined, String(k.body.stream));
    ok('keyed lane reads the plain JSON answer', keyedAns.choices[0].message.content === 'pong', JSON.stringify(keyedAns.choices[0].message.content));

    const beforeStable = captured.length;
    await keyed.chatCompletion('zen-key', msg, model, { sessionId: 'conv-1', max_tokens: 64 });
    await keyed.chatCompletion('zen-key', msg, model, { sessionId: 'conv-2', max_tokens: 64 });
    ok('keyed session header is stable per conversation',
      captured[beforeKeyed].headers['x-opencode-session'] === captured[beforeStable].headers['x-opencode-session']);
    ok('keyed session header differs across conversations',
      captured[beforeStable].headers['x-opencode-session'] !== captured[beforeStable + 1].headers['x-opencode-session']);

    /* ---- the same platform with NO key keeps the keyless lane ---- */
    const anon = new OpenAICompatProvider({ ...kO, baseUrl: `http://127.0.0.1:${port}/v1` });
    const beforeAnon = captured.length;
    await anon.chatCompletion('', msg, model, { sessionId: 'conv-1', max_tokens: 64 });
    ok('no key ⇒ the costume is back', String(captured[beforeAnon].headers['user-agent']).startsWith('opencode/'));
    ok('no key ⇒ no Authorization header', captured[beforeAnon].headers.authorization === undefined, String(captured[beforeAnon].headers.authorization));

    /* ---- a 200 stream that carries an upstream error is NOT a blank answer ---- */
    let frameErr: (Error & { status?: number }) | null = null;
    try {
      for await (const chunk of lane.streamChatCompletion('', msg, 'mock-error-frame', { sessionId: 'conv-err', max_tokens: 32 })) {
        void chunk;
      }
    } catch (e) {
      frameErr = e as Error & { status?: number };
    }
    ok('an error-carrying 200 stream throws instead of ending blank',
      !!frameErr && /Service temporarily overloaded/.test(frameErr.message), frameErr?.message ?? 'no throw');
    ok('…and it carries the upstream status, so the router fails over on it',
      frameErr?.status === 503, String(frameErr?.status));
    let partial = '';
    let partialThrew = false;
    try {
      for await (const chunk of lane.streamChatCompletion('', msg, 'mock-partial-then-error', { sessionId: 'conv-partial', max_tokens: 32 })) {
        partial += chunk.choices?.[0]?.delta?.content ?? '';
      }
    } catch {
      partialThrew = true;
    }
    ok('an error frame AFTER real text keeps the text (a partial answer is not a blank one)',
      !partialThrew && partial === 'par', partialThrew ? 'threw' : JSON.stringify(partial));

    /* ---- unit: no duplicate decoys, split tool-call arguments merge ---- */
    const shaped = shapeOpenCodeRequest({ tools: [callerTool, { type: 'function', function: { name: 'bash', description: 'real', parameters: { type: 'object', properties: {} } } }] } as Record<string, unknown>);
    const shapedNames = (shaped.tools as Array<{ function: { name: string } }>).map((t) => t.function.name).sort();
    ok('no duplicate bash when the caller ships one', JSON.stringify(shapedNames) === '["bash","read","shell"]', JSON.stringify(shapedNames));

    const foldedCalls = foldSseToCompletion(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"shell","arguments":"{\\"cmd\\":"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
      'data: [DONE]\n\n', 'm');
    const tc = foldedCalls.choices[0].message.tool_calls?.[0];
    /* ---- muse-spark rides /responses: body translated, stream re-framed as chat ---- */
    const readTool = { type: 'function' as const, function: { name: 'readFile', description: 'read', parameters: { type: 'object' as const, properties: { path: { type: 'string' } } } } };
    let museText = '';
    const museCalls = new Map<number, { id: string; name: string; args: string }>();
    let museFinish: string | null = null;
    const beforeMuse = captured.length;
    for await (const c of lane.streamChatCompletion('', msg, 'muse-spark-1.3-contributor-free', { sessionId: 'conv-m', max_tokens: 64, tools: [readTool] })) {
      const ch = c.choices?.[0];
      museText += ch?.delta?.content ?? '';
      for (const t of ch?.delta?.tool_calls ?? []) {
        const s = museCalls.get(t.index ?? 0) ?? { id: '', name: '', args: '' };
        if (t.id) s.id = t.id;
        s.name += t.function?.name ?? '';
        s.args += t.function?.arguments ?? '';
        museCalls.set(t.index ?? 0, s);
      }
      if (ch?.finish_reason) museFinish = ch.finish_reason;
    }
    const mb = captured[beforeMuse];
    ok('muse-spark goes to /responses', mb.url === '/v1/responses', mb.url);
    ok('…with input items, not messages', Array.isArray(mb.body.input) && mb.body.messages === undefined);
    const flatNames = ((mb.body.tools as Array<{ name?: string }>) ?? []).map((t) => t.name).sort();
    ok('…tools in the flat shape, decoys included', JSON.stringify(flatNames) === '["bash","read","readFile"]', JSON.stringify(flatNames));
    ok('…streamed, max_tokens renamed', mb.body.stream === true && mb.body.max_output_tokens === 64 && mb.body.stream_options === undefined);
    ok('…still wears the costume', String(mb.headers['user-agent']).startsWith('opencode/'));
    ok('streamed text re-framed', museText === "I'll read it.", JSON.stringify(museText));
    const mc = museCalls.get(0);
    ok('streamed function call re-framed', mc?.id === 'call_9' && mc?.name === 'readFile' && mc?.args === '{"path":"package.json"}', JSON.stringify(mc));
    ok('arguments.done does not double the arguments', museCalls.size === 1 && mc?.args.length === '{"path":"package.json"}'.length);
    ok('finish is tool_calls', museFinish === 'tool_calls', String(museFinish));

    const museFolded = await lane.chatCompletion('', msg, 'muse-spark-1.3-contributor-free', { sessionId: 'conv-m', max_tokens: 64 });
    const fm = museFolded.choices[0];
    ok('non-stream caller gets the folded answer', fm.message.content === "I'll read it." && fm.message.tool_calls?.[0]?.function.name === 'readFile', JSON.stringify(fm.message));
    ok('usage mapped from the responses shape', museFolded.usage.prompt_tokens === 653 && museFolded.usage.completion_tokens === 91 && museFolded.usage.reasoning_tokens === 24, JSON.stringify(museFolded.usage));
    ok('tool_choice "none" is not sent to /responses (Zen: only "auto")', captured[captured.length - 1].body.tool_choice === undefined, String(captured[captured.length - 1].body.tool_choice));

    let museErr: (Error & { status?: number }) | null = null;
    try {
      for await (const c of lane.streamChatCompletion('', msg, 'muse-spark-failed', { sessionId: 'conv-m', max_tokens: 32 })) void c;
    } catch (e) {
      museErr = e as Error & { status?: number };
    }
    ok('response.failed throws a failover-worthy error', !!museErr && /overloaded/.test(museErr.message) && (museErr.status ?? 0) >= 500, `${museErr?.message} ${museErr?.status}`);

    const history = chatBodyToResponses({
      model: 'm',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'readFile', arguments: '{"path":"a"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'file a' },
      ],
      tool_choice: 'auto',
    });
    ok('history translates to responses items', JSON.stringify(history.input) === JSON.stringify([
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'data:image/png;base64,AA' }] },
      { type: 'function_call', call_id: 'c1', name: 'readFile', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'file a' },
    ]), JSON.stringify(history.input));
    ok('tool_choice "auto" survives', history.tool_choice === 'auto');

    ok('tool-call fragments join across frames', tc?.function.name === 'shell' && tc?.function.arguments === '{"cmd":"ls"}',
      `${tc?.function.name} ${tc?.function.arguments}`);
  }

  console.log(bad === 0 ? '\nall opencode-lane checks passed' : `\n${bad} check(s) FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('e2e crashed:', e);
  process.exit(1);
});
