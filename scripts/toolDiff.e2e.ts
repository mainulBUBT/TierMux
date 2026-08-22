/**
 * ToolCard edit-diff thresholds e2e — boundary coverage for the named diff-preview constants
 * (Chat-UX-parity plan): 399→inline, 400→collapsed, 1999→collapsed, 2000→summary, plus the
 * byte cap forcing collapsed under the line cap. Runs the REAL buildEditDiff under jsdom.
 *
 * Run: npx esbuild scripts/toolDiff.e2e.ts --bundle --platform=node --format=cjs
 *        --external:vscode --external:jsdom --outfile=dist/toolDiff.e2e.cjs
 *      && node -r ./scripts/webDomMock.cjs dist/toolDiff.e2e.cjs
 */

import {
  buildEditDiff,
  INLINE_DIFF_MAX_CHANGED_LINES,
  INLINE_DIFF_MAX_BYTES,
  DIFF_PREVIEW_MAX_CHANGED_LINES,
} from '../media/src/ui/tool/ToolCard';

let pass = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log('toolDiff.e2e — named thresholds are',
  `inline<${INLINE_DIFF_MAX_CHANGED_LINES}ln & <${INLINE_DIFF_MAX_BYTES}B, collapsed<${DIFF_PREVIEW_MAX_CHANGED_LINES}ln, summary≥${DIFF_PREVIEW_MAX_CHANGED_LINES}ln`);

/** A rewrite of k old lines to k new lines ⇒ exactly 2k changed lines in the diff. */
function makeChange(k: number, lineLen = 12): { oldStr: string; newStr: string } {
  const pad = 'x'.repeat(Math.max(0, lineLen - 4));
  return {
    oldStr: Array.from({ length: k }, (_, i) => `old${i}${pad}`).join('\n'),
    newStr: Array.from({ length: k }, (_, i) => `new${i}${pad}`).join('\n'),
  };
}

{
  const { oldStr, newStr } = makeChange(199); // 398 changed lines… adjust to exactly 399:
  const oldStr399 = oldStr + '\nextra-old-line';
  const box = buildEditDiff(oldStr399, newStr, 'src/a.txt');
  const changed = 199 * 2 + 1;
  assert(changed === INLINE_DIFF_MAX_CHANGED_LINES - 1, `fixture produces ${changed} = cap-1 changed lines`);
  assert(box.querySelector('.tm-edit-diff-collapsed') === null, '399 changed lines → inline (no collapse)');
}

{
  const { oldStr, newStr } = makeChange(200); // exactly 400
  const box = buildEditDiff(oldStr, newStr, 'src/b.txt');
  assert(box.querySelector('.tm-edit-diff-collapsed') !== null, '400 changed lines → collapsed');
}

{
  const { oldStr, newStr } = makeChange(999);
  const oldStr1999 = oldStr + '\nextra-old-line';
  const box = buildEditDiff(oldStr1999, newStr, 'src/c.txt');
  assert((999 * 2 + 1) === DIFF_PREVIEW_MAX_CHANGED_LINES - 1, 'fixture produces 1999 changed lines');
  assert(box.querySelector('.tm-edit-diff-collapsed') !== null, '1999 changed lines → collapsed');
  assert(box.querySelector('.tm-diff-summary') === null, '1999 changed lines → NOT a summary-only card');
}

{
  const { oldStr, newStr } = makeChange(1000); // exactly 2000
  const box = buildEditDiff(oldStr, newStr, 'src/d.txt');
  assert(box.querySelector('.tm-diff-summary') !== null, '2000 changed lines → summary only');
  assert(box.querySelector('.tm-edit-diff-collapsed') === null, '2000 changed lines → no full diff attached');
}

{
  // Byte cap: 150 pairs = 300 changed lines (< line cap) but each pair ~500B of diff ≈ >50KB.
  const { oldStr, newStr } = makeChange(150, 250);
  const approxBytes = (oldStr.length + newStr.length) * 2; // '-'/'+' copies + headers ≈ conservative
  assert(approxBytes > INLINE_DIFF_MAX_BYTES, `fixture diff exceeds byte cap (~${approxBytes}B)`);
  const box = buildEditDiff(oldStr, newStr, 'src/e.txt');
  assert(box.querySelector('.tm-edit-diff-collapsed') !== null, 'over-byte-cap under-line-cap → collapsed');
}

{
  // Identical content (CRLF normalized) → "no change" note, never an empty viewer.
  const box = buildEditDiff('same\r\nlines\r\n', 'same\nlines\n', 'src/f.txt');
  assert(box.querySelector('.tm-diff-summary') !== null, 'line-endings-only change → summary note');
}

{
  // Vendor fallback path (no window.Diff2Html in this harness): a unified-diff <pre> renders.
  const box = buildEditDiff('a\nb\n', 'a\nc\n');
  const pre = box.querySelector('pre');
  assert(pre !== null && /@@ -1,2 \+1,2 @@/.test(pre!.textContent || ''), 'vendorless fallback renders raw unified diff with hunk header');
}

console.log(`\n${pass} passed, ${failed} failed`);
if (failed) process.exit(1);
