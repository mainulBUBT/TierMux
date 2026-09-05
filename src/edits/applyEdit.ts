// Diff-approval gate for inline chat (Cmd+I). The agent's own file tools do NOT go through
// this — their approval is the streamText `toolApproval` policy (src/permissions/policy.ts).

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
  /** Per-URI serialization queue so two writes to the same path apply in arrival order. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** When set, approval is asked in the chat view; `undefined` from it defers to the native modal. */
  private confirmViaUi?: (req: { path: string; title: string; kind: 'write' | 'delete' }) => Promise<boolean | undefined>;
  /** Session Auto-approve toggle: when true, apply without a diff prompt. */
  private autoApprove?: () => boolean;

  constructor(private readonly requireConfirm: () => boolean) {}

  setConfirmHandler(fn?: (req: { path: string; title: string; kind: 'write' | 'delete' }) => Promise<boolean | undefined>): void {
    this.confirmViaUi = fn;
  }

  setAutoApprove(fn: () => boolean): void {
    this.autoApprove = fn;
  }

  register(): vscode.Disposable {
    return vscode.workspace.registerTextDocumentContentProvider(SCHEME, this.provider);
  }

  private token(label: string): string {
    return `${++this.tokenCounter}/${label}`;
  }

  private withLock<T>(uri: vscode.Uri, fn: () => Promise<T>): Promise<T> {
    const key = uri.toString();
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const stored = next.then(() => undefined, () => undefined);
    this.locks.set(key, stored);
    stored.then(() => { if (this.locks.get(key) === stored) this.locks.delete(key); });
    return next;
  }

  private async readIfExists(uri: vscode.Uri): Promise<string | undefined> {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    }
  }

  /** Show a diff between current and proposed content and confirm, unless confirmation is off. */
  private async previewAndConfirm(uri: vscode.Uri, current: string, proposed: string, title: string): Promise<boolean> {
    if (!this.requireConfirm() || this.autoApprove?.()) return true;
    const name = vscode.workspace.asRelativePath(uri);
    const leftUri = this.provider.set(this.token(`current/${name}`), current);
    const rightUri = this.provider.set(this.token(`proposed/${name}`), proposed);
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true });
    if (this.confirmViaUi) {
      const inline = await this.confirmViaUi({ path: name, title: `Apply changes to ${name}?`, kind: 'write' });
      if (inline !== undefined) return inline;
    }
    const choice = await vscode.window.showInformationMessage(`Apply changes to ${name}?`, { modal: true }, 'Apply');
    return choice === 'Apply';
  }

  /** Replace a file's whole content after a diff preview + confirmation. The confirm dialog can
   *  sit open for a long time, so the content is re-read before applying and a manual edit made
   *  meanwhile is never clobbered. */
  async write(uri: vscode.Uri, content: string): Promise<EditResult> {
    return this.withLock(uri, async () => {
      const beforeRaw = await this.readIfExists(uri);
      const ok = await this.previewAndConfirm(uri, beforeRaw ?? '', content, `Write ${vscode.workspace.asRelativePath(uri)}`);
      if (!ok) return { applied: false, error: 'User rejected the change.' };
      if ((await this.readIfExists(uri)) !== beforeRaw) {
        return { applied: false, error: 'File changed on disk since the preview was shown — reload and retry the edit.' };
      }
      const edit = new vscode.WorkspaceEdit();
      if (beforeRaw === undefined) edit.createFile(uri, { ignoreIfExists: true });
      edit.replace(uri, new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0), content);
      const applied = await vscode.workspace.applyEdit(edit);
      if (applied) await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
      return { applied };
    });
  }
}
