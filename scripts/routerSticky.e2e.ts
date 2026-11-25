/* Auto must keep the model that served step 1 for the rest of the turn. Repro 2026-09-06: the
 * SDK calls doStream/doGenerate once per STEP, selectModel ran on every one of them, and its
 * equal-rank rotation counter post-increments per call — so a multi-step free-tier turn walked
 * a different peer every step (cold provider, transcript re-sent, no prompt cache). One router
 * provider instance = one turn (engine.ts creates it per runTurn); stickiness lives there.
 * Cross-turn rotation, failover and cooldowns must keep working. Run: npm run test:e2e:router-sticky */
import { setModelSources, recordOutcome, isInCooldown, __resetTaskRoundCounters } from '../src/router/picker';
import { createRouterProvider, dropUnfit, isContextOverflow } from '../src/agent/core/routerProvider';
import { ProviderHttpError } from '../src/providers/base';
import type { FallbackEntry } from '../src/shared/types';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const entry = (platform: string, modelId: string, priority: number): FallbackEntry =>
  ({ platform, modelId, enabled: true, priority } as unknown as FallbackEntry);

/** Two EQUAL-RANK, equal-speed peers on one keyed platform — exactly the shape the picker
 *  rotates between calls (see the peer rotation in selectModel). */
function makeSources(fallback: FallbackEntry[]) {
  return {
    catalog: { find: (_p: string, _m: string) => ({ intelligenceRank: 1, speedRank: 1, supportsTools: true }) },
    settings: {
      getFallback: () => fallback,
      getDisabledProviders: () => [],
      enabledByPriority: () => fallback.filter((e) => e.enabled).sort((a, b) => a.priority - b.priority),
    },
    secrets: {
      getKeys: async (_p: string) => ['sk-test'],
      getCloudflareAccountId: async () => undefined,
      isToolIncompatible: () => false,
    },
  } as unknown as Parameters<typeof setModelSources>[0];
}

/** Wire-level stand-in for the provider: records which model each request named and answers
 *  an OpenAI-shaped completion, or the status `failWith` says for that model. */
const served: string[] = [];
const failWith = new Map<string, number>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  const body = JSON.parse(init?.body ?? '{}') as { model?: string };
  const model = body.model ?? '?';
  served.push(model);
  const status = failWith.get(model);
  if (status) return new Response(JSON.stringify({ error: { message: `mock ${status}` } }), { status, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({
    id: 'x', object: 'chat.completion', model,
    choices: [{ index: 0, message: { role: 'assistant', content: `hello from ${model}` }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const step = (): LanguageModelV4CallOptions => ({
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
} as unknown as LanguageModelV4CallOptions);

/** Streams scripted SSE bodies — one script per model id — through a fresh router provider and
 *  returns what the SDK would have seen. Restores fetch, config and sources afterwards. */
async function streamOnce(
  models: FallbackEntry[],
  scripts: Record<string, (c: ReadableStreamDefaultController<Uint8Array>, signal?: AbortSignal) => void>,
  cfg: Record<string, unknown>,
  opts: { abortSignal?: AbortSignal; onFailover?: (from: string, reason: string) => void; onModelSelected?: (m: string) => void } = {},
): Promise<{ parts: Array<{ type: string; delta?: string; finishReason?: { unified?: string } }>; dialed: string[]; text: string; finish: string; error: unknown }> {
  const g = globalThis as { __tiermuxTestConfig?: Record<string, unknown> };
  const prevCfg = g.__tiermuxTestConfig;
  g.__tiermuxTestConfig = { ...(prevCfg ?? {}), ...cfg };
  setModelSources(makeSources(models));
  for (const m of models) recordOutcome(m.platform as string, m.modelId, true);
  __resetTaskRoundCounters();
  const dialed: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string; signal?: AbortSignal }) => {
    const model = (JSON.parse(init?.body ?? '{}') as { model?: string }).model ?? '?';
    dialed.push(model);
    const body = new ReadableStream<Uint8Array>({ start: (c) => scripts[model]?.(c, init?.signal) });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  type Part = { type: string; delta?: string; finishReason?: { unified?: string } };
  const parts: Part[] = [];
  let error: unknown;
  try {
    const turn = createRouterProvider({
      taskKind: 'chat',
      onFailover: opts.onFailover,
      onModelSelected: opts.onModelSelected && ((_p: string, m: string) => opts.onModelSelected!(m)),
    });
    const { stream } = await turn.doStream({ ...(step() as object), abortSignal: opts.abortSignal } as LanguageModelV4CallOptions);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => { for await (const p of stream as AsyncIterable<Part>) parts.push(p); })(),
        new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error('hung')), 5_000); }),
      ]);
    } finally { if (watchdog) clearTimeout(watchdog); }
  } catch (e) { error = e; } finally { globalThis.fetch = realFetch; g.__tiermuxTestConfig = prevCfg; }
  return {
    parts, dialed, error,
    text: parts.filter((p) => p.type === 'text-delta').map((p) => p.delta ?? '').join(''),
    finish: parts.filter((p) => p.type === 'finish').map((p) => p.finishReason?.unified).join(','),
  };
}

