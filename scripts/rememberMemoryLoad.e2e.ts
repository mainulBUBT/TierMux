/* Load/stress test for the `remember` tool's storage layer (src/context/userMemory.ts).
 * The functional e2e test (rememberMemory.e2e.ts) checks correctness of each behavior in
 * isolation with small inputs. This one hammers the same code paths at volume to catch what
 * only shows up under load: lost writes under high concurrency, O(n^2) dedup cost as the file
 * grows, data corruption/interleaving from the write queue, and non-ASCII/pathological input
 * handling that a handful of hand-picked unit cases wouldn't exercise.
 *
 * Run: npm run test:e2e:remember-memory-load
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendUserMemory, loadUserMemory } from '../src/context/userMemory';

let bad = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) bad++; };
const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = Date.now();
  const r = await fn();
  console.log(`  ⏱  ${label}: ${Date.now() - t0}ms`);
  return r;
};

async function main() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-remember-load-'));
  (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: workspaceRoot, path: workspaceRoot } }];
  const memoryPath = path.join(workspaceRoot, '.tiermux', 'memory.md');

  // ── Load 1: high-concurrency unique writes — every write must survive the queue. ──
  const N1 = 500;
  const notes1 = Array.from({ length: N1 }, (_, i) => `load-note-${i}-${'x'.repeat(20)}`);
  const results1 = await time(`${N1} concurrent unique appends`, () =>
    Promise.all(notes1.map((n) => appendUserMemory(n))));
  ok(`all ${N1} concurrent writes reported success`, results1.every((r) => r === true));
  const fileAfter1 = fs.readFileSync(memoryPath, 'utf8');
  const lines1 = fileAfter1.split('\n').filter(Boolean);
  const survivors1 = notes1.filter((n) => fileAfter1.includes(n)).length;
  ok(`no writes lost under concurrency (${survivors1}/${N1} survived)`, survivors1 === N1);
  ok('line count matches note count exactly (no corruption/merged lines)', lines1.length === N1);
  ok('every line is well-formed ("- " prefix, no embedded raw newline)', lines1.every((l) => l.startsWith('- ')));

  // ── Load 2: mixed concurrent duplicates + uniques — dedup must still be exact under races. ──
  fs.writeFileSync(memoryPath, '');
  const N2 = 200;
  const mixed2 = Array.from({ length: N2 }, (_, i) => (i % 10 === 0 ? 'shared-dup-note' : `unique-${i}`));
  const results2 = await time(`${N2} concurrent appends (${Math.floor(N2 / 10)} duplicates mixed in)`, () =>
    Promise.all(mixed2.map((n) => appendUserMemory(n))));
  const successCount2 = results2.filter((r) => r === true).length;
  const expectedUnique2 = new Set(mixed2).size;
  ok(`exactly ${expectedUnique2} writes succeeded (duplicates deduped even under concurrency)`, successCount2 === expectedUnique2);
  const fileAfter2 = fs.readFileSync(memoryPath, 'utf8');
  ok('the shared duplicate note appears exactly once in the file', (fileAfter2.match(/^- shared-dup-note$/gm) || []).length === 1);

  // ── Load 3: throughput of many SEQUENTIAL appends (simulates a long-running session that
  // calls `remember` repeatedly over time) — watch for O(n^2) blowup as the file/dedup-scan grows. ──
  fs.writeFileSync(memoryPath, '');
  const N3 = 300;
  const t0 = Date.now();
  for (let i = 0; i < N3; i++) await appendUserMemory(`sequential-${i}`);
  const totalMs = Date.now() - t0;
  const avgMs = totalMs / N3;
  console.log(`  ⏱  ${N3} sequential appends: ${totalMs}ms total, ${avgMs.toFixed(2)}ms/call avg`);
  ok('sequential throughput stays reasonable (<20ms/call avg on a growing file)', avgMs < 20);
  const fileAfter3 = fs.readFileSync(memoryPath, 'utf8');
  ok(`all ${N3} sequential notes present, none dropped`, fileAfter3.split('\n').filter(Boolean).length === N3);

  // ── Load 4: pathological input — huge file already on disk, then hammer it further. ──
  const bigLines = Array.from({ length: 5000 }, (_, i) => `- legacy-line-${i}`).join('\n');
  fs.writeFileSync(memoryPath, bigLines + '\n');
  const bigFileSizeKB = Math.round(fs.statSync(memoryPath).size / 1024);
  const savedOnBigFile = await time(`single append onto a pre-existing ${bigFileSizeKB}KB / 5000-line file`, () =>
    appendUserMemory('note added onto a huge pre-existing file'));
  ok('append onto a large pre-existing file still succeeds', savedOnBigFile === true);
  const loadedBig = await time('loadUserMemory() read+truncate of a huge file', () => loadUserMemory());
  ok('loadUserMemory caps at 1500 chars even for a huge backing file', loadedBig.length <= 1500);
  ok('the most recent note is what survives truncation (tail-priority confirmed under load)', loadedBig.includes('note added onto a huge pre-existing file'));

  // ── Load 5: unicode / emoji / very long single note (right at the 280-char boundary the tool enforces upstream). ──
  fs.writeFileSync(memoryPath, '');
  const unicodeNote = 'ব্যবহারকারী সবসময় বাংলায় উত্তর চায় 🎯✅ — never regress this 你好';
  const savedUnicode = await appendUserMemory(unicodeNote);
  ok('unicode/emoji note saves successfully', savedUnicode === true);
  const fileUnicode = fs.readFileSync(memoryPath, 'utf8');
  ok('unicode content round-trips byte-for-byte through UTF-8 encode/decode', fileUnicode.includes(unicodeNote));
  const longNote = 'y'.repeat(280); // the tool schema's own max — storage layer must not choke on it
  const savedLong = await appendUserMemory(longNote);
  ok('a 280-char note (schema max) saves without truncation at the storage layer', savedLong === true && fs.readFileSync(memoryPath, 'utf8').includes(longNote));

  // ── Load 6: whitespace-only / empty note must not corrupt the file with a blank bullet. ──
  const savedEmpty = await appendUserMemory('   ');
  ok('whitespace-only note is rejected (no blank "- " line written)', savedEmpty === false);
  const fileAfterEmpty = fs.readFileSync(memoryPath, 'utf8');
  ok('no stray empty bullet line exists', !/^-\s*$/m.test(fileAfterEmpty));

  console.log(bad ? `\n${bad} FAILURE(S)` : '\nALL PASS');
  process.exit(bad ? 1 : 0);
}
main();
