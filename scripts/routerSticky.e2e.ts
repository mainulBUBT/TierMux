/* Auto must keep the model that served step 1 for the rest of the turn. Repro 2026-09-06: the
 * SDK calls doStream/doGenerate once per STEP, selectModel ran on every one of them, and its
 * equal-rank rotation counter post-increments per call — so a multi-step free-tier turn walked
 * a different peer every step (cold provider, transcript re-sent, no prompt cache). One router
 * provider instance = one turn (engine.ts creates it per runTurn); stickiness lives there.
 * Cross-turn rotation, failover and cooldowns must keep working. Run: npm run test:e2e:router-sticky */
import { setModelSources, recordOutcome, __resetTaskRoundCounters } from '../src/router/picker';
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

  globalThis.fetch = realFetch;
  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
