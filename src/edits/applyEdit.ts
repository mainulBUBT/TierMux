

import * as vscode from 'vscode';
import type { RunContext } from '../agent/runContext';

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
  /** Per-URI serialization queue. Two tool calls that target the SAME path in one agent step
   *  (e.g. patching two hunks of one file) are fired in parallel by the AI SDK. Without a lock,
   *  both read the pre-edit content, each computes a full-file proposal against that old content,
   *  and the second full-file overwrite clobbers the first edit. Chaining same-URI ops onto one
   *  promise makes the second re-read the first's write. Different URIs stay fully parallel. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /**
   * When set, edit approval is requested in the chat view. The handler resolves
   * true/false, or `undefined` to defer to the native modal (e.g. the edit didn't
   * originate from a chat turn, so there's nowhere in the thread to show a card).
   */
  private confirmViaUi?: (req: { path: string; title: string; kind: 'write' | 'delete' }) => Promise<boolean | undefined>;
  /** Session toggle (from the composer): when true, apply edits without a diff prompt. */
  private autoApprove?: () => boolean;

  constructor(private readonly requireConfirm: () => boolean) {}

  /** Route edit approval through the webview (an inline Apply/Reject card). Pass undefined to revert to the native modal. */
  setConfirmHandler(fn?: (req: { path: string; title: string; kind: 'write' | 'delete' }) => Promise<boolean | undefined>): void {
    this.confirmViaUi = fn;
  }

  /** Provide a live read of the session Auto-approve toggle. */
  setAutoApprove(fn: () => boolean): void {
    this.autoApprove = fn;
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

  /** Serialize operations against a single URI. Each `fn` runs only after the previous op on the
   *  same URI settles, and re-reads on-disk content itself — so concurrent edits to one file apply
   *  in arrival order instead of racing. The returned promise resolves with `fn`'s result. */
  private withLock<T>(uri: vscode.Uri, fn: () => Promise<T>): Promise<T> {
    const key = uri.toString();
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run `fn` regardless of whether the previous op succeeded
    // Swallow rejection on the stored chain so a failed op can't poison the next one; the caller
    // of `fn` still sees its own real rejection via the returned `next` promise.
    const stored = next.then(() => undefined, () => undefined);
    this.locks.set(key, stored);
    // Drop the entry once idle (only if no newer op chained on top) so the map can't grow unbounded.
    stored.then(() => {
      if (this.locks.get(key) === stored) this.locks.delete(key);
    });
    return next;
  }

  /** Read the current text of a file, or undefined if it doesn't exist. */
  private async readIfExists(uri: vscode.Uri): Promise<string | undefined> {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    }
  }

  /** Locates `search` in `text`, requiring exactly one occurrence. A non-unique hunk would
   *  otherwise silently patch whichever occurrence `indexOf` happens to find first — easy to hit
   *  in files with repeated boilerplate (e.g. duplicated script blocks), and it corrupts the file
   *  without any error. */
  private locateUnique(text: string, search: string): { idx: number } | { error: string } {
    const idx = text.indexOf(search);
    if (idx === -1) return { error: 'Search text not found in file.' };
    if (text.indexOf(search, idx + 1) !== -1) {
      return { error: 'Search text matches multiple locations in file — include more surrounding context to make it unique.' };
    }
    return { idx };
  }

  /** Shows the diff, purely informational — no confirmation asked. Used by the `*Approved`
   *  entry points, where an external gate (the engine's `toolApproval` policy) already made the
   *  decision; showing the diff is still worth doing so the user can see what changed. */
  private async previewOnly(uri: vscode.Uri, current: string, proposed: string, title: string): Promise<void> {
    const name = vscode.workspace.asRelativePath(uri);
    const leftUri = this.provider.set(this.token(`current/${name}`), current);
    const rightUri = this.provider.set(this.token(`proposed/${name}`), proposed);
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true });
  }

  /** Show a diff between current and proposed content and (optionally) confirm. */
  private async previewAndConfirm(uri: vscode.Uri, current: string, proposed: string, title: string, ctx?: RunContext): Promise<boolean> {
    if (!this.requireConfirm()) return true;

    const autoApprove = ctx ? ctx.autoApprove() : this.autoApprove?.();
    if (autoApprove) return true;
    const name = vscode.workspace.asRelativePath(uri);
    const leftUri = this.provider.set(this.token(`current/${name}`), current);
    const rightUri = this.provider.set(this.token(`proposed/${name}`), proposed);
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true });

    const confirmViaUi = ctx ? ctx.approveEdit : this.confirmViaUi;
    if (confirmViaUi) {
      const inline = await confirmViaUi({ path: name, title: `Apply changes to ${name}?`, kind: 'write' });
      if (inline !== undefined) return inline;
    }
    const choice = await vscode.window.showInformationMessage(
      `Apply changes to ${name}?`,
      { modal: true },
      'Apply',
    );
    return choice === 'Apply';
  }

  /** Applies `content` without asking — the caller's `toolApproval` decision already stands in
   *  for the confirm click. Still shows the diff and records a checkpoint. */
  private async applyDirect(uri: vscode.Uri, content: string, title: string, ctx?: RunContext): Promise<EditResult> {
    const beforeRaw = await this.readIfExists(uri);
    await this.previewOnly(uri, beforeRaw ?? '', content, title);
    const recorder = ctx ? (u: vscode.Uri, b: string | null) => ctx.checkpoints.record(u, b) : this.recorder;
    recorder?.(uri, beforeRaw ?? null);
    const edit = new vscode.WorkspaceEdit();
    const exists = beforeRaw !== undefined;
    if (!exists) edit.createFile(uri, { ignoreIfExists: true });
    edit.replace(uri, new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0), content);
    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    return { applied };
  }

  /** Unlocked write-with-confirm core. Public locked entry points (`write`/`edit`/`create`) and
   *  the locked approved variants all funnel through either this or `applyDirect` — they NEVER
   *  call each other, so a same-URI op can't deadlock on its own lock. */
  private async writeCore(uri: vscode.Uri, content: string, ctx?: RunContext): Promise<EditResult> {
    const beforeRaw = await this.readIfExists(uri);
    const ok = await this.previewAndConfirm(uri, beforeRaw ?? '', content, `Write ${vscode.workspace.asRelativePath(uri)}`, ctx);
    if (!ok) return { applied: false, error: 'User rejected the change.' };
    const recorder = ctx ? (u: vscode.Uri, b: string | null) => ctx.checkpoints.record(u, b) : this.recorder;
    recorder?.(uri, beforeRaw ?? null); // snapshot pre-edit state for the checkpoint
    const edit = new vscode.WorkspaceEdit();
    const exists = beforeRaw !== undefined;
    if (!exists) edit.createFile(uri, { ignoreIfExists: true });
    edit.replace(uri, new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0), content);
    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    return { applied };
  }

  async write(uri: vscode.Uri, content: string, ctx?: RunContext): Promise<EditResult> {
    return this.withLock(uri, () => this.writeCore(uri, content, ctx));
  }

  async create(uri: vscode.Uri, content: string, ctx?: RunContext): Promise<EditResult> {
    return this.withLock(uri, async () => {
      if ((await this.readIfExists(uri)) !== undefined) return { applied: false, error: 'File already exists.' };
      return this.writeCore(uri, content, ctx);
    });
  }

  async edit(uri: vscode.Uri, search: string, replace: string, ctx?: RunContext): Promise<EditResult> {
    return this.withLock(uri, async () => {
      const current = await this.readIfExists(uri);
      if (current === undefined) return { applied: false, error: 'File not found.' };
      const located = this.locateUnique(current, search);
      if ('error' in located) return { applied: false, error: located.error };
      const proposed = current.slice(0, located.idx) + replace + current.slice(located.idx + search.length);
      return this.writeCore(uri, proposed, ctx);
    });
  }

  /** Approved-already variants — the engine's `toolApproval` policy made the decision; these
   *  skip straight to applying (still showing the diff / recording a checkpoint). They call the
   *  unlocked `applyDirect` core, never each other, to stay deadlock-free under the same-URI lock. */
  async writeApproved(uri: vscode.Uri, content: string, ctx?: RunContext): Promise<EditResult> {
    return this.withLock(uri, () => this.applyDirect(uri, content, `Write ${vscode.workspace.asRelativePath(uri)}`, ctx));
  }

  async createApproved(uri: vscode.Uri, content: string, ctx?: RunContext): Promise<EditResult> {
    return this.withLock(uri, async () => {
      if ((await this.readIfExists(uri)) !== undefined) return { applied: false, error: 'File already exists.' };
      return this.applyDirect(uri, content, `Write ${vscode.workspace.asRelativePath(uri)}`, ctx);
    });
  }

  async editApproved(uri: vscode.Uri, search: string, replace: string, ctx?: RunContext): Promise<EditResult> {
    return this.withLock(uri, async () => {
      const current = await this.readIfExists(uri);
      if (current === undefined) return { applied: false, error: 'File not found.' };
      const located = this.locateUnique(current, search);
      if ('error' in located) return { applied: false, error: located.error };
      const proposed = current.slice(0, located.idx) + replace + current.slice(located.idx + search.length);
      return this.applyDirect(uri, proposed, `Write ${vscode.workspace.asRelativePath(uri)}`, ctx);
    });
  }

  /** Multi-hunk approved edit — applies an ordered list of {search, replace} hunks to one file
   *  atomically: reads once, applies every hunk to the in-memory buffer in order, writes once.
   *  All-or-nothing — if any hunk's `search` text is absent, NO write happens and the error names
   *  the failing hunk index, so the file is never left half-patched. Lets the model patch a whole
   *  file in a single tool call, which also sidesteps the same-file parallel-edit race entirely. */
  async editMultiApproved(uri: vscode.Uri, hunks: Array<{ search: string; replace: string }>, ctx?: RunContext): Promise<EditResult> {
    return this.withLock(uri, async () => {
      const current = await this.readIfExists(uri);
      if (current === undefined) return { applied: false, error: 'File not found.' };
      let buffer = current;
      for (let i = 0; i < hunks.length; i++) {
        const { search, replace } = hunks[i];
        if (!search) return { applied: false, error: `Hunk ${i + 1}: missing "search" text.` };
        const located = this.locateUnique(buffer, search);
        if ('error' in located) return { applied: false, error: `Hunk ${i + 1}: ${located.error}` };
        buffer = buffer.slice(0, located.idx) + replace + buffer.slice(located.idx + search.length);
      }
      return this.applyDirect(uri, buffer, `Write ${vscode.workspace.asRelativePath(uri)}`, ctx);
    });
  }

  async removeApproved(uri: vscode.Uri, ctx?: RunContext): Promise<EditResult> {
    return this.withLock(uri, async () => {
      const current = await this.readIfExists(uri);
      if (current === undefined) return { applied: false, error: 'File not found.' };
      await this.previewOnly(uri, current, '', `Delete ${vscode.workspace.asRelativePath(uri)}`);
      const recorder = ctx ? (u: vscode.Uri, b: string | null) => ctx.checkpoints.record(u, b) : this.recorder;
      recorder?.(uri, current);
      const edit = new vscode.WorkspaceEdit();
      edit.deleteFile(uri, { ignoreIfNotExists: true });
      const applied = await vscode.workspace.applyEdit(edit);
      return { applied };
    });
  }

  async remove(uri: vscode.Uri, ctx?: RunContext): Promise<EditResult> {
    return this.withLock(uri, async () => {
      const current = await this.readIfExists(uri);
      if (current === undefined) return { applied: false, error: 'File not found.' };
      const autoApprove = ctx ? ctx.autoApprove() : this.autoApprove?.();
      if (this.requireConfirm() && !autoApprove) {
        const name = vscode.workspace.asRelativePath(uri);
        const confirmViaUi = ctx ? ctx.approveEdit : this.confirmViaUi;
        const inline = confirmViaUi ? await confirmViaUi({ path: name, title: `Delete ${name}?`, kind: 'delete' }) : undefined;
        const ok = inline !== undefined
          ? inline
          : (await vscode.window.showWarningMessage(`Delete ${name}?`, { modal: true }, 'Delete')) === 'Delete';
        if (!ok) return { applied: false, error: 'User rejected the deletion.' };
      }
      const recorder = ctx ? (u: vscode.Uri, b: string | null) => ctx.checkpoints.record(u, b) : this.recorder;
      recorder?.(uri, current); // snapshot pre-delete content so it can be restored
      const edit = new vscode.WorkspaceEdit();
      edit.deleteFile(uri, { ignoreIfNotExists: true });
      const applied = await vscode.workspace.applyEdit(edit);
      return { applied };
    });
  }
}
