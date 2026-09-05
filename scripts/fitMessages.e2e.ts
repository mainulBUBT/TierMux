/* fitMessages must never drop the task the model is being asked to do (2026-08-13 audit): the
 * newest-first fill spent the budget on tool output and, on a realistic turn at a 2.5k budget,
 * shipped literally `["system"]` — the provider 400s or the model answers a question it never
 * saw. This is the mechanism behind "the agent ignores what I asked".
 * Run: npm run test:e2e:fit-messages */
import { fitMessages, estimateMessagesTokens } from '../src/agent/budget';
import type { ChatMessage } from '../src/shared/types';

let bad = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) bad++; };
const big = (n: number) => 'X'.repeat(n);

const TASK = 'Fix the affiliate self-referral bug in AffiliateCodeController';

// The exact shape that regressed: one task + two capped tool results.
const agentTurn: ChatMessage[] = [
  { role: 'system', content: 'You are TierMux.' },
  { role: 'user', content: TASK },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'readFile', arguments: '{"path":"a.php"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: big(30_000) },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'grep', arguments: '{"pattern":"affiliate"}' } }] },
  { role: 'tool', tool_call_id: 'c2', content: big(30_000) },
];

const tight = fitMessages(agentTurn, 2_500);
ok('task survives a budget far smaller than the tool output',
  tight.messages.some((m) => m.role === 'user' && String(m.content).includes('affiliate')));
ok('never returns a system-prompt-only request', tight.messages.length > 1);
ok('window does not start on an orphaned tool result', tight.messages[1]?.role !== 'tool');
ok('reports trimmed', tight.trimmed === true);

// A task bigger than the whole budget must be truncated, never deleted.
const oversized = fitMessages([
  { role: 'system', content: 'sys' },
  { role: 'user', content: big(200_000) },
], 2_500);
ok('oversized task is truncated, not dropped', oversized.messages.some((m) => m.role === 'user'));

// The LATEST user message wins over older history, not the other way round.
const multiTurn = fitMessages([
  { role: 'system', content: 'sys' },
  { role: 'user', content: `OLD QUESTION ${big(40_000)}` },
  { role: 'assistant', content: `old answer ${big(40_000)}` },
  { role: 'user', content: 'NEW TASK: add dark mode' },
], 2_000);
ok('latest task is kept in preference to older history',
  multiTurn.messages.filter((m) => m.role === 'user').some((m) => String(m.content).includes('NEW TASK')));

// Under budget: untouched, byte for byte.
const small: ChatMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }];
const untouched = fitMessages(small, 100_000);
ok('under budget returns the list unchanged', untouched.trimmed === false && untouched.messages.length === 2);

// Degenerate input (no user message anywhere, e.g. a synthesis-only call) still yields a request.
const noUser = fitMessages([
  { role: 'system', content: 's' },
  { role: 'assistant', content: big(50_000) },
], 1_000);
ok('no-user input still returns more than the system prompt', noUser.messages.length > 1);

// The fitted result actually fits (modulo the reserved-task floor).
ok('fitted output is within budget or only the reserved task exceeds it',
  estimateMessagesTokens(tight.messages) <= 2_500 || tight.messages.filter((m) => m.role === 'user').length === 1);

// The FIRST user message — the conversation's anchor — must also survive (2026-08-25:
// a tool-heavy earlier turn evicted the original task entirely, so the follow-up
// "in short bangla" was answered as a grep query against the leftover tool tail).
const crowded: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: TASK },
];
for (let i = 0; i < 10; i++) {
  crowded.push({ role: 'assistant', content: '', tool_calls: [{ id: `k${i}`, type: 'function', function: { name: 'grep', arguments: '{"pattern":"affiliate"}' } }] });
  crowded.push({ role: 'tool', tool_call_id: `k${i}`, content: big(20_000) });
}
crowded.push({ role: 'user', content: 'in short bangla' });
const anchored = fitMessages(crowded, 3_000);
ok('original task survives newest-first eviction as the anchor',
  anchored.messages.some((m) => m.role === 'user' && String(m.content).includes('affiliate')));
ok('the follow-up (latest task) is kept too',
  anchored.messages.some((m) => m.role === 'user' && String(m.content).includes('bangla')));
ok('anchor leads the fitted window (chronologically first after system)',
  anchored.messages[1]?.role === 'user');

// A giant anchor is capped, never dropped — and never allowed to eat the window.
const giantAnchor = fitMessages([
  { role: 'system', content: 'sys' },
  { role: 'user', content: big(200_000) },
  { role: 'assistant', content: 'answer' },
  { role: 'user', content: 'follow-up question' },
], 2_500);
ok('giant anchor is capped with a marker, not dropped',
  giantAnchor.messages.some((m) => m.role === 'user' && String(m.content).includes('truncated to fit')));
ok('giant anchor did not evict the latest task',
  giantAnchor.messages.some((m) => m.role === 'user' && String(m.content).includes('follow-up')));

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
