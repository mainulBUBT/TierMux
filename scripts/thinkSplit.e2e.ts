// Think-splitting contract for the v3 streaming path: `<think>` content goes to the REASONING
// channel; tags split across chunks work at EVERY split position; duplicate reasoning (native
// field AND <think> markup) is suppressed, first channel wins; an unclosed block surfaces on
// flush. Drives ThinkStripper and createStreamTextSplitter directly. Run: npm run test:e2e:think-split

import { ThinkStripper } from '../src/util/thinkTags';
import { createStreamTextSplitter, foldEmptyFinal, needsFinalNudge } from '../src/agent/core/routerProvider';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : ` — ${d}`}`);
  if (!c) bad++;
};

function runChunks(chunks: string[]): { text: string; reasoning: string } {
  const s = createStreamTextSplitter();
  const out = { text: '', reasoning: '' };
  for (const c of chunks) {
    const r = s.feed(c, '');
    out.text += r.text;
    out.reasoning += r.reasoning;
  }
  const f = s.flush();
  out.text += f.text;
  out.reasoning += f.reasoning;
  return out;
}

const FULL = 'before <think>hidden reasoning</think> after';

// ── 1. Basic separation ────────────────────────────────────────────────────────
{
  const r = runChunks([FULL]);
  ok('1. chat text excludes the think block', r.text === 'before  after', JSON.stringify(r.text));
  ok('1. think content lands in reasoning', r.reasoning === 'hidden reasoning', JSON.stringify(r.reasoning));
}

// ── 2. `<think>` split at EVERY position ──────────────────────────────────────
{
  const open = '<think>';
  let all = true;
  for (let i = 1; i < open.length; i++) {
    const r = runChunks(['before ', open.slice(0, i), open.slice(i), 'hidden</think> after']);
    if (r.text !== 'before  after' || r.reasoning !== 'hidden') {
      all = false;
      console.log(`      split@${i}: text=${JSON.stringify(r.text)} reasoning=${JSON.stringify(r.reasoning)}`);
    }
  }
  ok('2. <think> split at any position still separates', all);
}

// ── 3. `</think>` split at EVERY position ─────────────────────────────────────
{
  const close = '</think>';
  let all = true;
  for (let i = 1; i < close.length; i++) {
    const r = runChunks(['before <think>hidden', close.slice(0, i), close.slice(i), ' after']);
    if (r.text !== 'before  after' || r.reasoning !== 'hidden') {
      all = false;
      console.log(`      split@${i}: text=${JSON.stringify(r.text)} reasoning=${JSON.stringify(r.reasoning)}`);
    }
  }
  ok('3. </think> split at any position still separates', all);
}

// ── 4. Both tags split across three chunks ────────────────────────────────────
{
  const r = runChunks(['bef<th', 'ink>hid', 'den</th', 'ink>after']);
  ok('4. both tags split mid-stream', r.text === 'befafter' && r.reasoning === 'hidden',
    `text=${JSON.stringify(r.text)} reasoning=${JSON.stringify(r.reasoning)}`);
}

// ── 5. Unclosed think block (R1 thinking to EOF) ──────────────────────────────
{
  const r = runChunks(['<think>still thinking', ' and more thinking']);
  ok('5. unclosed block: everything is reasoning', r.reasoning === 'still thinking and more thinking' && r.text === '',
    `text=${JSON.stringify(r.text)} reasoning=${JSON.stringify(r.reasoning)}`);
}

// ── 6. No tags → passthrough ──────────────────────────────────────────────────
{
  const r = runChunks(['plain ', 'answer only']);
  ok('6. no tags: pure passthrough', r.text === 'plain answer only' && r.reasoning === '');
}

// ── 7. Case-insensitive tags ──────────────────────────────────────────────────
{
  const r = runChunks(['a<THINK>sec</THINK>b']);
  ok('7. case-insensitive tags', r.text === 'ab' && r.reasoning === 'sec',
    `text=${JSON.stringify(r.text)} reasoning=${JSON.stringify(r.reasoning)}`);
}

// ── 8. Interleaved blocks ─────────────────────────────────────────────────────
{
  const r = runChunks(['a<think>r1</think>b<think>r2</think>c']);
  ok('8. interleaved blocks', r.text === 'abc' && r.reasoning === 'r1r2',
    `text=${JSON.stringify(r.text)} reasoning=${JSON.stringify(r.reasoning)}`);
}

// ── 9. Duplicate reasoning: both channels carry the same thinking ─────────────
{
  // native reasoning arrives FIRST in the same chunk as the think-marked content → think suppressed
  const s1 = createStreamTextSplitter();
  let a1 = '';
  let r1 = '';
  for (const [content, native] of [['<think>abc</think>', 'abc'], ['answer', '']] as Array<[string, string]>) {
    const out = s1.feed(content, native);
    a1 += out.text; r1 += out.reasoning;
  }
  const f1 = s1.flush();
  a1 += f1.text; r1 += f1.reasoning;
  ok('9. native-first: think channel suppressed (no doubling)', r1 === 'abc' && a1 === 'answer',
    `text=${JSON.stringify(a1)} reasoning=${JSON.stringify(r1)}`);

  // think-marked content arrives FIRST → native suppressed
  const s2 = createStreamTextSplitter();
  let a2 = '';
  let r2 = '';
  for (const [content, native] of [['<think>xyz</think>', ''], ['answer', 'xyz']] as Array<[string, string]>) {
    const out = s2.feed(content, native);
    a2 += out.text; r2 += out.reasoning;
  }
  const f2 = s2.flush();
  a2 += f2.text; r2 += f2.reasoning;
  ok('9. think-first: native channel suppressed (no doubling)', r2 === 'xyz' && a2 === 'answer',
    `text=${JSON.stringify(a2)} reasoning=${JSON.stringify(r2)}`);
}

// ── 10. Unclosed think + native already won → flush emits nothing extra ───────
{
  const s = createStreamTextSplitter();
  s.feed('', 'native wins');
  s.feed('<think>trailing junk that never closes', '');
  const f = s.flush();
  ok('10. flush suppressed when native owns the channel', f.reasoning === '' && f.text === '',
    `flush=${JSON.stringify(f)}`);
}

// ── 11. Legacy feed()/flush() semantics unchanged (Router-backed path) ────────
{
  const t = new ThinkStripper();
  let text = '';
  for (const c of ['before ', '<thi', 'nk>hidden</th', 'ink> after']) text += t.feed(c);
  text += t.flush();
  ok('11. legacy feed(): split tags, think discarded', text === 'before  after', JSON.stringify(text));

  const u = new ThinkStripper();
  let dropped = '';
  for (const c of ['<think>never closes']) dropped += u.feed(c);
  dropped += u.flush();
  ok('11. legacy flush(): unclosed think fully discarded', dropped === '', JSON.stringify(dropped));
}

// ── 12. Empty-final fold (gpt-oss/Groq live shape) ────────────────────────────
{
  // Everything in the reasoning channel, final channel empty → reasoning becomes the reply.
  ok('12. fold: reasoning-only stream promotes to reply',
    foldEmptyFinal(false, 0, '  the actual answer  ') === 'the actual answer');
  ok('12. fold: text already present → no fold',
    foldEmptyFinal(true, 0, 'reasoning') === '');
  ok('12. fold: tool calls present → no fold (loop continues, not a reply)',
    foldEmptyFinal(false, 1, 'reasoning') === '');
  ok('12. fold: nothing carried → no fold', foldEmptyFinal(false, 0, '   ') === '');
}

// ── 13. Final-answer nudge decision (live regression: meta-deliberation promoted) ──
{
  // "thought, no answer, no tool" → nudge first, never fold deliberation directly.
  ok('13. nudge: reasoning-only end triggers a nudge',
    needsFinalNudge(false, 0, 'the query is weird, let me read X') === true);
  ok('13. nudge: text arrived → no nudge', needsFinalNudge(true, 0, 'thinking') === false);
  ok('13. nudge: tool call arrived → no nudge (loop continues)', needsFinalNudge(false, 1, 'thinking') === false);
  ok('13. nudge: nothing carried → no nudge', needsFinalNudge(false, 0, '') === false);
  // The nudge and the fold fire on the SAME shape — the doStream loop guarantees ordering:
  // nudge once, fold only after the nudge also came back empty.
  ok('13. nudge+fold share the degenerate shape',
    needsFinalNudge(false, 0, 'x') === (foldEmptyFinal(false, 0, 'x') !== ''));
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad ? 1 : 0);
