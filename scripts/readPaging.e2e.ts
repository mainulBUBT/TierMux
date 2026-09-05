/* A truncated file read must always say where to resume. Repro 2026-08-30: readOne appended its
 * "read again with offset=N" marker at the END of the body and the 30,000-char cap sliced the
 * end off — deleting the one instruction that says how to continue. The fix pages on a LINE
 * boundary so the marker survives and names a real next line. Run: npm run test:e2e:read-paging */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createReadFileTool } from '../src/agent/core/tools/v3/readFile';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-read-'));
// ~43k chars over 600 lines — the shape of the repro: well under the 800-line limit, far over
// the 30,000-char cap, so ONLY the char budget can cut it.
const lines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}: ${'x'.repeat(65)}`);
fs.writeFileSync(path.join(root, 'big.php'), lines.join('\n'));
fs.writeFileSync(path.join(root, 'small.php'), 'a\nb\nc\n');

const readFile = createReadFileTool() as { execute: (a: unknown, o?: unknown) => Promise<string | { error: string }> };
const read = (args: unknown) => runWithWorkspaceRoot(root, async () => {
  const r = await readFile.execute(args, {});
  return typeof r === 'string' ? r : `ERROR: ${r.error}`;
});

async function main() {
  console.log('— a char-capped read still tells the model where to resume —');
  const out = await read({ path: 'big.php' });
  const marker = /offset=(\d+) to continue/.exec(out);
  ok('the paging marker survived the cap', marker !== null, out.slice(-160));
  ok('it names the reason', /cut by output size/.test(out), out.slice(-160));
  ok('the read stayed within budget', out.length <= 30_000, `${out.length} chars`);

  console.log('\n— the cut lands on a line boundary, never mid-line —');
  const body = out.slice(out.indexOf('>') + 1, out.indexOf('</file>'));
  const last = body.trimEnd().split('\n').pop()!;
  ok('the last shown line is intact', /^\s*\d+\t line \d+: x{65}$/.test(last.replace('\t', '\t ')) || /x{65}$/.test(last), JSON.stringify(last.slice(-30)));

  console.log('\n— the named offset actually continues the file —');
  const next = Number(marker![1]);
  const cont = await read({ path: 'big.php', offset: next });
  ok('resuming at the offset yields the very next line',
    cont.includes(`${next}\tline ${next}:`), `expected line ${next}`);
  ok('no line is skipped or repeated across the boundary',
    !cont.includes(`\tline ${next - 1}:`), `line ${next - 1} must not reappear`);

  console.log('\n— paging the whole file terminates and covers every line —');
  let cursor = 1; let pages = 0; let sawLast = false;
  while (pages++ < 12) {
    const page = await read({ path: 'big.php', offset: cursor });
    const m = /offset=(\d+) to continue/.exec(page);
    if (!m) { sawLast = page.includes('\tline 600:'); break; }
    const nextCursor = Number(m[1]);
    if (nextCursor <= cursor) { ok('paging always advances', false, `${cursor} → ${nextCursor}`); break; }
    cursor = nextCursor;
  }
  ok('paging reaches the end of the file', sawLast, `${pages} pages`);
  ok('and does so without runaway paging', pages <= 12, `${pages} pages`);

  console.log('\n— a small file is untouched —');
  const small = await read({ path: 'small.php' });
  ok('no paging marker on a file that fits', !small.includes('offset='), small);
  ok('content intact', small.includes('1\ta') && small.includes('3\tc'));

  fs.rmSync(root, { recursive: true, force: true });
  console.log(bad === 0 ? '\nRead paging holds.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();
