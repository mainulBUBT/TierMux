// Per-turn checkpoints: snapshot every file the agent touches during one turn so
// the whole batch can be reviewed (diffed) and restored as a unit. In-memory and
// session-scoped (reset on New chat; not persisted across window reloads).
import * as vscode from 'vscode';
import type { CheckpointFile } from '../messages';
import { captureWorkingTree, changedSince, restoreToTree, readFileAtTree } from './gitSnapshot';

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

/**
 * Shared singleton backing every checkpoint diff. Registered exactly ONCE for the
 * `fla-checkpoint` scheme (see registerCheckpointContentProvider); each session's
 * CheckpointManager writes only its own globally-unique tokens into this store, so
 * concurrent sessions never collide. (Per-session checkpoint *data* still lives on
 * each CheckpointManager instance — only the content-provider plumbing is shared,
 * because VS Code allows one provider per scheme.)
 */
export const baselineProvider = new BaselineContentProvider();

/** Register the checkpoint diff content provider. Call exactly once in activate(). */
export function registerCheckpointContentProvider(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(SCHEME, baselineProvider);
}

/** Module-wide counter for diff tokens — concurrent sessions must never reuse a token
 *  in the shared provider's store. (Checkpoint *ids* stay per-instance: they're only
 *  ever resolved through their owning session's CheckpointManager.) */
let diffTokenSeq = 0;

interface Snapshot { uri: vscode.Uri; rel: string; before: string | null }
interface Checkpoint { id: string; requestId: string; label: string; ts: number; snaps: Map<string, Snapshot>; beginTree?: string }

export class CheckpointManager {
  private readonly provider = baselineProvider;
  private readonly cwd?: string;
  private checkpoints: Checkpoint[] = [];
  private current?: Checkpoint;
  private counter = 0;

  constructor(cwd?: string) {
    this.cwd = cwd;
  }

  /**
   * Open a checkpoint for a new agent turn. Captures the working tree as a git snapshot
   * (non-mutating) so edits the agent applies DIRECTLY to the workspace — bypassing
   * TierMux's EditGate/record() — are still revertible. Must be awaited before the run
   * applies edits, so the begin tree is captured first. In a non-git repo beginTree stays
   * undefined and the record()/snaps fallback path is used instead.
   */
  async begin(requestId: string, label: string): Promise<void> {
    const beginTree = this.cwd ? await captureWorkingTree(this.cwd) : undefined;
    this.current = { id: `cp${++this.counter}`, requestId, label, ts: Date.now(), snaps: new Map(), beginTree: beginTree ?? undefined };
  }

  /** Record a file's pre-edit content the first time it's touched in this turn. */
  record(uri: vscode.Uri, before: string | null): void {
    const cp = this.current;
    if (!cp) return;
    const key = uri.toString();
    if (cp.snaps.has(key)) return; // keep the earliest pre-turn state
    cp.snaps.set(key, { uri, rel: vscode.workspace.asRelativePath(uri), before });
  }

