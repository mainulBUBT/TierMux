/* Regression test for "Revert to here" / "Undo all" silently restoring 0 files after an
 * extension host restart. CheckpointManager used to be rebuilt empty on every session hydrate
 * (see chatViewProvider.ts's hydrateSession) — the revert button stayed visible and its confirm
 * dialog still fired, but there was nothing left to restore from, so it quietly did nothing.
 * Reported directly by the user testing real edits across a reload ("file not revert").
 * Fixed by serializing checkpoints (toJSON) into StoredSession and restoring them
 * (constructor's `restored` param) in hydrateSession.
 *
 * Run: npm run test:e2e:checkpoint-persist
 */
import * as vscode from 'vscode';
import { CheckpointManager } from '../src/edits/checkpoints';

let bad = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) bad++; };

async function main() {
  // Neutral temp cwd: the repo root is itself a git tree, and restore()'s git-snapshot path
  // would treat the untracked checkpoint file as "not in tree" and delete it — testing git
  // semantics instead of checkpoint persistence.
  const fs = await import('fs');
  const os = await import('os');
  const pathMod = await import('path');
  const cwd = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'tiermux-cp-'));
  const a = new CheckpointManager(cwd);
  await a.begin('req1', 'test turn');
  const target = vscode.Uri.file(cwd + '/CHECKPOINT_TEST_FILE.txt');
  a.record(target, 'original content');
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode('edited content'));
  const cpId = a.commit();
  ok('commit returned an id', !!cpId);

  const json = a.toJSON();
  ok('serializes one checkpoint', json.length === 1);
  ok('serialized snap keeps before-content', json[0].snaps[0]?.before === 'original content');

  // Simulate an extension host restart: brand-new manager instance, restored from JSON.
  const b = new CheckpointManager(cwd, json);
  const bId = b.idForRequest('req1');
  ok('restored manager resolves the same requestId', bId === cpId);
  const files = await b.changedFiles(bId!);
  ok('restored manager still sees the changed file', files.some((f) => f.rel.endsWith('CHECKPOINT_TEST_FILE.txt')));

  const n = await b.restore(bId!);
  ok('restore() actually restores after a simulated restart', n >= 1);
  const restored = await vscode.workspace.fs.readFile(target);
  ok('file content is back to original', new TextDecoder().decode(restored) === 'original content');

  await vscode.workspace.fs.delete(target);
  console.log(bad ? `\n${bad} FAILURE(S)` : '\nALL PASS');
  process.exit(bad ? 1 : 0);
}
main();
