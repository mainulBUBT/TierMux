/* Weak-model plumbing (2026-09-06, from the AI SDK's "Prompts for Tools" tips): null-valued
 * optional params are stripped before any model repair; inputExamples reach the OpenAI-shaped
 * wire inside the description; reasoning models never receive a temperature; a short follow-up
 * inherits the previous turn's task kind. Run: npm run test:e2e:weak-model-plumbing */
import { withoutNullKeys } from '../src/agent/core/repair';
import { classifyConversation } from '../src/agent/routing';
import { OpenAIResponsesProvider } from '../src/providers/openai-responses';
import { OpenAICompatProvider } from '../src/providers/openai-compat';
import { isDegenerateRepeat } from '../src/agent/core/routerProvider';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

async function main() {
  console.log('— null-valued optional params are stripped, nothing else touched —');
  ok('1. nulls removed', withoutNullKeys('{"path":"a.ts","offset":null,"limit":null}') === '{"path":"a.ts"}');
  ok('2. nothing null → undefined (no repair needed)', withoutNullKeys('{"path":"a.ts"}') === undefined);
  ok('3. malformed JSON → undefined (model repair takes over)', withoutNullKeys('{"path":') === undefined);
  ok('4. nested nulls left alone (only top-level keys)', withoutNullKeys('{"edits":[{"search":"a","replace":null}],"x":null}') === '{"edits":[{"search":"a","replace":null}]}');

  console.log('— inputExamples ride in the wire description —');
  {
    const captured: { body?: string } = {};
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
      captured.body = init?.body;
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const { createRouterProvider } = await import('../src/agent/core/routerProvider');
    const { setModelSources, recordOutcome } = await import('../src/router/picker');
    setModelSources({
      catalog: { find: () => ({ intelligenceRank: 1, speedRank: 1, supportsTools: true }) },
      settings: { getFallback: () => [{ platform: 'groq', modelId: 'm', enabled: true, priority: 0 }], getDisabledProviders: () => [], enabledByPriority: () => [{ platform: 'groq', modelId: 'm', enabled: true, priority: 0 }] },
      secrets: { getKeys: async () => ['k'], getCloudflareAccountId: async () => undefined, isToolIncompatible: () => false },
    } as never);
    recordOutcome('groq', 'm', true);
    const p = createRouterProvider({ taskKind: 'chat' });
    await p.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ type: 'function', name: 'readFile', description: 'Read a file.', inputSchema: { type: 'object' }, inputExamples: [{ input: { path: 'src/a.ts' } }] }],
    } as never);
    globalThis.fetch = realFetch;
    const desc = (JSON.parse(captured.body ?? '{}') as { tools?: Array<{ function: { description: string } }> }).tools?.[0]?.function.description ?? '';
    ok('5. description keeps its text', desc.startsWith('Read a file.'));
    ok('6. …and carries the example as JSON', desc.includes('Input examples:') && desc.includes('{"path":"src/a.ts"}'), desc);
  }

  console.log('— reasoning models get no temperature; others do —');
  {
    const resp = new OpenAIResponsesProvider({ platform: 'openai', name: 'x', baseUrl: 'https://x' } as never) as unknown as { buildBody: (m: unknown[], id: string, o: unknown, s: boolean) => string };
    const gpt5 = JSON.parse(resp.buildBody([{ role: 'user', content: 'hi' }], 'gpt-5.2', { temperature: 0 }, false));
    const gpt4 = JSON.parse(resp.buildBody([{ role: 'user', content: 'hi' }], 'gpt-4.1', { temperature: 0 }, false));
    ok('7. Responses API: gpt-5 body has no temperature', !('temperature' in gpt5));
    ok('8. Responses API: gpt-4.1 body keeps the temperature', gpt4.temperature === 0);
    const compat = new OpenAICompatProvider({ platform: 'groq', name: 'g', baseUrl: 'https://g' } as never) as unknown as { buildBody: (m: unknown[], id: string, o: unknown, s: boolean) => string };
    const oss = JSON.parse(compat.buildBody([{ role: 'user', content: 'hi' }], 'openai/gpt-oss-120b', { temperature: 0 }, false));
    const o3 = JSON.parse(compat.buildBody([{ role: 'user', content: 'hi' }], 'openai/o3', { temperature: 0 }, false));
    ok('9. compat: gpt-oss keeps temperature 0', oss.temperature === 0);
    ok('10. compat: o3 via a gateway gets none', !('temperature' in o3));
  }

  console.log('— a short follow-up inherits the working task kind —');
  ok('11. debug question stays debug', classifyConversation(['100058 order why minus in distance? and why vehicle id not set?']).kind === 'agent' || classifyConversation(['order 100058 is broken: distance is negative']).kind === 'debug');
  ok('12. "is this correct?" after a debug turn → debug', classifyConversation(['order 100058 is broken: distance is negative', 'is this the correct answer?']).kind === 'debug');
  ok('13. "issue ki?" after a coding turn → coding', classifyConversation(['refactor the getDeliveryCharge function in PlaceNewOrder.php', 'issue ki?']).kind === 'coding');
  ok('14. a long new question is classified on its own', classifyConversation(['fix the failing cart test', 'can you explain in general how laravel middleware ordering is decided for a request']).kind === 'chat');
  ok('15. a follow-up after a plain chat stays chat', classifyConversation(['what is a closure?', 'and a monad?']).kind === 'chat');
  ok('16. a greeting in between is skipped', classifyConversation(['the build is broken', 'thanks', 'and now?']).kind === 'debug');

  console.log('— a decoding loop is cut —');
  const para = 'Let me check if there is a different issue with the distance validation. The original validation was required_unless, which means it is not required for take_away orders. But the user is asking about a negative distance value.\n\n';
  ok('17. the same paragraph three times is a loop', isDegenerateRepeat('Intro text. ' + para.repeat(3)));
  ok('18. twice is not (a legitimate restatement)', !isDegenerateRepeat('Intro text. ' + para.repeat(2)));
  ok('19. long varied prose is not', !isDegenerateRepeat(Array.from({ length: 40 }, (_, i) => `Finding ${i}: value ${i * 7} differs from ${i * 3}.`).join(' ')));
  ok('20. "why X not set?" routes as debug', classifyConversation(['100058 order why minus in distance? and why vehicles id not set here?']).kind === 'debug');

  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
