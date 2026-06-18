// Diff preview + apply for agent file edits. Shows a native diff editor, asks
// for confirmation (when enabled), and applies via WorkspaceEdit.
import * as vscode from 'vscode';

const SCHEME = 'fla-proposed';

/** Serves proposed file content for the left/right side of a diff editor. */
class ProposedContentProvider implements vscode.TextDocumentContentProvider {
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

export interface EditResult {
  applied: boolean;
  error?: string;
}

export class EditGate {
  private readonly provider = new ProposedContentProvider();
  private tokenCounter = 0;
  private recorder?: (uri: vscode.Uri, before: string | null) => void;
  /**
   * When set, edit approval is requested in the chat view. The handler resolves
   * true/false, or `undefined` to defer to the native modal (e.g. the edit didn't
   * originate from a chat turn, so there's nowhere in the thread to show a card).
   */
  private confirmViaUi?: (req: { path: string; title: string; kind: 'write' | 'delete' }) => Promise<boolean | undefined>;

  constructor(private readonly requireConfirm: () => boolean) {}

  /** Route edit approval through the webview (an inline Apply/Reject card). Pass undefined to revert to the native modal. */
  setConfirmHandler(fn?: (req: { path: string; title: string; kind: 'write' | 'delete' }) => Promise<boolean | undefined>): void {
    this.confirmViaUi = fn;
  }

  register(): vscode.Disposable {
    return vscode.workspace.registerTextDocumentContentProvider(SCHEME, this.provider);
  }

  /** Notified with each file's pre-edit content just before a change is applied. */
  setRecorder(fn: (uri: vscode.Uri, before: string | null) => void): void {
    this.recorder = fn;
  }

  private token(label: string): string {
    return `${++this.tokenCounter}/${label}`;
  }

  /** Read the current text of a file, or undefined if it doesn't exist. */
  private async readIfExists(uri: vscode.Uri): Promise<string | undefined> {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    }
  }

  /** Show a diff between current and proposed content and (optionally) confirm. */
  private async previewAndConfirm(uri: vscode.Uri, current: string, proposed: string, title: string): Promise<boolean> {
    if (!this.requireConfirm()) return true;
    const name = vscode.workspace.asRelativePath(uri);
    const leftUri = this.provider.set(this.token(`current/${name}`), current);
    const rightUri = this.provider.set(this.token(`proposed/${name}`), proposed);
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true });
    // Prefer an inline Apply/Reject card in the chat view; fall back to a native modal.
    if (this.confirmViaUi) {
      const inline = await this.confirmViaUi({ path: name, title: `Apply changes to ${name}?`, kind: 'write' });
      if (inline !== undefined) return inline;
    }
    const choice = await vscode.window.showInformationMessage(
      `Apply changes to ${name}?`,
      { modal: true },
      'Apply',
    );
    return choice === 'Apply';
  }

  async write(uri: vscode.Uri, content: string): Promise<EditResult> {
    const beforeRaw = await this.readIfExists(uri);
    const ok = await this.previewAndConfirm(uri, beforeRaw ?? '', content, `Write ${vscode.workspace.asRelativePath(uri)}`);
    if (!ok) return { applied: false, error: 'User rejected the change.' };
    this.recorder?.(uri, beforeRaw ?? null); // snapshot pre-edit state for the checkpoint
    const edit = new vscode.WorkspaceEdit();
    const exists = beforeRaw !== undefined;
    if (!exists) edit.createFile(uri, { ignoreIfExists: true });
    edit.replace(uri, new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0), content);
    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    return { applied };
  }

  async create(uri: vscode.Uri, content: string): Promise<EditResult> {
    if ((await this.readIfExists(uri)) !== undefined) return { applied: false, error: 'File already exists.' };
    return this.write(uri, content);
  }

  async edit(uri: vscode.Uri, search: string, replace: string): Promise<EditResult> {
    const current = await this.readIfExists(uri);
    if (current === undefined) return { applied: false, error: 'File not found.' };
    const idx = current.indexOf(search);
    if (idx === -1) return { applied: false, error: 'Search text not found in file.' };
    const proposed = current.slice(0, idx) + replace + current.slice(idx + search.length);
    return this.write(uri, proposed);
  }

  async remove(uri: vscode.Uri): Promise<EditResult> {
    const current = await this.readIfExists(uri);
    if (current === undefined) return { applied: false, error: 'File not found.' };
    if (this.requireConfirm()) {
      const name = vscode.workspace.asRelativePath(uri);
      const inline = this.confirmViaUi ? await this.confirmViaUi({ path: name, title: `Delete ${name}?`, kind: 'delete' }) : undefined;
      const ok = inline !== undefined
        ? inline
        : (await vscode.window.showWarningMessage(`Delete ${name}?`, { modal: true }, 'Delete')) === 'Delete';
      if (!ok) return { applied: false, error: 'User rejected the deletion.' };
    }
    this.recorder?.(uri, current); // snapshot pre-delete content so it can be restored
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(uri, { ignoreIfNotExists: true });
    const applied = await vscode.workspace.applyEdit(edit);
    return { applied };
  }
}
