/* grep must be able to answer "which files?" and "what's around it?" without a readFile.
 *
 * The tool shipped with pattern/path/glob only, so two of the commonest search shapes each
 * cost an extra round trip and a large payload:
 *   - "where is X used?" returned every matching LINE (~20KB cap) when the answer was a list
 *     of paths;
 *   - "what does the code around X look like?" had no way to widen, so the model followed the
 *     grep with a whole-file readFile — up to 30,000 chars, re-sent on every remaining step.
 * ripgrep already does both (-l, -C, -i); only the schema withheld them.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-grep-'));
fs.mkdirSync(path.join(root, 'src'));
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
  const paths = only.split('\n').filter(Boolean);
  ok('three files listed', paths.length === 3, JSON.stringify(paths));
  ok('no line numbers or matched text', !/:\d+:/.test(only), only.replace(/\n/g, ' | '));
  ok('it is strictly smaller than the line-mode output', only.length < plain.length,
    `${only.length} < ${plain.length}`);

  console.log('\n— context returns the surrounding lines instead of a whole-file read —');
  const ctx = await run({ pattern: 'NEEDLE', glob: 'a.ts', context: 2 });
  ok('two lines before are included', /before2/.test(ctx) && /before1/.test(ctx), ctx.replace(/\n/g, ' | '));
  ok('two lines after are included', /after1/.test(ctx) && /after2/.test(ctx));
  const noCtx = await run({ pattern: 'NEEDLE', glob: 'a.ts' });
  ok('context:0 / absent stays a single line', !/before1/.test(noCtx), noCtx.replace(/\n/g, ' | '));
  const ctx0 = await run({ pattern: 'NEEDLE', glob: 'a.ts', context: 0 });
  ok('an explicit 0 behaves like absent', !/before1/.test(ctx0), ctx0.replace(/\n/g, ' | '));

  console.log('\n— ignoreCase widens the match —');
  const ci = await run({ pattern: 'NEEDLE', ignoreCase: true });
  ok('the lowercase file now matches', /c\.ts:/.test(ci), ci.replace(/\n/g, ' | '));

  console.log('\n— the options compose, and a miss is still a clean miss —');
  const both = await run({ pattern: 'needle', filesOnly: true, ignoreCase: true, path: 'src' });
  ok('filesOnly + ignoreCase + path scope', both.split('\n').filter(Boolean).length === 3
    && !/notes\.md/.test(both), both.replace(/\n/g, ' | '));
  const miss = await run({ pattern: 'ZZZ_NOT_PRESENT', filesOnly: true });
  ok('no matches reads as "(no matches)"', miss === '(no matches)', JSON.stringify(miss));

  console.log(`\n${bad === 0 ? 'ALL PASS' : `${bad} FAILED`}`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(bad === 0 ? 0 : 1);
}

main();
