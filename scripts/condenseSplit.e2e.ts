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

  /* The file list is the load-bearing part of a summary on a multi-file task: it is what stops the
   * agent forgetting which files it already touched. SUMMARY_SYSTEM mandates the section, but a
   * prompt is a request, not a guarantee — and free models drop mandated sections under load. So
   * it is enforced in code, and merged FORWARD so a file touched before an earlier compaction is
   * not silently dropped once its messages age out. */
  console.log('\n— Files section: enforced in code, not trusted to the model —');
  {
    const call = (name: string, path: string, id: string): ChatMessage => ({
      role: 'assistant', content: '',
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify({ path }) } }],
    });
    const withFiles: ChatMessage[] = [
      { role: 'user', content: 'refactor the checkout flow' },
      call('readFile', 'src/checkout/cart.ts', 't1'),
      { role: 'tool', tool_call_id: 't1', content: 'contents' },
      call('editFile', 'src/checkout/pay.ts', 't2'),
      { role: 'tool', tool_call_id: 't2', content: 'edited' },
      { role: 'assistant', content: 'done with those two' },
    ];
    for (let i = 0; i < 20; i++) withFiles.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `follow-up ${i}` });

    // The failure mode this exists to catch: a model that ignores the mandated section entirely.
    const omitted = await condenseHistory(withFiles, fakeRouter('## Goal\nrefactor\n\n## Done\nsome work'));
    ok('a summary with NO files section gets one appended', !!omitted?.summary.includes('## Files & symbols touched'));
    ok('the appended section names a file that was read', !!omitted?.summary.includes('src/checkout/cart.ts'));
    ok('the appended section names a file that was edited', !!omitted?.summary.includes('src/checkout/pay.ts'));

    // A model that wrote the section, but incompletely — the union must keep BOTH.
    const partial = await condenseHistory(
      withFiles,
      fakeRouter('## Goal\nrefactor\n\n## Files & symbols touched\n- src/checkout/cart.ts — the Cart type\n\n## Next steps\nfinish'),
    );
    ok('the model\'s own annotated entry is preserved', !!partial?.summary.includes('cart.ts — the Cart type'));
    ok('a file the model omitted is merged in', !!partial?.summary.includes('src/checkout/pay.ts'));
    ok('the annotated entry is not duplicated as a bare path', (partial?.summary.match(/src\/checkout\/cart\.ts/g) ?? []).length === 1);
    ok('other sections survive the rewrite', !!partial?.summary.includes('## Next steps') && !!partial?.summary.includes('## Goal'));

    // Merge-forward: a SECOND compaction whose prefix contains the first summary must carry that
    // summary's paths onward, even though the tool calls that produced them are long gone.
    const secondRound: ChatMessage[] = [
      { role: 'user', content: 'start' },
      { role: 'user', content: 'Summary of the earlier conversation:\n## Goal\nrefactor\n\n## Files & symbols touched\n- src/legacy/old.ts — the thing from before\n\n## Next steps\ngo' },
      { role: 'assistant', content: 'continuing' },
      call('readFile', 'src/brand/new.ts', 't9'),
      { role: 'tool', tool_call_id: 't9', content: 'contents' },
    ];
    for (let i = 0; i < 20; i++) secondRound.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `later ${i}` });
    const merged = await condenseHistory(secondRound, fakeRouter('## Goal\nrefactor\n\n## Done\nmore work'));
    ok('a path from the PREVIOUS summary survives the next compaction', !!merged?.summary.includes('src/legacy/old.ts'));
    ok('the newly touched file is there too', !!merged?.summary.includes('src/brand/new.ts'));
  }

  /* 2026-08-25 live repro: a degenerate model loop left dozens of identical grep round-trips
   * in the prefix, and the wall of repetition blanked every summarizer attempt — "Compaction
   * produced no summary after retrying with a different model". The prefix must be mechanically
   * collapsed BEFORE it reaches the summarizer. */
  console.log('\n— Degenerate-loop prefix: collapsed before the summarizer sees it —');
  {
    const looped: ChatMessage[] = [
      { role: 'user', content: 'find why +971 is prepended to phone numbers' },
      { role: 'assistant', content: 'looking' },
      { role: 'user', content: 'the registration flow specifically' },
    ];
    const ARGS = JSON.stringify({ pattern: 'country' });
    for (let i = 0; i < 12; i++) {
      looped.push({ role: 'assistant', content: '', tool_calls: [{ id: `g${i}`, type: 'function', function: { name: 'grep', arguments: ARGS } }] });
      looped.push({ role: 'tool', tool_call_id: `g${i}`, content: 'X'.repeat(3_000) });
    }
    looped.push({ role: 'assistant', content: 'findings so far' });
    // 8 full user/assistant pairs keep the KEEP_TAIL boundary INSIDE these turns, so the
    // degenerate loop lands in the prefix (what gets summarized), not the verbatim tail.
    for (let i = 0; i < 8; i++) {
      looped.push({ role: 'user', content: `later ${i}` });
      looped.push({ role: 'assistant', content: `reply ${i}` });
    }

    const seen: ChatMessage[][] = [];
    const capturing = {
      async pickUtilityModel() { return 'utility-fake'; },
      async route(req: ChatMessage[]) {
        seen.push(req);
        return {
          platform: 'custom' as const,
          model: 'utility',
          response: {
            id: 'r', object: 'chat.completion' as const, created: 0, model: 'fake',
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant' as const, content: 'LOOP SUMMARY' } }],
          },
        };
      },
    } as unknown as Router;

    const loopCondensed = await condenseHistory(looped, capturing);
    ok('degenerate-loop session still compacts', loopCondensed !== null);
    const sent = seen[0] ?? [];
    ok('summarizer received the collapsed run, not 12 copies (first + last + marker)',
      sent.filter((m) => m.role === 'tool').length === 2 && sent.some((m) => String(m.content).includes('repeated 10 more time')));
    ok('what the summarizer received is far smaller than the raw history',
      JSON.stringify(sent).length < JSON.stringify(looped).length);
    ok('the original question is still in what the summarizer sees',
      sent.some((m) => String(m.content).includes('+971')));
  }

  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();
