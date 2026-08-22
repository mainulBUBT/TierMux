/**
 * unifiedDiff e2e — exact-hunk, pure-add/delete, CRLF-normalization, move-determinism,
 * and large-input-fallback coverage for media/src/format/unifiedDiff.ts. Runs under plain
 * Node (no DOM, no vscode) via esbuild bundling.
 */

import { unifiedDiff } from '../media/src/format/unifiedDiff';

let pass = 0;
const failures: string[] = [];
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.error(`  ✗ ${name}\n      expected: ${e}\n      actual:   ${a}`); }
}

console.log('unifiedDiff.e2e');

// ── No differences ──────────────────────────────────────────────────────────────────────
check('identical text → empty', unifiedDiff('a\nb\nc\n', 'a\nb\nc\n'), '');
check('both empty → empty', unifiedDiff('', ''), '');
check('only line endings differ (CRLF→LF) → empty', unifiedDiff('a\r\nb\r\n', 'a\nb\n'), '');

// ── Exact hunks ─────────────────────────────────────────────────────────────────────────
{
  const old = 'one\ntwo\nthree\nfour\nfive\nsix\nseven';
  const neu = 'one\ntwo\nTHREE\nfour\nfive\nsix\nseven';
  check('single-line change hunk (context=0 → minimal)',
    unifiedDiff(old, neu, { context: 0 }),
    '@@ -3 +3 @@\n-three\n+THREE');
  check('single-line change hunk (default context=3)',
    unifiedDiff(old, neu),
    '@@ -1,6 +1,6 @@\n one\n two\n-three\n+THREE\n four\n five\n six');
}
{
  const old = 'l1\nl2\nl3\nold\nl5\nl6\nl7\nl8\nl9\nl10\nmore\nl12\nl13\nCHANGEME\nl15';
  const neu = 'l1\nl2\nl3\nnew1\nnew2\nl5\nl6\nl7\nl8\nl9\nl10\nmore\nl12\nl13\nREPLACED\nl15';
  // Two changes far apart (≥ 2×context+1 equal lines between) ⇒ two hunks.
  const d = unifiedDiff(old, neu, { context: 3 });
  check('distant changes → two hunks', d.split('@@').length - 1, 4); // each hunk has 2 @@ markers
}

// ── Pure adds / deletes ─────────────────────────────────────────────────────────────────
check('pure add at top of empty file',
  unifiedDiff('', 'hello\nworld'),
  '@@ -0,0 +1,2 @@\n+hello\n+world');
check('pure delete to empty file',
  unifiedDiff('hello\nworld', ''),
  '@@ -1,2 +0,0 @@\n-hello\n-world');
check('insertion in the middle keeps default 3-line context',
  unifiedDiff('a\nb\nc', 'a\nb\nX\nc'),
  '@@ -1,3 +1,4 @@\n a\n b\n+X\n c');

// ── Move determinism (delete+add, never a semantic "move") ───────────────────────────────
{
  const old = 'alpha\nbeta\ngamma';
  const neu = 'gamma\nalpha\nbeta'; // rotate — no LCS trick should hide the churn
  const once = unifiedDiff(old, neu);
  const twice = unifiedDiff(old, neu);
  check('move is deterministic (same output twice)', once, twice);
  check('rotation produces delete+add lines', /^[-+]/m.test(once), true);
  check('rotation emits at least one - and one + line',
    once.includes('-gamma') && once.includes('+gamma'), true);
}

// ── Labels / headers ─────────────────────────────────────────────────────────────────────
check('labels emit ---/+++ headers',
  unifiedDiff('a\n', 'b\n', { oldLabel: 'a/file.txt', newLabel: 'b/file.txt' }),
  '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-a\n+b');
check('no labels → no headers, hunks only',
  unifiedDiff('a\n', 'b\n').startsWith('@@ '), true);

// ── CRLF normalization is applied before comparing ──────────────────────────────────────
check('mixed CRLF/LF content diffs on content only',
  unifiedDiff('x\r\ny\r\n', 'x\nz\n'),
  '@@ -1,2 +1,2 @@\n x\n-y\n+z');

// ── Large input falls back to whole-replace (no hang/OOM) ────────────────────────────────
{
  const bigA = Array.from({ length: 4000 }, (_, i) => `a${i}`).join('\n');
  const bigB = Array.from({ length: 4000 }, (_, i) => `b${i}`).join('\n');
  const t0 = Date.now();
  const d = unifiedDiff(bigA, bigB);
  const ms = Date.now() - t0;
  check('oversized middle still produces a diff', d.includes('-a0') && d.includes('+b0'), true);
  check('fallback completes fast', ms < 2000, true);
}

// ── Trailing-newline tolerance ───────────────────────────────────────────────────────────
check('missing trailing newline does not fabricate a change',
  unifiedDiff('a\nb', 'a\nb\n'), '');

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(`FAILURES: ${failures.join(', ')}`);
  process.exit(1);
}
