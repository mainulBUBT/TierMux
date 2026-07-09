// Read-only view of OC's own aggregate session diff (client.session.diff() via ocClient.ts).
// Distinct from CheckpointManager: checkpoints are TierMux's own per-turn snapshot/restore
// system; this is just "what did OC change over the whole session so far" — no revert, no
// restore, just opening a native VS Code diff editor per changed file.
import * as vscode from 'vscode';

const SCHEME = 'oc-session-diff';

/** Serves an OC-diff snapshot's before/after content for a diff editor. Same shape as
 *  checkpoints.ts's BaselineContentProvider, kept separate since the two stores must never
 *  collide (this one holds OC's raw before/after strings, not checkpoint baselines). */
class OcDiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly store = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  set(token: string, content: string): vscode.Uri {
    this.store.set(token, content);
    const uri = vscode.Uri.parse(`${SCHEME}:/${token}`);
    this._onDidChange.fire(uri);
    return uri;
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.store.get(uri.path.replace(/^\//, '')) ?? '';
  }
}

/** Shared singleton — VS Code allows one content provider per scheme. */
export const ocDiffProvider = new OcDiffContentProvider();

/** Register the OC session-diff content provider. Call exactly once in activate(). */
export function registerOcSessionDiffContentProvider(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(SCHEME, ocDiffProvider);
}

let diffTokenSeq = 0;

/**
 * Open a native diff editor for one file from OC's session.diff() result. Diffs the
 * OC-reported `before` against the live workspace file if it still exists (so the user
 * sees the CURRENT state, not just OC's own snapshot of `after`); falls back to diffing
 * OC's before/after snapshots directly if the file is gone (e.g. deleted mid-session).
 */
export async function openOcFileDiff(file: string, before: string, after: string): Promise<void> {
  const tk = ++diffTokenSeq;
  const leftUri = ocDiffProvider.set(`before-${tk}/${file}`, before);
  const title = `${file} (OC session diff)`;
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  const fileUri = workspaceRoot ? vscode.Uri.joinPath(workspaceRoot, file) : undefined;
  let exists = false;
  if (fileUri) {
    try { await vscode.workspace.fs.stat(fileUri); exists = true; } catch { /* file gone */ }
  }
  if (fileUri && exists) {
    await vscode.commands.executeCommand('vscode.diff', leftUri, fileUri, title);
  } else {
    const rightUri = ocDiffProvider.set(`after-${tk}/${file}`, after);
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
  }
}
