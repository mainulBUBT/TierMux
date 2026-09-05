/* EditGate (inline chat's diff-approval gate) against a REAL temp directory, through the same
 * vscode shim the e2e harnesses use (scripts/vscodeMock.cjs) — no LLM, no network. Pins the
 * vscode API surface applyEdit.ts needs (Range/WorkspaceEdit/applyEdit/fs.*).
 *
 * Run: npm run test:e2e:edit-gate
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EditGate } from '../src/edits/applyEdit';

let bad = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) bad++; };

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-editgate-'));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  const gate = new EditGate(() => false); // requireConfirm=false → no UI

  try {
    const newFile = vscode.Uri.file(path.join(root, 'hello.txt'));
    const created = await gate.write(newFile, 'line one\n');
    ok('write creates a brand-new file', created.applied === true && fs.readFileSync(newFile.fsPath, 'utf8') === 'line one\n');

    const replaced = await gate.write(newFile, 'line two\n');
    ok('write replaces existing content', replaced.applied === true && fs.readFileSync(newFile.fsPath, 'utf8') === 'line two\n');

    const nested = vscode.Uri.file(path.join(root, 'a', 'b', 'c', 'deep.txt'));
    const nestedWrite = await gate.write(nested, 'deep\n');
    ok('write creates missing parent directories', nestedWrite.applied === true && fs.existsSync(nested.fsPath));

    const [w1, w2] = await Promise.all([gate.write(newFile, 'first\n'), gate.write(newFile, 'second\n')]);
    ok('same-URI writes serialize in arrival order', w1.applied && w2.applied && fs.readFileSync(newFile.fsPath, 'utf8') === 'second\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(bad ? `\n${bad} FAILURE(S)` : '\nALL PASS');
  process.exit(bad ? 1 : 0);
})();
