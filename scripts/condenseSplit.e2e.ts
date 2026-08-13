/* condenseHistory must actually be able to compact a tool-heavy session.
 *
 * From a 2026-08-13 audit: the tail boundary was found by scanning FORWARD from
 * `length - KEEP_TAIL` for a `user` message. A tool-heavy agentic session ends in a long
 * `assistant`/`tool` run, so the scan walked off the end and `condenseHistory` returned null —
 * meaning the sessions with the LARGEST contexts, exactly the ones compaction exists for, could
 * never compact. The user saw "Compaction produced no summary after retrying with a different
 * model", `maybeAutoCompact` was a silent no-op every turn, and the context grew until
 * `fitMessages` began evicting the user's own task (see fitMessages.e2e.ts — same root symptom).
 *
 * Scanning BACKWARD finds a boundary while preserving the invariant that matters: the verbatim
 * tail starts on a `user` turn, so no tool result is orphaned and no tool call is left dangling.
 *
 * Run: npm run test:e2e:condense-split
 */
import { condenseHistory, shouldCondense } from '../src/agent/condense';
import type { Router } from '../src/router/router';
import type { ChatMessage } from '../src/shared/types';

let bad = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) bad++; };

function fakeRouter(summary: string): Router {
  return {
    async pickUtilityModel() { return 'utility-fake'; },
    async route() {
      return {
        platform: 'custom' as const,
        model: 'utility',
        response: {
          id: 'r', object: 'chat.completion' as const, created: 0, model: 'fake',
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant' as const, content: summary } }],
        },
      };
    },
  } as unknown as Router;
}

/** The shape that regressed: a real multi-turn conversation whose LATEST turn is tool-heavy. */
const toolHeavy: ChatMessage[] = [];
for (let i = 0; i < 3; i++) {
  toolHeavy.push({ role: 'user', content: `question ${i}` });
  toolHeavy.push({ role: 'assistant', content: `answer ${i}` });
}
toolHeavy.push({ role: 'user', content: 'now refactor the affiliate controller' });
for (let i = 0; i < 20; i++) {
  toolHeavy.push(i % 2 === 0
    ? { role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'readFile', arguments: '{}' } }] }
    : { role: 'tool', tool_call_id: `c${i - 1}`, content: 'X'.repeat(20_000) });
}

/** A plain alternating chat — must behave exactly as before (no regression). */
const plainChat: ChatMessage[] = [];
for (let i = 0; i < 40; i++) plainChat.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` });

async function main(): Promise<void> {
  ok('tool-heavy session is long enough to warrant condensing', shouldCondense(toolHeavy));

  const heavy = await condenseHistory(toolHeavy, fakeRouter('SUMMARY OF EARLIER WORK'));
  ok('tool-heavy session now compacts at all (was null before the fix)', heavy !== null);
  if (heavy) {
    ok('result leads with the summary', String(heavy.messages[0]?.content).includes('SUMMARY OF EARLIER WORK'));
    ok('verbatim tail starts on a user turn (no orphaned tool result)',
      heavy.messages[1]?.role === 'user');
    ok('compaction actually shrinks the context',
      JSON.stringify(heavy.messages).length < JSON.stringify(toolHeavy).length);
    ok('the active task survives into the tail',
      heavy.messages.some((m) => String(m.content).includes('refactor the affiliate controller')));
  }

  const chat = await condenseHistory(plainChat, fakeRouter('CHAT SUMMARY'));
  ok('plain chat still compacts (no regression)', chat !== null);
  if (chat) {
    ok('plain chat tail also starts on a user turn', chat.messages[1]?.role === 'user');
  }

  const tooShort = await condenseHistory(plainChat.slice(0, 4), fakeRouter('X'));
  ok('a short session is left alone', tooShort === null);

  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();
