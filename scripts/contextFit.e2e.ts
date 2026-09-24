/* Auto must route a long transcript to a model that can hold it, and must not prune it for a
 * model it has not picked. (1) The router moves candidates whose declared window cannot hold the
 * prompt behind the chain (never out of it). (2) The engine budgets Auto's step 0 against the
 * picker's head, not the 32k fallback — that prune is sticky for the turn, so a long session lost
 * its earlier tool results even on a 1M-window model. Run: npm run test:e2e:context-fit */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setModelSources, __resetTaskRoundCounters, recordOutcome, selectModel } from '../src/router/picker';
import { createRouterProvider, preferFittingWindows } from '../src/agent/core/routerProvider';
import { runAskStream } from '../src/agent/agent';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';
import type { FallbackEntry, ChatMessage } from '../src/shared/types';
import type { AgentOpts } from '../src/agent/agent';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const entry = (platform: string, modelId: string, priority: number): FallbackEntry =>
  ({ platform, modelId, enabled: true, priority } as unknown as FallbackEntry);

const WINDOWS: Record<string, number | null> = { small: 8_192, mid: 200_000, big: 1_000_000, unknown: null };
/** mid out-ranks big, so the picker leads with it whenever both are large windows. */
const RANKS: Record<string, number> = { mid: 1 };
function useModels(ids: string[]) {
  const fallback = ids.map((id, i) => entry('groq', id, i));
  setModelSources({
    catalog: { find: (_p: string, m: string) => (m in WINDOWS ? { modelId: m, intelligenceRank: RANKS[m] ?? 2, speedRank: 1, supportsTools: true, contextWindow: WINDOWS[m] } : undefined) },
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
  for (const id of ids) recordOutcome('groq', id, true);
  __resetTaskRoundCounters();
}

/** Every request body the providers sent, in order; each answers one short SSE reply. */
const requests: Array<{ model: string; body: string }> = [];
const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  const body = init?.body ?? '{}';
  requests.push({ model: (JSON.parse(body) as { model?: string }).model ?? '?', body });
  const stream = sse({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] })
    + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } })
    + 'data: [DONE]\n\n';
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}) as typeof fetch;

async function drain(model: ReturnType<typeof createRouterProvider>, text: string) {
  const res = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text }] }] } as never);
  const reader = (res.stream as ReadableStream).getReader();
  for (;;) { const { done } = await reader.read(); if (done) break; }
}

async function main() {
  console.log('— preferFittingWindows —');
  {
    useModels(['small', 'big', 'unknown']);
    const chain = ['small', 'big', 'unknown'].map((modelId) => ({ platform: 'groq', modelId }));
    const fitted = preferFittingWindows(chain, 10_000).map((c) => c.modelId);
    ok('1. a window too small for the prompt moves behind the chain', fitted.join(',') === 'big,unknown,small', fitted.join(','));
    ok('2. it is demoted, never dropped', fitted.length === 3);
    ok('3. a prompt every window holds leaves the order alone', preferFittingWindows(chain, 1_000) === chain);
  }

  console.log('— the router serves a long prompt from a window that holds it —');
  {
    useModels(['mid', 'big']);
    requests.length = 0;
    await drain(createRouterProvider({ taskKind: 'chat' }), 'hi');
    const head = requests[0]?.model;
    ok('4. (control) a short prompt goes to the chain head', head === 'mid', head);

    useModels(['mid', 'big']);
    requests.length = 0;
    await drain(createRouterProvider({ taskKind: 'chat' }), 'x'.repeat(600_000));
    ok('5. a ~180k-token prompt skips the 200k head for the 1M window', requests[0]?.model === 'big', requests.map((r) => r.model).join(','));
    ok('6. …in one request, not a 400 first', requests.length === 1, `${requests.length}`);
  }

  console.log('— the picker leads Auto with large windows —');
  {
    useModels(['small', 'unknown', 'big']);
    const sel = await selectModel([], { taskKind: 'chat' });
    const order = [sel.model, ...sel.fallbackChain].map((k) => k.split('::')[1]);
    ok('7. a 1M window leads an 8k and an undeclared one listed before it', order[0] === 'big', order.join(','));
    ok('8. the small windows stay in the chain as failover', order.includes('small') && order.includes('unknown'), order.join(','));
  }

  console.log('— Auto step 0 is budgeted against the picked model —');
  {
    useModels(['big']);
    requests.length = 0;
    const SECRET = 'CONTEXT-FIT-MARKER-7f3a';
    const history: ChatMessage[] = [
      { role: 'user', content: 'read big.txt' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'readFile', arguments: '{"path":"big.txt"}' } }] },
      // ~36k tokens: over the 32k fallback's prune target, far under a 1M window's.
      { role: 'tool', tool_call_id: 'c1', content: `${SECRET}\n${'line of file content\n'.repeat(6_000)}` },
      { role: 'assistant', content: 'Read it.' },
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: 'Sure.' },
      { role: 'user', content: 'what was the first line of big.txt?' },
    ];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-ctxfit-'));
    const opts: AgentOpts = {
      mode: 'ask', effort: 'medium', pinnedModel: 'auto', messages: history,
      onChunk: () => {}, onTool: () => {}, onReasoning: () => {}, onModel: () => {}, onFailover: () => {},
      onStep: () => {}, onTodos: () => {}, onError: () => {},
      onAskUser: async () => ({ status: 'answered' as const, answers: [] }),
    } as AgentOpts;
    await runWithWorkspaceRoot(root, () => runAskStream(opts));
    ok('9. the turn reached the 1M-window model', requests[0]?.model === 'big', requests.map((r) => r.model).join(','));
    ok('10. step 0 still carries the earlier tool result', !!requests[0]?.body.includes(SECRET));
  }
}

main().then(() => {
  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}).catch((e) => { console.error('THREW:', e); process.exit(1); });
