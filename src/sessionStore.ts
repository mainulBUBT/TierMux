import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

/** Persisted chat sessions: one JSON file per session under the extension's storage dir, with
 *  a small id index (newest first) in the memento.
 *
 *  They used to live in the workspace memento as one array. `Memento.update` deep-clones the
 *  value through JSON.stringify/parse on the extension-host thread, then ships the extension's
 *  WHOLE state to the main process, which stringifies it again into sqlite — and a save
 *  happens after every tool call during a run. A workspace with 36 chats had 16 MB of
 *  sessions, so each tool call paid that 16 MB round-trip three times over and the panel's
 *  own activation parsed it (2026-09-05, VS Code 1.136). Now a save is one ~300 KB file
 *  written off the main thread; the memento holds only ids. The legacy array is moved to
 *  files on first load. */
export class SessionStore<T extends { id: string }> {
  static readonly INDEX_KEY = 'tiermux.sessionIndex';
  static readonly LEGACY_KEY = 'tiermux.sessions';

  /** Per-id write chain so two saves of one session never interleave on disk. */
  private writes = new Map<string, Promise<void>>();

  constructor(private readonly dir: string, private readonly memento: vscode.Memento, private readonly max: number) {}

  private file(id: string): string { return path.join(this.dir, id.replace(/[^\w.-]/g, '_') + '.json'); }

  /** Ids, newest first. */
  ids(): string[] {
    return this.memento.get<string[]>(SessionStore.INDEX_KEY, []);
  }

  /** Every stored session, newest first. Sync: the provider needs them before the webview's
   *  first message. Moves the legacy memento array to files the first time it runs. */
  load(): T[] {
    fs.mkdirSync(this.dir, { recursive: true });
    const legacy = this.memento.get<T[]>(SessionStore.LEGACY_KEY);
    if (legacy) {
      const ids = this.ids();
      for (const s of legacy) {
        if (!ids.includes(s.id)) {
          try { fs.writeFileSync(this.file(s.id), JSON.stringify(s)); ids.push(s.id); } catch { /* skip one */ }
        }
      }
      void this.memento.update(SessionStore.INDEX_KEY, ids.slice(0, this.max));
      void this.memento.update(SessionStore.LEGACY_KEY, undefined);
    }
    const out: T[] = [];
    for (const id of this.ids()) {
      try { out.push(JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as T); } catch { /* missing or corrupt file: drop from the list */ }
    }
    return out;
  }

  /** Write one session and move it to the front; sessions past `max` are dropped. */
  save(session: T): void {
    const ids = this.ids();
    if (ids[0] !== session.id) {
      const next = [session.id, ...ids.filter((id) => id !== session.id)];
      for (const id of next.slice(this.max)) this.unlink(id);
      void this.memento.update(SessionStore.INDEX_KEY, next.slice(0, this.max));
    }
    this.write(session.id, JSON.stringify(session));
  }

  /** Update one stored session in place (a rename must not move the chat to the front). */
  patch(id: string, mutate: (s: T) => void): void {
    let s: T;
    try { s = JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as T; } catch { return; }
    mutate(s);
    if (this.ids().includes(id)) this.write(id, JSON.stringify(s));
  }

  remove(id: string): void {
    this.unlink(id);
    void this.memento.update(SessionStore.INDEX_KEY, this.ids().filter((x) => x !== id));
  }

  /** Atomic (tmp + rename), chained per id, off the main thread. */
  private write(id: string, data: string): void {
    const target = this.file(id);
    const prev = this.writes.get(id) ?? Promise.resolve();
    const run = prev
      .then(() => fs.promises.writeFile(target + '.tmp', data))
      .then(() => fs.promises.rename(target + '.tmp', target))
      .catch((e: unknown) => console.error('[tiermux] session save failed', id, e));
    this.writes.set(id, run);
  }

  private unlink(id: string): void {
    const prev = this.writes.get(id) ?? Promise.resolve();
    this.writes.set(id, prev.then(() => fs.promises.unlink(this.file(id))).catch(() => { /* already gone */ }));
  }
}
