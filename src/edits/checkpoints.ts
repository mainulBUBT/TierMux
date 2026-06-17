// Per-turn checkpoints: snapshot every file the agent touches during one turn so
// the whole batch can be reviewed (diffed) and restored as a unit. In-memory and
// session-scoped (reset on New chat; not persisted across window reloads).
import * as vscode from 'vscode';
import type { CheckpointFile } from '../messages';

const SCHEME = 'fla-checkpoint';

/** Serves a checkpoint's baseline file content for the left side of a diff editor. */
class BaselineContentProvider implements vscode.TextDocumentContentProvider {
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

interface Snapshot { uri: vscode.Uri; rel: string; before: string | null }
interface Checkpoint { id: string; requestId: string; label: string; ts: number; snaps: Map<string, Snapshot> }

export class CheckpointManager {
  private readonly provider = new BaselineContentProvider();
  private checkpoints: Checkpoint[] = [];
  private current?: Checkpoint;
  private counter = 0;
  private diffToken = 0;

  register(): vscode.Disposable {
    return vscode.workspace.registerTextDocumentContentProvider(SCHEME, this.provider);
  }

  /** Open a checkpoint for a new agent turn. */
  begin(requestId: string, label: string): void {
    this.current = { id: `cp${++this.counter}`, requestId, label, ts: Date.now(), snaps: new Map() };
  }

  /** Record a file's pre-edit content the first time it's touched in this turn. */
  record(uri: vscode.Uri, before: string | null): void {
    const cp = this.current;
    if (!cp) return;
    const key = uri.toString();
    if (cp.snaps.has(key)) return; // keep the earliest pre-turn state
    cp.snaps.set(key, { uri, rel: vscode.workspace.asRelativePath(uri), before });
  }

  /** Finalize the current checkpoint; keep it only if it captured edits. */
  commit(): string | undefined {
    const cp = this.current;
    this.current = undefined;
    if (!cp || cp.snaps.size === 0) return undefined;
    this.checkpoints.push(cp);
    return cp.id;
  }

  /** All checkpoints (chronological) and the turn they belong to. */
  list(): Array<{ id: string; requestId: string }> {
    return this.checkpoints.map((c) => ({ id: c.id, requestId: c.requestId }));
  }

  /**
   * Aggregate the earliest baseline for every file touched from a checkpoint
   * onward — i.e. the workspace state immediately *before* that turn. A file not
   * touched between turn N and its first edit hasn't changed, so its first
   * recorded baseline equals its pre-N content.
   */
  private aggregateSince(id: string): Map<string, Snapshot> {
    const start = this.checkpoints.findIndex((c) => c.id === id);
    const earliest = new Map<string, Snapshot>();
    if (start < 0) return earliest;
    for (let i = start; i < this.checkpoints.length; i++) {
      for (const [k, s] of this.checkpoints[i].snaps) {
        if (!earliest.has(k)) earliest.set(k, s); // first occurrence = earliest baseline
      }
    }
    return earliest;
  }

  /** Files that would be reverted by restoring to before this message (by content). */
  async changedFiles(id: string): Promise<CheckpointFile[]> {
    const out: CheckpointFile[] = [];
    for (const s of this.aggregateSince(id).values()) {
      const cur = await this.read(s.uri);
      if (s.before === null) { if (cur !== null) out.push({ uri: s.uri.toString(), rel: s.rel, status: 'created' }); }
      else if (cur === null) out.push({ uri: s.uri.toString(), rel: s.rel, status: 'deleted' });
      else if (cur !== s.before) out.push({ uri: s.uri.toString(), rel: s.rel, status: 'modified' });
    }
    return out;
  }

  /** Restore the workspace to its state before this message. Returns # restored. */
  async restore(id: string): Promise<number> {
    let n = 0;
    for (const s of this.aggregateSince(id).values()) {
      try {
        if (s.before === null) {
          if (await this.exists(s.uri)) { await vscode.workspace.fs.delete(s.uri, { useTrash: true }); n++; }
        } else {
          await vscode.workspace.fs.writeFile(s.uri, new TextEncoder().encode(s.before));
          n++;
        }
      } catch { /* skip files we can't restore */ }
    }
    return n;
  }

  /** Open a diff of a file's pre-message baseline against its current content. */
  async openDiff(id: string, uriStr: string): Promise<void> {
    const snap = this.aggregateSince(id).get(uriStr);
    if (!snap) return;
    const fileUri = vscode.Uri.parse(uriStr);
    const tk = ++this.diffToken;
    const left = this.provider.set(`base-${tk}/${snap.rel}`, snap.before ?? '');
    const title = `${snap.rel} (checkpoint ↔ current)`;
    if (await this.exists(fileUri)) {
      await vscode.commands.executeCommand('vscode.diff', left, fileUri, title);
    } else {
      const right = this.provider.set(`cur-${tk}/${snap.rel}`, '');
      await vscode.commands.executeCommand('vscode.diff', left, right, title);
    }
  }

  /** Checkpoint id captured for a given turn (requestId), if any. */
  idForRequest(requestId: string): string | undefined {
    return this.checkpoints.find((c) => c.requestId === requestId)?.id;
  }

  /** Forget checkpoints belonging to reverted turns. */
  dropByRequestIds(ids: string[]): void {
    const set = new Set(ids);
    this.checkpoints = this.checkpoints.filter((c) => !set.has(c.requestId));
  }

  clear(): void { this.checkpoints = []; this.current = undefined; }

  private async read(uri: vscode.Uri): Promise<string | null> {
    try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { return null; }
  }
  private async exists(uri: vscode.Uri): Promise<boolean> {
    try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
  }
}
