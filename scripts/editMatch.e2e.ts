/* The edit matcher: tolerant of whitespace, never of ambiguity.
 *
 * "Search text not found in file" is the most common weak-model edit failure, and it is almost
 * never a wrong location — it is one space of indentation, a trailing space, or CRLF vs LF. Before
 * this, `locateUnique` was a bare `indexOf`, so every one of those cost a whole retry turn against
 * a free tier's request quota. Aider's editblock matcher has the same tiers for the same reason.
 *
 * This file exists mostly to pin the SAFETY properties, because the failure mode of a too-clever
 * matcher is silently patching the wrong code:
 *   - a relaxed match must still be UNIQUE (two candidates → error, never a guess)
 *   - line CONTENT is never fuzzy-matched; one differing character still fails
 *   - offsets must address the ORIGINAL buffer, so a CRLF file is not corrupted byte-by-byte
 *   - the replacement is re-indented to wherever the code actually lives
 *
 * Run: npm run test:e2e:edit-match
 */
import { EditGate } from '../src/edits/applyEdit';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

// applyHunk is pure (no vscode, no disk), so it can be exercised directly on a bare instance.
const gate = Object.create(EditGate.prototype) as EditGate;
const apply = (text: string, search: string, replace: string) => gate.applyHunk(text, search, replace);
const err = (r: ReturnType<typeof apply>) => ('error' in r ? r.error : '');
const out = (r: ReturnType<typeof apply>) => ('text' in r ? r.text : '');

console.log('— Exact matching still works exactly as before —');
{
  const r = apply('const a = 1;\nconst b = 2;\n', 'const b = 2;', 'const b = 3;');
  ok('exact hunk applies', out(r) === 'const a = 1;\nconst b = 3;\n');
  ok('a genuinely absent string still fails',
    err(apply('const a = 1;\n', 'const zzz = 9;', 'x')).includes('not found'));
  ok('an ambiguous exact match is still refused',
    err(apply('x();\nx();\n', 'x();', 'y();')).includes('multiple locations'));
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
    err(apply(dup, 'go();', 'stop();')).includes('multiple locations'));
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

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
