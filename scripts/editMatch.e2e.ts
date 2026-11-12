/* The edit matcher: tolerant of whitespace, never of ambiguity. "Search text not found" is the
 * commonest weak-model edit failure and is almost always one space, a trailing space or CRLF —
 * each cost a whole retry turn when locateUnique was a bare indexOf. Pins the SAFETY properties:
 * a relaxed match is still UNIQUE, line CONTENT is never fuzzy, offsets address the ORIGINAL
 * buffer (CRLF files stay intact), the replacement is re-indented to where the code lives.
 * TARGET is src/agent/core/tools/v3/editMatch.ts — until 2026-09-05 this suite tested the legacy
 * src/edits copy the agent never runs. Run: npm run test:e2e:edit-match */
import { applyHunk, changedRegion } from '../src/agent/core/tools/v3/editMatch';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

// applyHunk is pure (no vscode, no disk), so it can be exercised directly.
const apply = (text: string, search: string, replace: string) => applyHunk(text, search, replace);
const err = (r: ReturnType<typeof apply>) => ('error' in r ? r.error : '');
const out = (r: ReturnType<typeof apply>) => ('text' in r ? r.text : '');

console.log('— Exact matching still works exactly as before —');
{
  const r = apply('const a = 1;\nconst b = 2;\n', 'const b = 2;', 'const b = 3;');
  ok('exact hunk applies', out(r) === 'const a = 1;\nconst b = 3;\n');
  ok('a genuinely absent string still fails',
    err(apply('const a = 1;\n', 'const zzz = 9;', 'x')).includes('not found'));
  ok('an ambiguous exact match is still refused',
    /matches 2 locations/.test(err(apply('x();\nx();\n', 'x();', 'y();'))),
    err(apply('x();\nx();\n', 'x();', 'y();')));
}

console.log('\n— Whitespace tolerance: the common weak-model near-miss —');
{
  const file = 'class A {\n    run() {\n        return 1;\n    }\n}\n';
  // Model wrote the body flush-left, as weak models routinely do.
  const r = apply(file, 'run() {\nreturn 1;\n}', 'run() {\nreturn 2;\n}');
  ok('indentation-insensitive match applies', !('error' in r), err(r));
  // The correction is a UNIFORM delta taken from the first line, so the block lands at the right
  // outer indent. It deliberately does NOT try to reconstruct relative indentation the model never
  // wrote — that information does not exist in the input, and inventing it is how a matcher
  // reformats code it was not asked to touch. Aider accepts the same limitation.
  ok('the block is shifted to the right outer indent',
    out(r) === 'class A {\n    run() {\n    return 2;\n    }\n}\n', JSON.stringify(out(r)));
  ok('and the surrounding class body is untouched',
    out(r).startsWith('class A {\n') && out(r).endsWith('}\n'));

  // Trailing whitespace sits OUTSIDE the matched span, so exact matching already succeeds here and
  // the spaces are preserved rather than silently stripped.
  ok('trailing whitespace in the file does not block a match',
    out(apply('const a = 1;   \n', 'const a = 1;', 'const a = 2;')) === 'const a = 2;   \n',
    JSON.stringify(out(apply('const a = 1;   \n', 'const a = 1;', 'const a = 2;'))));
  ok('trailing whitespace the model typed does not block a match either',
    !('error' in apply('  const a = 1;\n', 'const a = 1;   ', 'const a = 2;')));

  const crlf = 'line one\r\nconst x = 1;\r\nline three\r\n';
  const rc = apply(crlf, 'const x = 1;', 'const x = 2;');
  ok('a CRLF file matches LF search text', !('error' in rc), err(rc));
  ok('and CRLF line endings elsewhere are preserved byte-for-byte',
    out(rc) === 'line one\r\nconst x = 2;\r\nline three\r\n', JSON.stringify(out(rc)));

  ok('blank lines around the pattern are ignored',
    out(apply('a\nb\n', '\n\nb\n\n', 'B')) === 'a\nB\n');
}

console.log('\n— Safety: ambiguity is an error, never a guess —');
{
  const dup = 'if (x) {\n    go();\n}\nif (y) {\n    go();\n}\n';
  ok('two whitespace-equivalent candidates are refused',
    /matches 2 locations/.test(err(apply(dup, 'go();', 'stop();'))),
    err(apply(dup, 'go();', 'stop();')));
  ok('the file is not modified when a hunk is refused', 'error' in apply(dup, 'go();', 'stop();'));

  ok('differing line CONTENT still fails (no fuzzy content matching)',
    err(apply('const total = 1;\n', 'const totl = 1;', 'x')).includes('not found'));
  ok('a missing line in the middle still fails',
    err(apply('a\nb\nc\n', 'a\nc', 'x')).includes('not found'));
  ok('extra non-whitespace on a line still fails',
    err(apply('  foo(1);\n', 'foo(1, 2);', 'x')).includes('not found'));
  ok('an all-whitespace search is refused rather than matching everywhere',
    'error' in apply('a\nb\n', '   \n  ', 'x'));
}

