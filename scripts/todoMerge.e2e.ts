/* The todo list stays one list across rewrites, failovers and Continue. Owner report 2026-11-04:
 * "todo bar bar change hoy". Run: npm run test:e2e:todo-merge */
import { mergeTodos, createTodoWriteTool } from '../src/agent/core/tools/v3/todoWrite';
import type { TodoItem } from '../src/shared/types';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };
const t = (content: string, status: TodoItem['status'] = 'pending'): TodoItem => ({ content, status });
const texts = (l: TodoItem[]) => l.map((x) => x.content);

const base = [t('Fix roundCents in src/lib/money.js', 'completed'), t('Make coupon codes case-insensitive', 'in_progress'), t('Add regression tests')];

const status = mergeTodos(base, [t('Fix roundCents in src/lib/money.js', 'completed'), t('Make coupon codes case-insensitive', 'completed'), t('Add regression tests', 'in_progress')]);
ok('a status update changes only statuses', JSON.stringify(texts(status)) === JSON.stringify(texts(base)) && status[1].status === 'completed' && status[2].status === 'in_progress');

const reworded = mergeTodos(base, [t('Add the regression tests now', 'in_progress'), t('Coupon codes: make them case-insensitive'), t('Fix the roundCents function')]);
ok('similar wording in another order keeps the first wording and order', JSON.stringify(texts(reworded)) === JSON.stringify(texts(base)), JSON.stringify(texts(reworded)));
ok('and the new status lands on the right item', reworded[2].status === 'in_progress');

const undone = mergeTodos(base, [t('Fix roundCents in src/lib/money.js', 'pending'), t('Make coupon codes case-insensitive'), t('Add regression tests')]);
ok('a finished item stays finished', undone[0].status === 'completed');

const added = mergeTodos(base, [...base, t('Update the changelog')]);
ok('new work is appended', added.length === 4 && added[3].content === 'Update the changelog');

const dropped = mergeTodos(base, [t('Fix roundCents in src/lib/money.js', 'completed')]);
ok('a shorter list does not erase items', dropped.length === 3 && dropped[1].status === 'in_progress', JSON.stringify(dropped));

const rewritten = mergeTodos(base, [t('Correct rounding'), t('Normalize promo lookups', 'in_progress'), t('Write specs')]);
ok('a full reword of the same length stays in place', JSON.stringify(texts(rewritten)) === JSON.stringify(texts(base)) && rewritten[1].status === 'in_progress' && rewritten[0].status === 'completed', JSON.stringify(rewritten));

ok('an empty list clears', mergeTodos(base, []).length === 0);
ok('the first list is taken as written', texts(mergeTodos([], base)).length === 3);
const bn = mergeTodos([t('কুপন কোড ঠিক করা')], [t('কুপন কোড ঠিক করা হবে', 'completed')]);
ok('Bengali wording matches too', bn.length === 1 && bn[0].content === 'কুপন কোড ঠিক করা' && bn[0].status === 'completed', JSON.stringify(bn));

async function main() {
  const seen: TodoItem[][] = [];
  let current: TodoItem[] | undefined = base;
  const tool = createTodoWriteTool((l) => { seen.push(l); current = l; }, () => current);
  const out = await (tool as unknown as { execute: (i: unknown) => Promise<string> }).execute({ todos: [{ content: 'Add the regression tests now', status: 'in_progress' }, { content: 'Coupon codes: make them case-insensitive', status: 'pending' }, { content: 'Fix the roundCents function', status: 'pending' }] });
  ok('the tool posts the merged list and tells the model', texts(seen[0]).join() === texts(base).join() && String(out).includes('Make coupon codes case-insensitive'), String(out).slice(0, 120));
  console.log(bad === 0 ? '\nTodo list stays stable.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();
