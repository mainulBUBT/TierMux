/* Compaction: the budget comes from the SERVED model and the transcript surgery is the SDK's.
 * (1) A flat 32k budget was wrong both ways — an 8k model never reached it and overflowed, a
 * 200k model compacted at 16% and threw away evidence. (2) The hand-rolled pass stubbed EVERY
 * older tool result; pruneMessages is granular and drops the assistant tool-call part with its
 * result, so the wire never sees an orphaned tool_call_id — the last block guards that.
 * Run: npm run test:e2e:compact-budget */
import type { ModelMessage } from 'ai';
import { compactIfNeeded, estimateTokens } from '../src/agent/core/compact';
import { resolveExecutionProfile } from '../src/agent/executionProfile';
import type { CatalogModel } from '../src/shared/types';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const model = (contextWindow: number): CatalogModel =>
  ({ platform: 'p', modelId: 'm', intelligenceRank: 3, contextWindow } as unknown as CatalogModel);

/** One assistant tool-call + its tool result, as the engine's converter emits them. */
function pair(id: string, toolName: string, payload: string): ModelMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName, input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName, output: { type: 'text', value: payload } }] },
  ] as ModelMessage[];
}

const FAT = 'x'.repeat(4000);

function transcript(): ModelMessage[] {
  const out: ModelMessage[] = [{ role: 'user', content: 'find the refund bug' }];
  for (let i = 0; i < 6; i++) out.push(...pair(`g${i}`, 'grep', FAT));
  for (let i = 0; i < 6; i++) out.push(...pair(`r${i}`, 'readFile', FAT));
  out.push({ role: 'assistant', content: [{ type: 'text', text: 'here is what I found' }] } as ModelMessage);
  return out;
}

console.log('— the budget tracks the model\'s own window —');
{
  const small = resolveExecutionProfile(model(8_192)).pruneTarget;
  const large = resolveExecutionProfile(model(200_000)).pruneTarget;
  ok('an 8k model gets a budget UNDER its window', small < 8_192, `${small}`);
  ok('...which the old flat 32k could never reach', small < 32_768, `${small} vs 32768`);
  ok('a 200k model gets far more than the old flat 32k', large > 32_768, `${large}`);
  ok('unknown model still yields a usable fallback', resolveExecutionProfile(undefined).pruneTarget > 0);
}

console.log('\n— compaction fires on the small model and not on the large one —');
{
  const msgs = transcript();
  const tokens = estimateTokens(msgs);
  const small = resolveExecutionProfile(model(8_192)).pruneTarget;
  const large = resolveExecutionProfile(model(200_000)).pruneTarget;
  ok('fixture is over the small budget and under the large one',
    tokens > small && tokens < large, `${tokens} tokens`);
  ok('small window compacts', compactIfNeeded(msgs, small).messages !== undefined);
  ok('large window leaves the transcript alone', compactIfNeeded(msgs, large).messages === undefined);
}

console.log('\n— tier 1 sheds re-derivable searches before file reads —');
{
  const msgs = transcript();
  // A budget just under the fixture: tier 1 alone should clear it.
  const budget = Math.floor(estimateTokens(msgs) / 1.4);
  const out = compactIfNeeded(msgs, budget).messages!;
  const names = out.flatMap((m) => Array.isArray(m.content)
    ? (m.content as Array<{ type: string; toolName?: string }>)
        .filter((p) => p.type === 'tool-result').map((p) => p.toolName!) : []);
  ok('grep results are dropped', !names.includes('grep'), names.join(',') || '<none>');
  ok('readFile evidence survives', names.includes('readFile'), names.join(',') || '<none>');
  ok('the final answer text is untouched',
    JSON.stringify(out).includes('here is what I found'));
}

console.log('\n— tier 2 escalates when tier 1 is not enough —');
{
  const msgs = transcript();
  const out = compactIfNeeded(msgs, 200).messages!;
  const kept = out.flatMap((m) => Array.isArray(m.content)
    ? (m.content as Array<{ type: string; toolName?: string }>)
        .filter((p) => p.type === 'tool-result').map((p) => p.toolName!) : []);
  ok('a tiny budget sheds file reads too', kept.length < 6, `${kept.length} tool results kept`);
  ok('and still shrinks the transcript', estimateTokens(out) < estimateTokens(msgs),
    `${estimateTokens(msgs)} → ${estimateTokens(out)}`);
}

console.log('\n— no orphaned tool_call_id survives either tier (OpenAI wire invariant) —');
{
  for (const budget of [Math.floor(estimateTokens(transcript()) / 1.4), 200]) {
    const out = compactIfNeeded(transcript(), budget).messages!;
    const calls = new Set<string>(); const results = new Set<string>();
    for (const m of out) {
      if (!Array.isArray(m.content)) continue;
      for (const p of m.content as Array<{ type: string; toolCallId?: string }>) {
        if (p.type === 'tool-call') calls.add(p.toolCallId!);
        if (p.type === 'tool-result') results.add(p.toolCallId!);
      }
    }
    const orphanResults = [...results].filter((id) => !calls.has(id));
    const orphanCalls = [...calls].filter((id) => !results.has(id));
    ok(`budget ${budget}: every tool result has its call`, orphanResults.length === 0, orphanResults.join(','));
    ok(`budget ${budget}: every tool call has its result`, orphanCalls.length === 0, orphanCalls.join(','));
  }
}

console.log(bad === 0 ? '\nAll compaction gates hold.' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