console.log('\n— Multi-line and offset correctness —');
{
  const file = 'header\n\nfunction f() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n\nfooter\n';
  const r = apply(file, '  const a = 1;\n  const b = 2;', '  const a = 10;\n  const b = 20;');
  ok('a multi-line exact hunk applies at the right offset',
    out(r) === 'header\n\nfunction f() {\n  const a = 10;\n  const b = 20;\n  return a + b;\n}\n\nfooter\n');
  ok('text before the match is untouched', out(r).startsWith('header\n\nfunction f() {\n'));
  ok('text after the match is untouched', out(r).endsWith('  return a + b;\n}\n\nfooter\n'));

  // The de-indent direction: model over-indented its search relative to the real file.
  const flat = 'run() {\nreturn 1;\n}\n';
  const rd = apply(flat, '    run() {\n    return 1;\n    }', '    run() {\n    return 2;\n    }');
  ok('an over-indented search still matches flush-left code', !('error' in rd), err(rd));
  ok('and the replacement is de-indented to match', out(rd) === 'run() {\nreturn 2;\n}\n', JSON.stringify(out(rd)));

  ok('deleting via an empty replacement works', out(apply('a\nb\nc\n', 'b\n', '')) === 'a\nc\n');
}

console.log('\n— Mixed tabs/spaces: bail out rather than guess —');
{
  const tabbed = '\tif (x) {\n\t\tgo();\n\t}\n';
  const r = apply(tabbed, '  if (x) {\n    go();\n  }', 'REPLACED');
  // Match may succeed (trimmed comparison), but the indent correction must not invent a mapping.
  ok('a tab/space indent mismatch does not corrupt the replacement',
    !('error' in r) ? out(r) === 'REPLACED\n' : true, out(r));
}

// ── Failure DIAGNOSTICS (2026-09-05) ────────────────────────────────────────────────────
// A failed edit is the most frequent tool failure an autonomous agent hits. "Search text not
// found in file." gave the model nothing to correct toward, so it re-issued near-identical
// calls until the step cap ended the turn. Each case below pins the fact that makes the
// retry INFORMED; the exact wording is free to change, the fact is not.
console.log('\n— Failure diagnostics: every error must be actionable —');
{
  const file = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';

  // Case A — the first line lands, the block diverges. The usual cause: context one line stale.
  const staleCtx = apply(file, 'const b = 2;\nconst c = 99;', 'X');
  const a = err(staleCtx);
  ok('A. diverging block is an error', 'error' in staleCtx);
  ok('A. names the line where the search STARTS matching', a.includes('line 2'), a);
  ok('A. names the line that DIVERGED', a.includes('line 3'), a);
  ok('A. quotes what the file actually holds there', a.includes('const c = 3;'), a);
  ok('A. quotes what the search expected', a.includes('const c = 99;'), a);

  // A search running off the end must say so, not quote the phantom trailing '' as a blank line.
  const overrun = apply(file, 'const c = 3;\nconst d = 4;', 'X');
  ok('A. a search past EOF says so instead of quoting an empty line',
    /past the end of the file/.test(err(overrun)) && !err(overrun).includes('has ``'), err(overrun));

  // Case B — the lines exist, just not consecutively, and the FIRST one is not among them
  // (context assembled from memory, or a read taken before an earlier edit in the same turn).
  const scrambled = apply(file, 'const zzz = 0;\nconst a = 1;', 'X');
  const b = err(scrambled);
  ok('B. non-consecutive lines are an error', 'error' in scrambled);
  ok('B. says the lines exist but not as one block', /not as one consecutive block/.test(b), b);
  ok('B. calls the context stale', /stale/i.test(b), b);

  // Case C — nothing of the search is in the file: wrong path, or fully rewritten text.
  const absent = apply(file, 'function totallyElsewhere() {}', 'X');
  const c = err(absent);
  ok('C. absent text is an error', 'error' in absent);
  ok('C. says no line of it appears at all', /no line of it appears/.test(c), c);
  ok('C. quotes the line it looked for', c.includes('function totallyElsewhere() {}'), c);
  ok('C. points at the path as the likely cause', /path/i.test(c), c);

  // Ambiguity — "add more context" is only actionable once the model can see WHICH occurrences.
  const dupFile = 'x();\ny();\nx();\n';
  const dup = apply(dupFile, 'x();', 'z();');
  const d = err(dup);
  ok('ambiguous match is still refused', 'error' in dup);
  ok('ambiguous error counts the matches', d.includes('2 locations'), d);
  ok('ambiguous error names the lines', d.includes('lines 1, 3'), d);
  ok('ambiguous error offers the edits[] escape hatch', d.includes('edits'), d);

  // Whitespace-only search: refused, and says why rather than matching everywhere.
  ok('an empty search explains itself', /empty/i.test(err(apply(file, '   \n  ', 'X'))), err(apply(file, '   \n  ', 'X')));

  // Size guard: a diagnostic must never flood the transcript with file content.
  const wide = `${'q'.repeat(4000)}\nconst b = 2;\n`;
  const long = err(apply(wide, `${'q'.repeat(4000)}\nconst zzz = 0;`, 'X'));
  ok('diagnostics stay bounded regardless of file line length', long.length < 600, `${long.length} chars`);
}

