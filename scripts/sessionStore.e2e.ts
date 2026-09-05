/* Sessions persist as one file each; the memento holds only the id index. Pins the 2026-09-05
 * fault: every memento update ships the extension's whole state, so a 16 MB session array was
 * re-sent on every tool call and on panel open. Run: npm run test:e2e:session-store */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionStore } from '../src/sessionStore';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

/** Memento double that records the byte size of every update — the thing under test. */
class Memento {
  data = new Map<string, unknown>();
  updateBytes: number[] = [];
  get<T>(key: string, def?: T): T | undefined { return (this.data.has(key) ? this.data.get(key) : def) as T | undefined; }
  keys(): readonly string[] { return [...this.data.keys()]; }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key); else this.data.set(key, value);
    this.updateBytes.push(JSON.stringify(Object.fromEntries(this.data)).length);
  }
}
type S = { id: string; title: string; transcript: string[] };
const big = (id: string, title: string): S => ({ id, title, transcript: ['x'.repeat(200_000)] });
const settle = () => new Promise((r) => setTimeout(r, 50));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sessions-'));

(async () => {
  // 1. Legacy array → files, memento shrinks to the index only.
  const mem = new Memento();
  mem.data.set(SessionStore.LEGACY_KEY, [big('a', 'A'), big('b', 'B'), big('c', 'C')]);
  const store = new SessionStore<S>(dir, mem, 50);
  const loaded = store.load();
  ok('legacy sessions load in order', loaded.map((s) => s.id).join() === 'a,b,c');
  ok('legacy key removed', !mem.data.has(SessionStore.LEGACY_KEY));
  ok('files exist', ['a', 'b', 'c'].every((id) => fs.existsSync(path.join(dir, id + '.json'))));
  ok('memento holds only ids', mem.updateBytes[mem.updateBytes.length - 1] < 200, `${mem.updateBytes[mem.updateBytes.length - 1]} bytes`);

  // 2. Saving one session never re-sends the others: memento update stays tiny, file has the data.
  mem.updateBytes = [];
  store.save({ ...big('b', 'B2'), transcript: ['y'.repeat(300_000)] });
  await settle();
  ok('save moves the session to the front', store.ids().join() === 'b,a,c');
  ok('save writes only the index to the memento', Math.max(0, ...mem.updateBytes) < 200, `${Math.max(0, ...mem.updateBytes)} bytes`);
  ok('file holds the new content', (JSON.parse(fs.readFileSync(path.join(dir, 'b.json'), 'utf8')) as S).title === 'B2');
  mem.updateBytes = [];
  store.save({ ...big('b', 'B3') });
  await settle();
  ok('saving the front session touches no memento key', mem.updateBytes.length === 0);

  // 3. Two quick saves of one id: the last one wins, no torn file.
  store.save(big('a', 'A1')); store.save(big('a', 'A2')); store.save(big('a', 'A3'));
  await settle();
  ok('chained writes: last save wins', (JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')) as S).title === 'A3');
  ok('no tmp file left behind', !fs.existsSync(path.join(dir, 'a.json.tmp')));

  // 4. patch keeps order; remove drops file and id; cap drops the oldest.
  store.patch('c', (s) => { s.title = 'C-renamed'; });
  await settle();
  ok('patch keeps the index order', store.ids().join() === 'a,b,c');
  ok('patch wrote the title', (JSON.parse(fs.readFileSync(path.join(dir, 'c.json'), 'utf8')) as S).title === 'C-renamed');
  store.remove('b');
  await settle();
  ok('remove drops id and file', store.ids().join() === 'a,c' && !fs.existsSync(path.join(dir, 'b.json')));
  const small = new SessionStore<S>(dir, mem, 2);
  small.save(big('d', 'D'));
  await settle();
  ok('cap keeps the newest N', small.ids().join() === 'd,a' && !fs.existsSync(path.join(dir, 'c.json')));

  // 5. A corrupt file is dropped on load instead of breaking the panel.
  fs.writeFileSync(path.join(dir, 'a.json'), '{not json');
  const reloaded = new SessionStore<S>(dir, mem, 50).load();
  ok('corrupt file skipped', reloaded.map((s) => s.id).join() === 'd');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(bad ? `\n${bad} FAILED` : '\nALL PASS');
  process.exit(bad ? 1 : 0);
})();
