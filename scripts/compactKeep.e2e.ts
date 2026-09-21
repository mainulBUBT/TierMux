/* Compaction must never erase the record of what the model CHANGED, and a stubbed read must say
 * which window it was. Repro 2026-09-21: pruneAggressive had no `tools` filter, so pruneMessages
 * removed editFile/writeFile calls too; aged stubs named a paged read by bare path.
 * Run: npm run test:e2e:compact-keep */
import type { ModelMessage } from 'ai';
import { ageToolOutputs, compactIfNeeded } from '../src/agent/core/compact';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const big = 'x'.repeat(3_000);
const call = (id: string, toolName: string, input: unknown): ModelMessage =>
  ({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName, input }] }) as ModelMessage;
const result = (id: string, toolName: string, value: string): ModelMessage =>
  ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName, output: { type: 'text', value } }] }) as ModelMessage;

const history: ModelMessage[] = [
  { role: 'user', content: 'go' },
  call('a', 'readFile', { path: 'src/big.ts', offset: 801, limit: 400 }), result('a', 'readFile', big),
  call('b', 'editFile', { path: 'src/big.ts', search: 'a', replace: 'b' }), result('b', 'editFile', 'Edited src/big.ts.'),
  call('c', 'delegateTask', { task: 'find it' }), result('c', 'delegateTask', big),
  call('d', 'grep', { pattern: 'foo' }), result('d', 'grep', 'r'),
  call('e', 'grep', { pattern: 'bar' }), result('e', 'grep', 'r'),
  call('f', 'grep', { pattern: 'baz' }), result('f', 'grep', 'r'),
];
const text = (m: ModelMessage[]) => JSON.stringify(m);

async function main() {
  console.log('— an aged read stub names its window and size —');
  const aged = ageToolOutputs(history);
  const s = text(aged.messages ?? []);
  ok('stub carries offset and limit', s.includes('readFile src/big.ts offset=801 limit=400'), s.slice(s.indexOf('[readFile'), s.indexOf('[readFile') + 90));
  ok('stub carries a line count', /chars \/ \d+ lines/.test(s));
  ok('the stubbed call is reported for cache eviction', aged.stubbed?.some((c) => c.toolName === 'readFile') === true);

  console.log('\n— delegateTask reports are never aged —');
  ok('the sub-agent report survives verbatim', s.includes(big), 'report intact');
  ok('and is not listed as stubbed', !aged.stubbed?.some((c) => c.toolName === 'delegateTask'));

  console.log('\n— tier-2 prune keeps the record of edits —');
  const pruned = compactIfNeeded(history, 100).messages ?? [];
  const p = text(pruned);
  ok('editFile call survives the aggressive prune', p.includes('"toolName":"editFile"') && p.includes('"tool-call"'));
  ok('editFile result survives', p.includes('Edited src/big.ts.'));
  ok('old reads are still dropped', !p.includes('src/big.ts","offset"'));

  console.log(bad === 0 ? '\nCompaction keeps edit records.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();
