/* Real headless regression test for agentNumberSetting() (routerProvider.ts) not throwing/
 * hanging when require('vscode') fails — the actual failure mode for a genuine headless/
 * library consumer with no shim (src/index.ts: "Headless consumers need a `vscode` shim").
 * Deliberately run WITHOUT `-r ./scripts/vscodeMock.cjs` (see the matching package.json
 * entry) — every other e2e script that touches routerProvider.ts preloads that mock, which
 * is exactly why this bug went unnoticed until now. Run: npm run test:e2e:agent-settings-headless */

// No static imports from src/** here on purpose: routerProvider.ts pulls in util/diag.ts,
// which has an EAGER `import * as vscode from 'vscode'` (see diag.ts:1's own comment) — a
// static import of routerProvider.ts would hit that before the Module._load hook below is
// even installed. Every src/** import in this file is a DYNAMIC import() inside main(),
// after the hook is in place.

const Module = require('module') as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = Module._load;
let vscodeTouches = 0;
// Touch #1 is reserved for diag.ts:1's known eager import (flagged there, not fixed here —
// its own enabled() already try/catches the actual config read, so a harmless stub is enough
// to satisfy it). Every touch AFTER that reproduces the real headless failure mode for
// agentNumberSetting's lazy require('vscode') (routerProvider.ts) — that's what this test
// actually exercises. This "first touch = stub, rest = throw" sequencing is order-dependent:
// it only works because diag.ts's eager import is the sole OTHER unguarded require('vscode')
// in the closure and always fires first (module init, before any call reaches
// agentNumberSetting). If diag.ts's import is ever fixed or reordered, or another eager
// vscode touch is added ahead of it, this counting trick stops matching reality and this
// test can fail for the wrong reason — drop the counter and throw on every touch instead.
Module._load = function (this: unknown, request: string, ...rest: unknown[]) {
  if (request === 'vscode') {
    vscodeTouches++;
    if (vscodeTouches === 1) return {};
    throw new Error("Cannot find module 'vscode'");
  }
  return originalLoad.apply(Module, [request, ...rest]);
} as typeof Module._load;

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  const body = JSON.parse(init?.body ?? '{}') as { model?: string };
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: `hello from ${body.model}` }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT: ${label} hung`)), ms))]);

async function main() {
  const { createRouterProvider } = await import('../src/agent/core/routerProvider');
  const { setModelSources, recordOutcome } = await import('../src/router/picker');

  setModelSources({
    catalog: { find: () => ({ intelligenceRank: 1, speedRank: 1, supportsTools: true }) },
    settings: {
      getFallback: () => [{ platform: 'groq', modelId: 'm', enabled: true, priority: 0 }],
      getDisabledProviders: () => [],
      enabledByPriority: () => [{ platform: 'groq', modelId: 'm', enabled: true, priority: 0 }],
    },
    secrets: { getKeys: async () => ['sk-test'], getCloudflareAccountId: async () => undefined, isToolIncompatible: () => false },
  } as never);
  recordOutcome('groq', 'm', true);

  const step = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as never;

  console.log('— doGenerate reaches chainDeadlineMs()/connectTimeoutFor() without a vscode shim —');
  try {
    const gen = await withTimeout(createRouterProvider({ taskKind: 'chat' }).doGenerate(step), 5000, 'doGenerate');
    ok('1. doGenerate did not throw/hang without the vscode mock', true);
    ok('2. doGenerate returned the stubbed content', (gen as { content: Array<{ text?: string }> }).content[0]?.text === 'hello from m');
  } catch (e) {
    ok('1. doGenerate did not throw/hang without the vscode mock', false, e instanceof Error ? e.message : String(e));
    ok('2. doGenerate returned the stubbed content', false, 'skipped — threw above');
  }

  console.log('— doStream reaches ttftGateMsFor()/firstContentTimeoutMs() without a vscode shim —');
  try {
    const streamResult = await withTimeout(createRouterProvider({ taskKind: 'chat' }).doStream(step), 5000, 'doStream');
    const reader = (streamResult as { stream: ReadableStream }).stream.getReader();
    let sawText = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((value as { type?: string } | undefined)?.type === 'text-delta') sawText = true;
    }
    ok('3. doStream did not throw/hang without the vscode mock', true);
    ok('4. doStream delivered text before closing', sawText);
  } catch (e) {
    ok('3. doStream did not throw/hang without the vscode mock', false, e instanceof Error ? e.message : String(e));
    ok('4. doStream delivered text before closing', false, 'skipped — threw above');
  }
}

main().then(() => { console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`); process.exit(bad === 0 ? 0 : 1); })
  .catch((e) => { console.error('THREW:', e); process.exit(1); });
