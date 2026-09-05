

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

/** Shared singleton behind every checkpoint diff — VS Code allows one content provider per
 *  scheme. Each session writes only its own globally-unique tokens, so sessions never collide. */
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
interface Checkpoint { id: string; requestId: string; label: string; ts: number; snaps: Map<string, Snapshot>; beginTree?: string; touched: Set<string> }

/** JSON-serializable form of a Checkpoint, for persisting across an extension host restart. */
export interface SerializedCheckpoint {
  id: string; requestId: string; label: string; ts: number; beginTree?: string;
  snaps: Array<{ uri: string; rel: string; before: string | null }>;
  /** Paths TIERMUX itself edited this turn (edit-tool writes + attributed shell edits). Pre-dates
   *  this field being tracked → absent on old persisted sessions. */
  touched?: string[];
}

export class CheckpointManager {
  private readonly provider = baselineProvider;
  private readonly cwd?: string;
  private checkpoints: Checkpoint[] = [];
  private current?: Checkpoint;
  private counter = 0;

  constructor(cwd?: string, restored?: SerializedCheckpoint[]) {
    this.cwd = cwd;
    if (restored?.length) {
      this.checkpoints = restored.map((c) => ({
        id: c.id, requestId: c.requestId, label: c.label, ts: c.ts, beginTree: c.beginTree,
        snaps: new Map(c.snaps.map((s) => [s.uri, { uri: vscode.Uri.parse(s.uri), rel: s.rel, before: s.before }])),
        touched: new Set(c.touched ?? []),
      }));
      this.counter = restored.length;
    }
  }

  /** Serialize all checkpoints for persistence (see StoredSession.checkpoints). Per-file
   *  `before` content is kept inline — the same tradeoff EditGate.record() already makes in
   *  memory — so revert keeps working for gitignored files and non-git workspaces even after
   *  an extension host restart, not just for the git-diffable subset. */
  toJSON(): SerializedCheckpoint[] {
    return this.checkpoints.map((c) => ({
      id: c.id, requestId: c.requestId, label: c.label, ts: c.ts, beginTree: c.beginTree,
      snaps: [...c.snaps.values()].map((s) => ({ uri: s.uri.toString(), rel: s.rel, before: s.before })),
      touched: [...c.touched],
    }));
  }

  /** Open a checkpoint for a new turn: a non-mutating git snapshot of the working tree, so edits
   *  that bypass record() are still revertible. Await before the run edits. Non-git repos leave
   *  beginTree undefined and use the snaps path. */
  async begin(requestId: string, label: string): Promise<void> {
    const beginTree = this.cwd ? await captureWorkingTree(this.cwd) : undefined;
    this.current = { id: `cp${++this.counter}`, requestId, label, ts: Date.now(), snaps: new Map(), beginTree: beginTree ?? undefined, touched: new Set() };
  }

  /** Record a file's pre-edit content the first time it's touched in this turn. */
  record(uri: vscode.Uri, before: string | null): void {
    const cp = this.current;
    if (!cp) return;
    const key = uri.toString();
    cp.touched.add(vscode.workspace.asRelativePath(uri));
    if (cp.snaps.has(key)) return; // keep the earliest pre-turn state
    cp.snaps.set(key, { uri, rel: vscode.workspace.asRelativePath(uri), before });
  }

  /** Mark paths as TIERMUX-edited without a content snapshot — used for changes attributed to
   *  the agent's shell commands, where only the path set (not the pre-content) is known. */
  recordTouched(rels: string[]): void {
    const cp = this.current;
    if (!cp) return;
    for (const rel of rels) cp.touched.add(rel);
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

  /** Earliest baseline for every file touched from checkpoint `id` onward — the workspace state
   *  immediately before that turn. */
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

  /** The git tree captured at the START of checkpoint `id` (restore target in git mode); falls
   *  back to a later checkpoint's tree, then undefined (snaps path). */
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

  /** Files restoring to before this message would revert. Git mode sees what `git add -A` sees,
   *  which excludes gitignored files (.env, generated configs) — so snap results are always
   *  merged on top, never treated as a fallback. */
  async changedFiles(id: string): Promise<CheckpointFile[]> {
    const beginTree = this.beginTreeSince(id);
    const snapFiles = await this.changedFilesFromSnaps(id);
    if (!beginTree || !this.cwd) return snapFiles;
    const gitFiles = await changedSince(this.cwd, beginTree);
    const seen = new Set(gitFiles.map((f) => f.rel));
    for (const f of snapFiles) if (!seen.has(f.rel)) gitFiles.push(f);
    return gitFiles;
  }

  /** Paths TIERMUX itself edited from checkpoint `id` onward — edit-tool writes (record())
   *  plus changes attributed to the agent's shell commands (recordTouched()). */
  private aggregateTouchedSince(id: string): Set<string> {
    const start = this.checkpoints.findIndex((c) => c.id === id);
    const touched = new Set<string>();
    if (start < 0) return touched;
    for (let i = start; i < this.checkpoints.length; i++) {
      for (const rel of this.checkpoints[i].touched) touched.add(rel);
    }
    return touched;
  }

  /** changedFiles() filtered to what TierMux itself edited — the pinned "changed files" overview.
   *  Unfiltered it listed every workspace change since the first turn (the user's own edits, build
   *  output). Revert still uses the full set. Unfiltered when no touched data exists (older
   *  checkpoints). */
  async agentChangedFiles(id: string): Promise<CheckpointFile[]> {
    const all = await this.changedFiles(id);
    const touched = this.aggregateTouchedSince(id);
    if (!touched.size) return all;
    // Snap rels are TierMux-edited by definition — also honor them directly so a
    // record()-stored rel that differs in convention from the git rel (workspace root ≠
    // repo root) still matches its own snap-sourced entry.
    const snapRels = new Set([...this.aggregateSince(id).values()].map((s) => s.rel));
    return all.filter((f) => touched.has(f.rel) || snapRels.has(f.rel));
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

  /** Like idForRequest, but also matches the turn still IN FLIGHT: the Work Report is stamped
   *  before finishCheckpoint() commits, so the turn's checkpoint is still `current`. A stale id
   *  from a discarded checkpoint is harmless — openDiff() no-ops on an unknown id. */
  idForTurn(requestId: string): string | undefined {
    if (this.current?.requestId === requestId) return this.current.id;
    return this.idForRequest(requestId);
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
