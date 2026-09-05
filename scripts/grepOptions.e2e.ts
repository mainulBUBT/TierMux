/* grep must be able to answer "which files?" and "what's around it?" without a readFile —
 * and must not lose what it found.
 *
 * The tool shipped with pattern/path/glob only, so two of the commonest search shapes each
 * cost an extra round trip and a large payload:
 *   - "where is X used?" returned every matching LINE (~20KB cap) when the answer was a list
 *     of paths;
 *   - "what does the code around X look like?" had no way to widen, so the model followed the
 *     grep with a whole-file readFile.
 * ripgrep already does both (-l, -C, -i); only the schema withheld them.
 *
 * The review of that change (2026-09-05) then found three older faults in the same function,
 * pinned here too:
 *   - `path` went to ripgrep raw, so `../` searched OUTSIDE the workspace — the containment
 *     every other path-taking tool has (resolvePath.ts), grep alone lacked;
 *   - rg exits 2 when ANY path errors (a chmod-000 dir, a dangling symlink) even with matches
 *     on stdout, and the close handler turned that into {error}, discarding the matches;
 *   - at the 20KB cap rg was never killed, so it ran on until the 15s timer REJECTED — and
 *     threw away the 20KB already buffered.
 *
 * These assertions are about the OUTPUT SHAPE, not about any model behaving better with it.
 *
 * Run: npm run test:e2e:grep-options
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createGrepTool } from '../src/agent/core/tools/v3/search';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };
const paths = (out: string) => out.split('\n').filter(Boolean).map((l) => l.replace(/^\.\//, '')).sort();

// Two sibling dirs under one parent: the workspace, and a neighbour it must never see.
const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-grep-'));
const root = path.join(parent, 'ws');
const sibling = path.join(parent, 'ws-backup');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.mkdirSync(sibling);
fs.writeFileSync(path.join(root, 'src', 'a.ts'), [
  'const before2 = 1;',
  'const before1 = 2;',
  'export const NEEDLE = 3;',
  'const after1 = 4;',
  'const after2 = 5;',
].join('\n'));
fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'import { NEEDLE } from "./a";\n');
fs.writeFileSync(path.join(root, 'src', 'c.ts'), 'const needle = "lowercase only";\n');
fs.writeFileSync(path.join(root, 'notes.md'), 'NEEDLE appears in prose too.\n');
fs.writeFileSync(path.join(sibling, '.env'), 'SECRET_NEEDLE=hunter2\n');

const grep = createGrepTool() as { execute: (a: unknown, o?: unknown) => Promise<string | { error: string }> };
const run = (args: unknown) => runWithWorkspaceRoot(root, async () => {
  const r = await grep.execute(args, {});
  return typeof r === 'string' ? r : `ERROR: ${r.error}`;
});

async function main() {
  console.log('— the default shape is unchanged: path:line:text —');
  const plain = await run({ pattern: 'NEEDLE' });
  ok('matches carry a line number', /a\.ts:3:/.test(plain), plain.split('\n')[0]);
  ok('every file with a match is present', /b\.ts:/.test(plain) && /notes\.md:/.test(plain));
  ok('a case-mismatched line is absent by default', !/c\.ts:/.test(plain));

  console.log('\n— filesOnly answers "where is X used?" with paths alone —');
  const only = await run({ pattern: 'NEEDLE', filesOnly: true });
  ok('exactly the three matching paths, nothing else',
    JSON.stringify(paths(only)) === JSON.stringify(['notes.md', 'src/a.ts', 'src/b.ts']), only.replace(/\n/g, ' | '));

  console.log('\n— context returns the surrounding lines instead of a whole-file read —');
  const ctx = await run({ pattern: 'NEEDLE', glob: 'a.ts', context: 2 });
  ok('two lines before are included', /before2/.test(ctx) && /before1/.test(ctx), ctx.replace(/\n/g, ' | '));
  ok('two lines after are included', /after1/.test(ctx) && /after2/.test(ctx));
  const ctx0 = await run({ pattern: 'NEEDLE', glob: 'a.ts', context: 0 });
  ok('context: 0 prints a single line, like absent', !/before1/.test(ctx0), ctx0.replace(/\n/g, ' | '));

  console.log('\n— ignoreCase widens the match —');
  const ci = await run({ pattern: 'NEEDLE', ignoreCase: true });
  ok('the lowercase file now matches', /c\.ts:/.test(ci), ci.replace(/\n/g, ' | '));

  console.log('\n— the options compose, and a miss is still a clean miss —');
  const both = await run({ pattern: 'needle', filesOnly: true, ignoreCase: true, path: 'src' });
  ok('filesOnly + ignoreCase + path scope',
    JSON.stringify(paths(both)) === JSON.stringify(['src/a.ts', 'src/b.ts', 'src/c.ts']), both.replace(/\n/g, ' | '));
  const miss = await run({ pattern: 'ZZZ_NOT_PRESENT', filesOnly: true });
  ok('no matches reads as "(no matches)"', miss === '(no matches)', JSON.stringify(miss));

  console.log('\n— `path` is confined to the workspace like every other tool —');
  const escape = await run({ pattern: 'SECRET_NEEDLE', path: '../ws-backup', filesOnly: true });
  ok('`../` is refused, not searched', escape.startsWith('ERROR: Path escapes the workspace'), escape.slice(0, 80));
  const abs = await run({ pattern: 'SECRET_NEEDLE', path: sibling, filesOnly: true });
  ok('an absolute path outside the root never reaches the sibling', !/hunter2|\.env/.test(abs), abs.slice(0, 80));
  const inside = await run({ pattern: 'NEEDLE', path: path.join(root, 'src'), filesOnly: true });
  ok('an absolute path INSIDE the root still works, relative in the output',
    JSON.stringify(paths(inside)) === JSON.stringify(['src/a.ts', 'src/b.ts']), inside.replace(/\n/g, ' | '));

  console.log('\n— a path error elsewhere in the tree does not discard the matches —');
  const locked = path.join(root, 'locked');
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o000);
  let withLocked = '';
  try {
    withLocked = await run({ pattern: 'NEEDLE', filesOnly: true });
  } finally {
    fs.chmodSync(locked, 0o755);
    fs.rmdirSync(locked);
  }
  // Root can read a chmod-000 dir, so on a root-run CI this case simply degrades to the
  // ordinary success shape — the assertion holds either way.
  ok('rg exit 2 with matches still returns them',
    JSON.stringify(paths(withLocked)) === JSON.stringify(['notes.md', 'src/a.ts', 'src/b.ts']), withLocked.slice(0, 100));
  const emptyErr = await run({ pattern: 'NEEDLE', path: 'does-not-exist' });
  ok('an empty result with a real error is still an error', emptyErr.startsWith('ERROR:'), emptyErr.slice(0, 80));

  console.log('\n— the output cap stops the search instead of waiting for the timeout —');
  // -m 200 bounds one file at ~210 lines, so the lines themselves must be wide to pass 20KB.
  const big = Array.from({ length: 400 }, (_, i) => `line ${i} NEEDLE ${'x'.repeat(200)}`).join('\n');
  fs.writeFileSync(path.join(root, 'big.txt'), big);
  const t0 = Date.now();
  const capped = await run({ pattern: 'NEEDLE', glob: 'big.txt', context: 10 });
  const ms = Date.now() - t0;
  ok('a huge result returns promptly, not after 15s', ms < 5_000, `${ms}ms`);
  ok('it returns content, not a timeout error', !capped.startsWith('ERROR:'), capped.slice(0, 60));
  ok('the marker says the search was stopped early', /search stopped early/.test(capped), capped.slice(-120));
  ok('and does not invent a total', !/of [\d,]+ chars omitted/.test(capped));

  console.log(`\n${bad === 0 ? 'ALL PASS' : `${bad} FAILED`}`);
}

main()
  .catch((e) => { console.error('harness crashed:', e); bad++; })
  .finally(() => {
    fs.rmSync(parent, { recursive: true, force: true });
    process.exitCode = bad === 0 ? 0 : 1;
  });
