/* EditGate against a REAL temp directory, through the SAME vscode shim the live agent harnesses
 * use (scripts/bench/benchVscode.cjs) — no LLM, no network, deterministic.
 *
 * Why this exists: the shim was originally scoped read-only (ask/plan mode only), and
 * scripts/complexTask.e2e.ts started reusing it for real agent-mode (edit-enabled) runs without
 * anyone verifying the mutation surface actually worked. The gap sat undetected through many
 * live complex-task runs — every one of them died from an EARLIER bug (crash, budget exhaustion,
 * XML leak) before an editFile call ever got far enough to hit it. The first run that finally got
 * that far threw `TypeError: vscode.WorkspaceEdit is not a constructor` — confirming edits could
 * never have landed in this harness even when a model did everything right.
 *
 * That fix (Range/WorkspaceEdit/applyEdit/fs.writeFile/fs.delete in benchVscode.cjs) needs a test
 * that doesn't depend on a free model successfully calling a tool — live re-verification burned
 * two runs in a row on pure provider exhaustion (2026-08-10) and proved nothing. This does the
 * same job in under a second, for free, and pins the exact API surface applyEdit.ts needs.
 *
 * Run: npm run test:e2e:edit-gate
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setWorkspaceRoot } from './bench/agentHarness';
import { EditGate } from '../src/edits/applyEdit';

let bad = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) bad++; };

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-editgate-'));
  setWorkspaceRoot(root);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  const gate = new EditGate(() => false); // requireConfirm=false → approved-* paths need no UI

  try {
    // 1. writeApproved creates a brand-new file.
    const newFile = vscode.Uri.file(path.join(root, 'hello.txt'));
    const created = await gate.writeApproved(newFile, 'line one\n');
    ok('writeApproved reports applied:true', created.applied === true);
    ok('writeApproved actually wrote the file to disk', fs.readFileSync(newFile.fsPath, 'utf8') === 'line one\n');

    // 2. editApproved (single search/replace) on that file.
    const edited = await gate.editApproved(newFile, 'line one', 'line ONE, edited');
    ok('editApproved reports applied:true', edited.applied === true);
    ok('editApproved actually changed the file content', fs.readFileSync(newFile.fsPath, 'utf8') === 'line ONE, edited\n');

    // 3. A search string that does not exist must fail cleanly, not corrupt the file.
    const missed = await gate.editApproved(newFile, 'this text is not in the file', 'x');
    ok('editApproved on a non-matching search reports applied:false', missed.applied === false);
    ok('editApproved leaves the file untouched on a miss', fs.readFileSync(newFile.fsPath, 'utf8') === 'line ONE, edited\n');

    // 4. editMultiApproved — multiple hunks, one file, atomic.
    fs.writeFileSync(path.join(root, 'multi.txt'), 'AAA\nBBB\nCCC\n');
    const multiFile = vscode.Uri.file(path.join(root, 'multi.txt'));
    const multi = await gate.editMultiApproved(multiFile, [{ search: 'AAA', replace: 'aaa' }, { search: 'CCC', replace: 'ccc' }]);
    ok('editMultiApproved reports applied:true', multi.applied === true);
    ok('editMultiApproved applied BOTH hunks in one write', fs.readFileSync(multiFile.fsPath, 'utf8') === 'aaa\nBBB\nccc\n');

    // 5. createApproved refuses to overwrite an existing file.
    const clobber = await gate.createApproved(newFile, 'should not land');
    ok('createApproved refuses an existing file', clobber.applied === false);
    ok('createApproved did not touch the existing content', fs.readFileSync(newFile.fsPath, 'utf8') === 'line ONE, edited\n');

    // 6. removeApproved actually deletes from disk — the one case with no follow-up fs.writeFile,
    //    so it depends entirely on applyEdit() executing the WorkspaceEdit's deleteFile op.
    const removed = await gate.removeApproved(newFile);
    ok('removeApproved reports applied:true', removed.applied === true);
    ok('removeApproved actually deleted the file from disk', !fs.existsSync(newFile.fsPath));

    // 7. writeApproved into a nested, not-yet-existing directory (mkdir -p behaviour).
    const nested = vscode.Uri.file(path.join(root, 'a', 'b', 'c', 'deep.txt'));
    const nestedWrite = await gate.writeApproved(nested, 'deep\n');
    ok('writeApproved creates missing parent directories', nestedWrite.applied === true && fs.existsSync(nested.fsPath));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(bad ? `\n${bad} FAILURE(S)` : '\nALL PASS');
  process.exit(bad ? 1 : 0);
})();