  /** Finalize the current checkpoint; keep it if it captured edits OR a git begin tree. */
  commit(): string | undefined {
    const cp = this.current;
    this.current = undefined;
    if (!cp || (cp.snaps.size === 0 && !cp.beginTree)) return undefined;
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

  /**
   * The git working tree captured at the START of checkpoint `id` — i.e. the workspace state
   * immediately before that turn. Used as the restore target in git mode. Falls back to a
   * later checkpoint's beginTree if `id`'s capture failed, and ultimately to undefined
   * (snaps path).
   */
  private beginTreeSince(id: string): string | undefined {
    const start = this.checkpoints.findIndex((c) => c.id === id);
    if (start < 0) return undefined;
    for (let i = start; i < this.checkpoints.length; i++) {
      if (this.checkpoints[i].beginTree) return this.checkpoints[i].beginTree;
    }
    return undefined;
  }

  /** Per-file content snapshots (EditGate.record() / the onTool pre-write hook), diffed
   *  against current disk content. This is the ONLY source of truth for files a git-tree
   *  diff can't see — gitignored files, or any workspace that isn't a git repo at all. */
  private async changedFilesFromSnaps(id: string): Promise<CheckpointFile[]> {
    const out: CheckpointFile[] = [];
    for (const s of this.aggregateSince(id).values()) {
      const cur = await this.read(s.uri);
      if (s.before === null) { if (cur !== null) out.push({ uri: s.uri.toString(), rel: s.rel, status: 'created' }); }
      else if (cur === null) out.push({ uri: s.uri.toString(), rel: s.rel, status: 'deleted' });
      else if (cur !== s.before) out.push({ uri: s.uri.toString(), rel: s.rel, status: 'modified' });
    }
    return out;
  }

  /**
   * Files that would be reverted by restoring to before this message. Git mode (beginTree
   * present) covers everything `git add -A` can see, i.e. tracked + non-ignored untracked
   * files. It CANNOT see gitignored files (.env, generated configs, ...) since `add -A`
   * skips them — so snap-based results are always merged in on top, not treated as a
   * mutually-exclusive fallback, to cover exactly those files.
   */
  async changedFiles(id: string): Promise<CheckpointFile[]> {
    const beginTree = this.beginTreeSince(id);
    const snapFiles = await this.changedFilesFromSnaps(id);
    if (!beginTree || !this.cwd) return snapFiles;
    const gitFiles = await changedSince(this.cwd, beginTree);
    const seen = new Set(gitFiles.map((f) => f.rel));
    for (const f of snapFiles) if (!seen.has(f.rel)) gitFiles.push(f);
    return gitFiles;
  }

  /** Restore the workspace to its state before this message. Returns # restored. */
  async restore(id: string): Promise<number> {
    const beginTree = this.beginTreeSince(id);
    let n = 0;
    const gitRel = new Set<string>();
    if (beginTree && this.cwd) {
      n += await restoreToTree(this.cwd, beginTree);
      for (const f of await changedSince(this.cwd, beginTree)) gitRel.add(f.rel);
    }
    // Snap-tracked files the git restore couldn't see (gitignored, or no git at all).
    for (const s of this.aggregateSince(id).values()) {
      if (gitRel.has(s.rel)) continue; // already restored above
      try {
        if (s.before === null) {
          if (await this.exists(s.uri)) { await vscode.workspace.fs.delete(s.uri, { useTrash: true }); n++; }
        } else {
          const cur = await this.read(s.uri);
          if (cur !== s.before) { await vscode.workspace.fs.writeFile(s.uri, new TextEncoder().encode(s.before)); n++; }
        }
      } catch { /* skip files we can't restore */ }
    }
    return n;
  }

  /** Open a diff of a file's pre-message baseline against its current content. */
  async openDiff(id: string, uriStr: string): Promise<void> {
    const snap = this.aggregateSince(id).get(uriStr);
    const fileUri = vscode.Uri.parse(uriStr);
    let rel: string;
    let before: string | null;
    if (snap) {
      rel = snap.rel;
      before = snap.before;
    } else {
      // Git mode: the bar's file list comes from a tree-to-tree diff, not EditGate.record(),
      // so edits the agent applied directly (bypassing the gate) have no snap here. Read the
      // pre-turn content straight from the begin tree instead of bailing out silently.
      const beginTree = this.beginTreeSince(id);
      if (!beginTree || !this.cwd) return;
      rel = vscode.workspace.asRelativePath(fileUri);
      before = await readFileAtTree(this.cwd, beginTree, rel);
    }
    const tk = ++diffTokenSeq;
    const left = this.provider.set(`base-${tk}/${rel}`, before ?? '');
    const title = `${rel} (checkpoint ↔ current)`;
    if (await this.exists(fileUri)) {
      await vscode.commands.executeCommand('vscode.diff', left, fileUri, title);
    } else {
      const right = this.provider.set(`cur-${tk}/${rel}`, '');
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
