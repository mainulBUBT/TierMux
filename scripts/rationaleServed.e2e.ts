/** "Why this model?" must name the model that ACTUALLY served. Repro 2026-08-31: the footer said
 *  ChatAnywhere/gpt-4.1 while the popover insisted opencode/muse-spark served — selectModel()
 *  builds the report before the first byte, and nothing re-pointed it after failover. */
import { rationaleForServed, type SelectionRationale } from '../src/router/picker';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const entry = (model: string, selected: boolean, reason: string, skip?: string) =>
  ({ model, selected, score: 1, capability: 1, runtime: 1, preference: 1, confidence: 0, reason, ...(skip ? { skip } : {}) });

/** The exact chain from the screenshot. */
const base = (): SelectionRationale => ({
  taskKind: 'chat',
  picked: 'opencode::muse-spark-1.2-contributor-free',
  entries: [
    entry('opencode::muse-spark-1.2-contributor-free', true, 'task table (chat) — serves this turn'),
    entry('ovh::Qwen3.5-397B-A17B', false, 'enabled tail · intelligence rank 1 — failover #1'),
    entry('orcarouter::deepseek/deepseek-v4-flash-free', false, 'enabled tail · intelligence rank 1 — failover #2'),
    entry('chatanywhere::gpt-4.1', false, 'enabled tail · intelligence rank 1 — failover #3'),
    entry('chatanywhere::gpt-4.1-nano', false, 'enabled tail · intelligence rank 1 — failover #4'),
    entry('openrouter::some-model', false, 'no API key stored for this platform', 'no API key stored for this platform'),
  ],
});

// ---- the reported bug ----
const fixed = rationaleForServed(base(), 'chatanywhere', 'gpt-4.1');
ok('1. picked names the model that served', fixed.picked === 'chatanywhere::gpt-4.1');
ok('2. exactly one entry is marked selected', fixed.entries.filter((e) => e.selected).length === 1);
ok('3. the served model is the selected one', !!fixed.entries.find((e) => e.model === 'chatanywhere::gpt-4.1')?.selected);
ok('4. the intended-but-failed chain[0] is NOT selected',
   fixed.entries.find((e) => e.model === 'opencode::muse-spark-1.2-contributor-free')?.selected === false);
ok('5. the winner reads "served this turn", not "failover #3"',
   fixed.entries.find((e) => e.model === 'chatanywhere::gpt-4.1')!.reason === 'enabled tail · intelligence rank 1 — served this turn');
ok('6. candidates walked past are relabelled as attempted',
   fixed.entries.find((e) => e.model === 'opencode::muse-spark-1.2-contributor-free')!.reason === 'task table (chat) — tried first, failed over');
ok('7. a candidate AFTER the winner is not claimed as attempted',
   fixed.entries.find((e) => e.model === 'chatanywhere::gpt-4.1-nano')!.reason.includes('failover #4'));
ok('8. skipped candidates keep their skip reason',
   fixed.entries.find((e) => e.model === 'openrouter::some-model')!.reason === 'no API key stored for this platform');
ok('9. the entry list is neither reordered nor truncated', fixed.entries.length === 6);

// ---- the no-op cases ----
const input = base();
const happy = rationaleForServed(input, 'opencode', 'muse-spark-1.2-contributor-free');
ok('10. chain[0] serving returns the SAME object (no needless rebuild)', happy === input);
ok('11. chain[0] serving keeps "serves this turn"',
   happy.entries[0].reason === 'task table (chat) — serves this turn' && happy.entries[0].selected);
const unknown = rationaleForServed(base(), 'someplatform', 'never-in-the-chain');
ok('12. an unknown served model leaves the report alone', unknown.picked === 'opencode::muse-spark-1.2-contributor-free');

// ---- input must not be mutated (the host keeps the original around) ----
const original = base();
rationaleForServed(original, 'chatanywhere', 'gpt-4.1');
ok('13. the input rationale is not mutated',
   original.picked === 'opencode::muse-spark-1.2-contributor-free' && original.entries[0].selected === true);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
