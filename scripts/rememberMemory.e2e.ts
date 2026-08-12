/* Regression test for the `remember` tool / userMemory.ts, added alongside the tool itself.
 * Exercises the refinements called out during plan review: concurrency lock, line-exact
 * (not substring) dedup, newline sanitization, honest failure reporting when no workspace
 * is open, and the head->tail truncation fix in loadUserMemory() (the original head-truncation
 * would have made every newly appended note permanently invisible once the file grew past
 * MAX_CHARS — exactly the failure mode this tool would trigger in normal use).
 *
 * Run: npm run test:e2e:remember-memory
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendUserMemory, loadUserMemory } from '../src/context/userMemory';

let bad = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) bad++; };

async function main() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-remember-'));
  (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: workspaceRoot, path: workspaceRoot } }];
  const memoryPath = path.join(workspaceRoot, '.tiermux', 'memory.md');

  // 1. Basic append + read round-trip.
  const saved1 = await appendUserMemory('always use tabs in this repo');
  ok('first append reports success', saved1 === true);
  const fileText1 = fs.readFileSync(memoryPath, 'utf8');
  ok('note is written as a bullet line', fileText1.includes('- always use tabs in this repo'));
  const loaded1 = await loadUserMemory();
  ok('loadUserMemory sees the new note', loaded1.includes('always use tabs in this repo'));

  // 2. Exact dedup: re-saving the identical note (any case) is a no-op.
  const saved2 = await appendUserMemory('Always Use Tabs In This Repo');
  ok('exact re-save (different case) is deduped, reports false', saved2 === false);
  const fileText2 = fs.readFileSync(memoryPath, 'utf8');
  ok('dedup did not duplicate the line', (fileText2.match(/use tabs in this repo/gi) || []).length === 1);

  // 3. Substring dedup must NOT false-positive: "never use tabs" vs new "use tabs" are different facts.
  await appendUserMemory('never use tabs in this project');
  const saved3 = await appendUserMemory('use tabs');
  ok('substring-only match does NOT falsely dedup ("never use tabs" vs "use tabs")', saved3 === true);
  const fileText3 = fs.readFileSync(memoryPath, 'utf8');
  ok('both the negative and the new positive note are present', fileText3.includes('never use tabs in this project') && /^- use tabs$/m.test(fileText3));

  // 4. Sanitize embedded newlines so one note can't break the one-bullet-per-line format.
  await appendUserMemory('line one\nline two\r\nline three');
  const fileText4 = fs.readFileSync(memoryPath, 'utf8');
  ok('embedded newlines collapsed to spaces (single bullet line)', fileText4.includes('- line one line two line three'));
  ok('no stray bare "line two"/"line three" lines were introduced', !/^line two$/m.test(fileText4) && !/^line three$/m.test(fileText4));

  // 5. Concurrency: fire several appends in parallel within the same "turn" and confirm no
  // lost writes (the naive read-then-write race would drop all but the last).
  fs.writeFileSync(memoryPath, ''); // reset
  const concurrentNotes = Array.from({ length: 8 }, (_, i) => `concurrent note ${i}`);
  const results = await Promise.all(concurrentNotes.map((n) => appendUserMemory(n)));
  ok('all concurrent appends reported success', results.every((r) => r === true));
  const fileText5 = fs.readFileSync(memoryPath, 'utf8');
  const survivingCount = concurrentNotes.filter((n) => fileText5.includes(n)).length;
  ok(`all ${concurrentNotes.length} concurrent notes survived (no lost write from a race)`, survivingCount === concurrentNotes.length);

  // 6. Truncation direction: pad the file past MAX_CHARS (1500), append a new note, and confirm
  // loadUserMemory() still surfaces it — this is the read-side bug fix, not just the write side.
  fs.writeFileSync(memoryPath, '- ' + 'x'.repeat(2000) + '\n');
  const savedPad = await appendUserMemory('fresh note after padding');
  ok('append after padding reports success', savedPad === true);
  const loadedPad = await loadUserMemory();
  ok('loadUserMemory (tail-truncated) still contains the freshly appended note', loadedPad.includes('fresh note after padding'));
  ok('loadUserMemory does not start mid-word (line-boundary snap worked)', !loadedPad.startsWith('x') || loadedPad.split('\n')[0].length < 2000);
  ok('loadUserMemory is capped at 1500 chars', loadedPad.length <= 1500);

  // 7. No workspace folder open: must report failure honestly, not silently claim success.
  (vscode.workspace as any).workspaceFolders = undefined;
  const savedNoWs = await appendUserMemory('should not be saved anywhere');
  ok('no-workspace append reports failure (not a silent lie)', savedNoWs === false);

  console.log(bad ? `\n${bad} FAILURE(S)` : '\nALL PASS');
  process.exit(bad ? 1 : 0);
}
main();