console.log('\n— 2026-11-12: open-source agent parity (aider/OpenCode/Codex/Gemini/Cline) —');
{
  // CRLF: the replacement follows the file's line ending; no lone LF, no swallowed \r.
  const crlf = 'function a() {\r\n  return 1;\r\n}\r\nconst z = 2;\r\n';
  const r1 = out(apply(crlf, 'function a() {\n  return 1;\n}', 'function a() {\n  return 2;\n}'));
  ok('CRLF file stays pure CRLF after a multi-line LF edit', r1 === crlf.replace('return 1', 'return 2'), JSON.stringify(r1));

  // Typographic punctuation folds for MATCHING; the replacement is what the model wrote.
  const typo = 'msg = "it\u2019s done \u2014 ok";\nnext();\n';
  const r2 = out(apply(typo, `msg = "it's done - ok";`, `msg = "finished";`));
  ok('smart quote / em dash match their ASCII forms', r2 === 'msg = "finished";\nnext();\n', JSON.stringify(r2));

  // readFile's line-number prefixes pasted into search (and replace) are stripped.
  const src = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
  const r3 = out(apply(src, '2\tconst b = 2;\n3\tconst c = 3;', '2\tconst b = 20;\n3\tconst c = 3;'));
  ok('pasted cat -n prefixes are stripped from search and replace', r3 === 'const a = 1;\nconst b = 20;\nconst c = 3;\n', JSON.stringify(r3));

  // Already applied: the replacement is there, the search is not.
  const done = 'const retries = 5;\nrun();\n';
  const e4 = err(apply(done, 'const retries = 3;', 'const retries = 5;'));
  ok('an already-applied edit says so with the line', /already applied/.test(e4) && /line 1/.test(e4), e4);

  // Closest block: stale context shows the real lines to copy (no re-read).
  const file2 = 'function total(items) {\n  let sum = 0;\n  for (const i of items) sum += i.price;\n  return sum;\n}\n';
  const e5 = err(apply(file2, 'function totals(item) {\n  let sum = 0;\n  for (const i of item) sum += i.price;', 'x'));
  ok('a near-miss shows the closest real block, numbered', /Closest block in the file \(lines 1–3\)/.test(e5) && e5.includes('1\tfunction total(items) {'), e5);

  // replaceAll: every exact occurrence; ambiguity error mentions it.
  const many = 'foo();\nbar(foo);\nfoo();\n';
  ok('replaceAll renames every occurrence', out(applyHunk(many, 'foo', 'baz', true)) === 'baz();\nbar(baz);\nbaz();\n');
  ok('the ambiguity error offers replaceAll', /replaceAll/.test(err(apply(many, 'foo();', 'x();'))));

  // changedRegion: the echo after a successful edit.
  const reg = changedRegion('a\nb\nc\nd\ne\n', 'a\nb\nC\nd\ne\n', 1);
  ok('changedRegion numbers the changed line with context', reg.includes('2\tb') && reg.includes('3\tC') && reg.includes('4\td') && !reg.includes('1\ta'), reg);
  ok('changedRegion is empty for no change', changedRegion('x', 'x') === '');
  const big = changedRegion(Array(100).fill('a').join('\n'), Array(100).fill('b').join('\n'));
  ok('changedRegion summarizes a huge change instead of echoing it', /too many to echo/.test(big) && big.length < 200, big);
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