async function main() {
  const A = 'peer-a', B = 'peer-b';
  setModelSources(makeSources([entry('groq', A, 0), entry('groq', B, 1)]));
  for (const m of [A, B]) recordOutcome('groq', m, true); // clean health

  console.log('— one turn = one served model, however many steps —');
  {
    __resetTaskRoundCounters();
    served.length = 0;
    const selections: string[] = [];
    const turn = createRouterProvider({ taskKind: 'chat', onModelSelected: (_p, m) => selections.push(m) });
    for (let i = 0; i < 4; i++) await turn.doGenerate(step());
    ok('1. four steps hit the wire four times', served.length === 4, served.join(','));
    ok('2. every step was served by the SAME model', new Set(served).size === 1, served.join(','));
    ok('3. onModelSelected agrees on every step', new Set(selections).size === 1 && selections.length === 4);
  }

  console.log('— a NEW turn still rotates between equal-rank peers —');
  {
    // The counter advanced once in the turn above (step 1 only — steps 2-4 never selected), so
    // this turn's first selection is round 1 = the other peer. Rotation is per TURN now, not per
    // step; it was never meant to be per step.
    const first = served[0];
    served.length = 0;
    const turn2 = createRouterProvider({ taskKind: 'chat' });
    await turn2.doGenerate(step());
    await turn2.doGenerate(step());
    ok('4. the second turn opened on the OTHER peer', served[0] !== first, `${first} → ${served[0]}`);
    ok('5. and stuck to it for its own second step', served[1] === served[0], served.join(','));
  }

  console.log('— a sticky model that fails hands over to the chain, and the replacement sticks —');
  {
    __resetTaskRoundCounters();
    for (const m of [A, B]) recordOutcome('groq', m, true);
    served.length = 0;
    const failovers: string[] = [];
    const turn3 = createRouterProvider({ taskKind: 'chat', onFailover: (from) => failovers.push(from) });
    await turn3.doGenerate(step());
    const sticky = served[0];
    const other = sticky === A ? B : A;
    failWith.set(sticky, 429);
    await turn3.doGenerate(step());
    ok('6. step 2 tried the sticky model first', served[1] === sticky, served.join(','));
    ok('7. …then failed over to the peer', served[2] === other, served.join(','));
    ok('8. the failover was reported', failovers.length === 1 && failovers[0] === `groq::${sticky}`);
    failWith.clear();
    await turn3.doGenerate(step());
    ok('9. step 3 goes straight to the replacement — the cooled-down model is not retried', served[3] === other && served.length === 4, served.join(','));
  }

  console.log('— a fallback holds the turn only until the preferred model is back —');
  {
    const strong = 'strong', weak = 'weak';
    const base = makeSources([entry('groq', strong, 0), entry('groq', weak, 1)]);
    setModelSources({ ...base, catalog: { find: (_p: string, m: string) => ({ intelligenceRank: m === strong ? 1 : 9, speedRank: 1, supportsTools: true }) } } as never);
    __resetTaskRoundCounters();
    for (const m of [strong, weak]) recordOutcome('groq', m, true);
    served.length = 0;
    failWith.set(strong, 429);
    const turn4 = createRouterProvider({ taskKind: 'chat' });
    await turn4.doGenerate(step());
    ok('11. the preferred model failed and the fallback served', served.join(',') === `${strong},${weak}`, served.join(','));
    failWith.clear();
    await turn4.doGenerate(step());
    ok('12. while it cools down the fallback keeps the turn', served[2] === weak && served.length === 3, served.join(','));
    recordOutcome('groq', strong, true);
    await turn4.doGenerate(step());
    ok('13. once it is back the next step returns to it', served[3] === strong && served.length === 4, served.join(','));
    await turn4.doGenerate(step());
    ok('14. and it sticks from then on', served[4] === strong, served.join(','));
    setModelSources(makeSources([entry('groq', A, 0), entry('groq', B, 1)]));
  }

  console.log('— a pinned model is unaffected (it already runs alone) —');
  {
    served.length = 0;
    const pinned = createRouterProvider({ pinnedModel: `groq::${B}` });
    await pinned.doGenerate(step());
    await pinned.doGenerate(step());
    ok('10. both steps ran the pin', served.join(',') === `${B},${B}`, served.join(','));
  }

  console.log('— the next TURN in the same conversation resumes on the model that served (2026-11-11) —');
  {
    __resetTaskRoundCounters();
    for (const m of [A, B]) recordOutcome('groq', m, true);
    served.length = 0;
    const t1 = createRouterProvider({ taskKind: 'chat', sessionId: 'conv-s1' });
    await t1.doGenerate(step());
    const firstServed = served[0];
    served.length = 0;
    const t2 = createRouterProvider({ taskKind: 'chat', sessionId: 'conv-s1' });
    await t2.doGenerate(step());
    ok('15. a new turn of the same session opens on the model that served before', served[0] === firstServed, `${firstServed} → ${served[0]}`);
    // …and degrades gracefully when that model now fails: sticky first, chain behind it
    failWith.set(firstServed, 429);
    served.length = 0;
    const t3 = createRouterProvider({ taskKind: 'chat', sessionId: 'conv-s1' });
    await t3.doGenerate(step());
    const other = firstServed === A ? B : A;
    ok('16. a failing session-sticky fails over inside the turn', served[0] === firstServed && served[1] === other, served.join(','));
    failWith.clear();
    // a pin always beats the session memory
    served.length = 0;
    const t4 = createRouterProvider({ taskKind: 'chat', sessionId: 'conv-s1', pinnedModel: `groq::${other}` });
    await t4.doGenerate(step());
    ok('17. an explicit pin is never overridden by the session memory', served[0] === other, served.join(','));
    // the webview sends 'auto' for Auto — that is no pin (2026-11-12: it disabled the session seed)
    for (const lastServed of [A, B]) {
      const sid = `conv-auto-${lastServed}`;
      await createRouterProvider({ taskKind: 'chat', sessionId: sid, pinnedModel: `groq::${lastServed}` }).doGenerate(step());
      served.length = 0;
      for (let i = 0; i < 3; i++) await createRouterProvider({ taskKind: 'chat', sessionId: sid, pinnedModel: 'auto' }).doGenerate(step());
      ok(`17b. Auto ('auto' from the webview) resumes the session's model (${lastServed}), turn after turn`, served.length === 3 && served.every((m) => m === lastServed), served.join(','));
    }
  }

  console.log('— a confirmed context overflow drops the candidates that cannot fit (2026-11-11) —');
  {
    __resetTaskRoundCounters();
    // windows: A=100k, B=8k, C=1M; a ~76k-token prompt needs ~95k with headroom. A fits, B is
    // impossible, C fits. A answers 413 ⇒ B must be DROPPED (never tried), C takes over.
    const big = entry('groq', 'big-m', 0), small = entry('groq', 'small-m', 1), huge = entry('groq', 'huge-m', 2);
    setModelSources({
      ...makeSources([big, small, huge]),
      catalog: {
        find: (_p: string, m: string) => ({
          intelligenceRank: 1, speedRank: 1, supportsTools: true,
          contextWindow: m === 'big-m' ? 100_000 : m === 'small-m' ? 8_192 : 1_000_000,
        }),
      },
    } as unknown as Parameters<typeof setModelSources>[0]);
    served.length = 0;
    // the picker puts the biggest window first, so the OVERFLOW lands on huge-m (1M, priority
    // aside); after its 413, small-m (8k < ~95k needed) must be DROPPED, big-m (100k) serves.
    failWith.set('huge-m', 413);
    const bigStep = (): LanguageModelV4CallOptions => ({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(250_000) }] }],
    } as unknown as LanguageModelV4CallOptions);
    const t = createRouterProvider({ taskKind: 'chat' });
    await t.doGenerate(bigStep());
    ok('18. the overflow model was tried, the too-small one dropped, the fitting one served',
      served.includes('huge-m') && served.includes('big-m') && !served.includes('small-m'), served.join(','));
    failWith.clear();
    ok('19. isContextOverflow recognises the shapes', isContextOverflow(new ProviderHttpError('X API error 413: too large', 413))
      && isContextOverflow(new ProviderHttpError("X API error 400: This model's maximum context length is 8192 tokens", 400))
      && !isContextOverflow(new ProviderHttpError('X API error 400: bad parameter', 400)));
    const { kept, dropped } = dropUnfit(
      [{ platform: 'groq', modelId: 'cur' }, { platform: 'groq', modelId: 'small-m' }, { platform: 'groq', modelId: 'huge-m' }],
      0, 76_000);
    ok('20. dropUnfit keeps the current + fitting, names the dropped',
      kept.length === 2 && dropped.length === 1 && dropped[0].includes('small-m'), JSON.stringify(dropped));
    setModelSources(makeSources([entry('groq', A, 0), entry('groq', B, 1)]));
  }

  console.log('— a stream that stalls MID-REPLY is cut and the next model continues (2026-11-24) —');
  {
    const g = globalThis as { __tiermuxTestConfig?: Record<string, unknown> };
    const prevCfg = g.__tiermuxTestConfig;
    g.__tiermuxTestConfig = { ...(prevCfg ?? {}), streamIdleTimeoutMs: 300 };
    const S = 'staller', C = 'continuer';
    setModelSources(makeSources([entry('groq', S, 0), entry('groq', C, 1)]));
    for (const m of [S, C]) recordOutcome('groq', m, true);
    __resetTaskRoundCounters();
    const dialed: string[] = [];
    let stallerAborted = false;
    const frame = (model: string, delta: string | null): Uint8Array => new TextEncoder()
      .encode(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: delta === null ? {} : { content: delta }, finish_reason: delta === null ? 'stop' : null }] })}\n\n`);
    globalThis.fetch = (async (_url: unknown, init?: { body?: string; signal?: AbortSignal }) => {
      const model = (JSON.parse(init?.body ?? '{}') as { model?: string }).model ?? '?';
      dialed.push(model);
      let ctrl!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
      if (model === S) {
        // Half a reply, then the connection goes silent and never speaks again.
        ctrl.enqueue(frame(model, 'half a reply, '));
        init?.signal?.addEventListener('abort', () => {
          stallerAborted = true;
          try { ctrl.error(init.signal?.reason); } catch { /* already closed */ }
        }, { once: true });
      } else {
        ctrl.enqueue(frame(model, 'the rest'));
        ctrl.enqueue(frame(model, null));
        ctrl.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        ctrl.close();
      }
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    type Part = { type: string; delta?: string; finishReason?: { unified?: string } };
    const parts: Part[] = [];
    let hung: string | undefined;
    const turn = createRouterProvider({ taskKind: 'chat' });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const { stream } = await turn.doStream(step());
      await Promise.race([
        (async () => { for await (const p of stream as AsyncIterable<Part>) parts.push(p); })(),
        new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error('hung')), 4_000); }),
      ]);
    } catch (e) {
      hung = e instanceof Error ? e.message : String(e);
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
    const text = parts.filter((p) => p.type === 'text-delta').map((p) => p.delta ?? '').join('');
    const finish = parts.filter((p) => p.type === 'finish').map((p) => p.finishReason?.unified).join(',');

    ok('21. the stalled stream was cut, not left hanging', hung === undefined && stallerAborted, JSON.stringify({ hung, stallerAborted, parts: parts.map((p) => p.type) }));
    ok('22. what it had already said stays on screen', text.startsWith('half a reply, '), JSON.stringify(text));
    ok('23. the next model continues behind the visible seam, in the same text channel', text.includes('connection to the model dropped') && text.endsWith('the rest'), JSON.stringify(text));
    ok('24. exactly two candidates were dialed', dialed.join(',') === `${S},${C}`, dialed.join(','));
    ok('25. the stream then finished normally', finish === 'stop', finish);
    ok('26. the staller is cooling down and the continuer is not', isInCooldown('groq', S) && !isInCooldown('groq', C), JSON.stringify({ staller: isInCooldown('groq', S), continuer: isInCooldown('groq', C) }));

    globalThis.fetch = realFetch;
    g.__tiermuxTestConfig = prevCfg;
    for (const m of [S, C]) recordOutcome('groq', m, true);
  }

  console.log('— a slow but FLOWING reply is never cut: the stall gate counts from the most recent chunk —');
  {
    const g = globalThis as { __tiermuxTestConfig?: Record<string, unknown> };
    const prevCfg = g.__tiermuxTestConfig;
    g.__tiermuxTestConfig = { ...(prevCfg ?? {}), streamIdleTimeoutMs: 300 };
    const F = 'flowing', C = 'continuer-2';
    setModelSources(makeSources([entry('groq', F, 0), entry('groq', C, 1)]));
    for (const m of [F, C]) recordOutcome('groq', m, true);
    __resetTaskRoundCounters();
    const dialed: string[] = [];
    const enc = new TextEncoder();
    globalThis.fetch = (async (_url: unknown, init?: { body?: string; signal?: AbortSignal }) => {
      const model = (JSON.parse(init?.body ?? '{}') as { model?: string }).model ?? '?';
      dialed.push(model);
      let ctrl!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c;
          // First token at once, then a heartbeat every 150 ms — each gap is under the 300 ms
          // gate, though the whole reply takes twice that. Then it finishes normally.
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: 'slow but alive' }, finish_reason: null }] })}\n\n`));
          const beat = (left: number) => {
            if (left === 0) {
              ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`));
              ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
              ctrl.close();
              return;
            }
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model, choices: [] })}\n\n`));
            setTimeout(() => beat(left - 1), 150);
          };
          setTimeout(() => beat(3), 150);
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    type Part = { type: string; delta?: string; finishReason?: { unified?: string } };
    const parts: Part[] = [];
    let hung: string | undefined;
    const turn = createRouterProvider({ taskKind: 'chat' });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const { stream } = await turn.doStream(step());
      await Promise.race([
        (async () => { for await (const p of stream as AsyncIterable<Part>) parts.push(p); })(),
        new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error('hung')), 4_000); }),
      ]);
    } catch (e) {
      hung = e instanceof Error ? e.message : String(e);
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
    const text = parts.filter((p) => p.type === 'text-delta').map((p) => p.delta ?? '').join('');
    const finish = parts.filter((p) => p.type === 'finish').map((p) => p.finishReason?.unified).join(',');

    ok('27. a reply that keeps sending chunks is never cut, however slow', hung === undefined && finish === 'stop', JSON.stringify({ hung, finish }));
    ok('28. it was answered by the same model start to finish — no failover, no seam', dialed.join(',') === F && text === 'slow but alive', JSON.stringify({ dialed, text }));
    ok('29. and it is not punished for being slow', !isInCooldown('groq', F), String(isInCooldown('groq', F)));

    globalThis.fetch = realFetch;
    g.__tiermuxTestConfig = prevCfg;
  }

  console.log('— a stream that closes before its completion signal is reported as cut (ai >= 7.0.149 "interrupted") —');
  {
    /** One SSE frame; `finish` null = no finish_reason on the wire. */
    const sse = (model: string, delta: Record<string, unknown>, finish: string | null = null): Uint8Array => new TextEncoder()
      .encode(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const DONE = (): Uint8Array => new TextEncoder().encode('data: [DONE]\n\n');

    // Content, then the connection closes: no finish_reason and no [DONE].
    const a = await streamOnce([entry('groq', 'eof-plain', 0)], { 'eof-plain': (c) => { c.enqueue(sse('eof-plain', { content: 'half a repl' })); c.close(); } }, {});
    ok('30. no finish_reason and no [DONE] ⇒ interrupted', a.finish === 'interrupted' && a.text === 'half a repl' && !a.error, JSON.stringify({ finish: a.finish, text: a.text }));

    // Some gateways end on [DONE] without ever sending a finish_reason — that is a complete reply,
    // and must not be flagged on every turn.
    const b = await streamOnce([entry('groq', 'eof-done', 0)], { 'eof-done': (c) => { c.enqueue(sse('eof-done', { content: 'whole reply' })); c.enqueue(DONE()); c.close(); } }, {});
    ok('31. [DONE] without a finish_reason is complete, not cut', b.finish === 'stop' && b.text === 'whole reply', JSON.stringify({ finish: b.finish, text: b.text }));

    // A finish_reason followed by a plain close is the ordinary shape.
    const d = await streamOnce([entry('groq', 'eof-fr', 0)], { 'eof-fr': (c) => { c.enqueue(sse('eof-fr', { content: 'ok' }, 'stop')); c.close(); } }, {});
    ok('32. a finish_reason without [DONE] is complete too', d.finish === 'stop' && d.text === 'ok', d.finish);

    // Tool calls that streamed but were never signalled complete must not run as a finished step.
    const e = await streamOnce([entry('groq', 'eof-tool', 0)], { 'eof-tool': (c) => {
      c.enqueue(sse('eof-tool', { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'readFile', arguments: '{"path":"a' } }] }));
      c.close();
    } }, {});
    ok('33. unterminated tool calls are reported interrupted, not as a finished tool step', e.finish === 'interrupted', JSON.stringify({ finish: e.finish, parts: e.parts.map((p) => p.type) }));
  }

  console.log('— delayed hedge (opt-in): a silent head is raced by the next candidate —');
  {
    // Releases a scripted body the way a real socket would when its request is aborted.
    const abortable = (c: ReadableStreamDefaultController<Uint8Array>, signal?: AbortSignal): void => {
      signal?.addEventListener('abort', () => { try { c.error(signal.reason); } catch { /* already closed */ } }, { once: true });
    };
    const answer = (c: ReadableStreamDefaultController<Uint8Array>, model: string, text: string): void => {
      const frame = (delta: Record<string, unknown>, finish: string | null = null): Uint8Array => new TextEncoder()
        .encode(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      c.enqueue(frame({ content: text }));
      c.enqueue(frame({}, 'stop'));
      c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      c.close();
    };

    // H1: the head never speaks. After hedgeAfterMs the standby opens, answers, and serves the step.
    const H1 = 'h1-head', S1 = 'h1-standby';
    const failovers1: string[] = [];
    const served1: string[] = [];
    const h1 = await streamOnce([entry('groq', H1, 0), entry('groq', S1, 1)], {
      [H1]: abortable,
      [S1]: (c) => answer(c, S1, 'from the standby'),
    }, { hedgeAfterMs: 250 }, { onFailover: (from, reason) => failovers1.push(`${from}: ${reason}`), onModelSelected: (m) => served1.push(m) });
    ok('34. the standby answers a silent head — same channel, no seam', !h1.error && h1.finish === 'stop' && h1.text === 'from the standby', JSON.stringify({ finish: h1.finish, text: h1.text, error: h1.error instanceof Error ? h1.error.message : String(h1.error), parts: h1.parts.map((p) => p.type) }));
    ok('35. each candidate was dialled exactly once (the standby is adopted, not re-requested)', h1.dialed.join(',') === `${H1},${S1}`, h1.dialed.join(','));
    ok('36. the credit goes to the standby and the failover is reported', served1.join(',') === S1 && failovers1.length === 1 && failovers1[0].includes('answered first'), JSON.stringify({ served1, failovers1 }));
    ok('37. the silent head cools down; the standby stays clean', isInCooldown('groq', H1) && !isInCooldown('groq', S1), JSON.stringify({ head: isInCooldown('groq', H1), standby: isInCooldown('groq', S1) }));

    // H2: the head is slow but answers after the hedge opened — it wins, the standby is released unpenalised.
    const H2 = 'h2-head', S2 = 'h2-standby';
    const failovers2: string[] = [];
    const served2: string[] = [];
    const h2 = await streamOnce([entry('groq', H2, 0), entry('groq', S2, 1)], {
      [H2]: (c, signal) => { abortable(c, signal); setTimeout(() => { try { answer(c, H2, 'from the head'); } catch { /* aborted */ } }, 600); },
      [S2]: (c, signal) => { abortable(c, signal); setTimeout(() => { try { answer(c, S2, 'late standby'); } catch { /* released */ } }, 1500); },
    }, { hedgeAfterMs: 250 }, { onFailover: (from, reason) => failovers2.push(`${from}: ${reason}`), onModelSelected: (m) => served2.push(m) });
    ok('38. a slow head that answers anyway still serves — nothing of the standby leaks in', !h2.error && h2.finish === 'stop' && h2.text === 'from the head', JSON.stringify({ finish: h2.finish, text: h2.text }));
    ok('39. with no failover reported and no candidate punished', failovers2.length === 0 && served2.join(',') === H2 && !isInCooldown('groq', H2) && !isInCooldown('groq', S2), JSON.stringify({ failovers2, served2, head: isInCooldown('groq', H2), standby: isInCooldown('groq', S2) }));

    // H3: off by default — a silent head opens nothing.
    const H3 = 'h3-head', S3 = 'h3-standby';
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 700);
    const h3 = await streamOnce([entry('groq', H3, 0), entry('groq', S3, 1)], { [H3]: abortable, [S3]: (c) => answer(c, S3, 'never') }, {}, { abortSignal: ctl.signal });
    ok('40. with hedging off (the default) no standby is opened', h3.dialed.join(',') === H3, h3.dialed.join(','));
  }

  globalThis.fetch = realFetch;
  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
