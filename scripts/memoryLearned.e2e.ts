/* Corrections learned across sessions (2026-09-06): a compaction's "Corrections & rejected
 * approaches" section is appended to .tiermux/memory.md — de-duplicated, capped, never
 * displacing the user's own text — and the summary exposes it without an extra model call.
 * Run: npm run test:e2e:memory-learned */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendLearned, loadUserMemory } from '../src/context/userMemory';
import { parseSummarySection } from '../src/agent/condense';
import { ModelStatsStore } from '../src/config/modelStats';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-mem-'));
  (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
    { uri: vscode.Uri.file(root), name: 'mem', index: 0 },
  ];
  const memPath = path.join(root, '.tiermux', 'memory.md');

  console.log('— the summary section is the source —');
  const summary = '## Goal\n- x\n\n## Corrections & rejected approaches\n- Do not add explanatory comments to the code\n- (none)\n- Use Bengali in replies\n\n## Done\n- y';
  const corrections = parseSummarySection(summary, '## Corrections & rejected approaches');
  ok('1. entries parsed, "(none)" skipped', corrections.length === 2 && corrections[0].startsWith('Do not add'));
  ok('2. an absent section yields nothing', parseSummarySection('## Goal\n- x', '## Corrections & rejected approaches').length === 0);

  console.log('— first write creates the file with the header —');
  ok('3. no memory file yet', !fs.existsSync(memPath));
  const added = await appendLearned(corrections);
  ok('4. both corrections added', added === 2);
  const text = fs.readFileSync(memPath, 'utf8');
  ok('5. header present', text.startsWith('# TierMux memory'));
  ok('6. learned section present', text.includes('## Learned from corrections') && text.includes('- Use Bengali in replies'));

  console.log('— de-dup and the user\'s own text —');
  fs.writeFileSync(memPath, 'Always answer in Bengali.\nPrefer sed over python for edits.\n\n## Learned from corrections (agent-maintained)\n- Do not add explanatory comments to the code\n', 'utf8');
  const again = await appendLearned(['do not add explanatory comments to the code!', 'Never run the full test suite unprompted', 'x']);
  ok('7. duplicate (case/punctuation) not re-added, too-short entry dropped', again === 1, `${again}`);
  const t2 = fs.readFileSync(memPath, 'utf8');
  ok('8. user text preserved verbatim at the top', t2.startsWith('Always answer in Bengali.\nPrefer sed over python for edits.'));
  ok('9. exactly one learned copy of the duplicate', (t2.match(/explanatory comments/g) ?? []).length === 1);

  console.log('— cap: newest kept —');
  await appendLearned(Array.from({ length: 30 }, (_, i) => `Rule number ${i} about something specific`));
  const t3 = fs.readFileSync(memPath, 'utf8');
  const learnedLines = t3.split('## Learned from corrections')[1].split('\n').filter((l) => l.startsWith('- '));
  ok('10. learned section capped at 20 entries', learnedLines.length === 20, `${learnedLines.length}`);
  ok('11. the newest entry survives, the oldest is gone', t3.includes('Rule number 29') && !t3.includes('Do not add explanatory'));

  console.log('— injection keeps the user text ahead of the learned block —');
  const injected = await loadUserMemory();
  ok('12. user text first', injected.startsWith('Always answer in Bengali.'));
  ok('13. learned block follows', injected.includes('## Learned from corrections'));
  ok('14. total stays small', injected.length <= 1500 + 1200 + 4, `${injected.length}`);

  console.log('— implicit routing signals are half a vote, on top of votes —');
  {
    const store = new Map<string, unknown>();
    const mem = { get: (k: string, d: unknown) => store.get(k) ?? d, update: async (k: string, v: unknown) => { store.set(k, v); } } as unknown as vscode.Memento;
    const stats = new ModelStatsStore(mem);
    stats.recordSignal('coding', 'groq', 'a', 'verifyPassed');
    ok('15. one pass alone rounds to 0 (no single-turn luck)', stats.score('coding', 'groq', 'a') === 0);
    stats.recordSignal('coding', 'groq', 'a', 'verifyPassed');
    ok('16. two passes = +1', stats.score('coding', 'groq', 'a') === 1);
    stats.recordSignal('coding', 'groq', 'a', 'stuck');
    stats.recordSignal('coding', 'groq', 'a', 'verifyFailed');
    ok('17. two failures cancel them', stats.score('coding', 'groq', 'a') === 0);
    stats.recordVote('coding', 'groq', 'a', 'down');
    ok('18. a user vote still outweighs', stats.score('coding', 'groq', 'a') === -1);
    ok('19. persisted', !!(store.get('tiermux.modelStats') as Record<string, unknown>)['coding::groq::a']);
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
