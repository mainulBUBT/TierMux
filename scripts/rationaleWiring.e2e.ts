/**
 * End-to-end proof that the "Why this model?" report reaches the host naming the model that
 * ACTUALLY served — not chain[0]. rationaleServed.e2e.ts tests the pure relabelling; this
 * drives the real createRouterProvider().doStream() path with a stubbed fetch, so a fix that
 * exists but is never CALLED still fails here.
 *
 * Repro shape: chain[0] answers 429, chain[1] streams a normal reply.
 */
import { createRouterProvider, setModelSources } from '../src/agent/core/routerProvider';
import type { SelectionRationale } from '../src/router/picker';
import type { FallbackEntry } from '../src/shared/types';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const entry = (platform: string, modelId: string, priority: number): FallbackEntry =>
  ({ platform, modelId, enabled: true, priority } as unknown as FallbackEntry);

const fallback = [entry('groq', 'first-choice', 0), entry('cerebras', 'the-one-that-answers', 1)];
setModelSources({
  catalog: { find: () => ({ intelligenceRank: 1, supportsTools: true }) },
  settings: {
    getFallback: () => fallback,
    getDisabledProviders: () => [],
    enabledByPriority: () => fallback,
  },
  secrets: {
    getKeys: async () => ['sk-test'],
    getCloudflareAccountId: async () => undefined,
    isToolIncompatible: () => false,
  },
} as unknown as Parameters<typeof setModelSources>[0]);

/** groq → 429; cerebras → one SSE chunk then [DONE]. */
const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
globalThis.fetch = (async (url: string | URL | Request) => {
  const u = String(typeof url === 'object' && 'url' in url ? url.url : url);
  if (u.includes('groq.com')) {
    return new Response('{"error":"rate limited"}', { status: 429, headers: { 'content-type': 'application/json' } });
  }
  const body = sse({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] })
             + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } })
             + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}) as typeof fetch;

async function main() {
  const seen: SelectionRationale[] = [];
  let selectedModel = '';
  const model = createRouterProvider({
    onSelectionRationale: (r) => seen.push(JSON.parse(JSON.stringify(r))),
    onModelSelected: (p, m) => { selectedModel = `${p}::${m}`; },
  });

  const res = await model.doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hey' }] }],
  } as never);
  // Drain the stream so the success path (and reportServed) actually runs.
  const reader = (res.stream as ReadableStream).getReader();
  for (;;) { const { done } = await reader.read(); if (done) break; }

  ok('1. a later candidate actually served', selectedModel === 'cerebras::the-one-that-answers', selectedModel);
  ok('2. the host received more than the up-front report', seen.length >= 2, `emissions=${seen.length}`);

  const last = seen[seen.length - 1];
  ok('3. the FINAL report names the model that served',
     last?.picked === 'cerebras::the-one-that-answers', last?.picked ?? '<none>');
  ok('4. the served model is the one marked selected',
     !!last?.entries.find((e) => e.model === 'cerebras::the-one-that-answers')?.selected);
  ok('5. the failed chain[0] is no longer marked selected',
     last?.entries.find((e) => e.model === 'groq::first-choice')?.selected === false);
  ok('6. the failed chain[0] reads as attempted',
     !!last?.entries.find((e) => e.model === 'groq::first-choice')?.reason.includes('failed over'),
     last?.entries.find((e) => e.model === 'groq::first-choice')?.reason ?? '');
  ok('7. the FIRST emission was still the up-front chain[0] guess (kept for total-failure turns)',
     seen[0]?.picked === 'groq::first-choice', seen[0]?.picked ?? '<none>');
}

main().then(() => {
  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}).catch((e) => { console.error('THREW:', e); process.exit(1); });
