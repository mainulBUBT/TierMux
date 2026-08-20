/* Dynamic catalog + announcements sync: fetch → reconcile → notify pipeline.
 *
 * Covers the three behaviours added for background catalog syncing:
 *  1. `/announcements` rows arrive oldest-first from the worker and must be re-sorted
 *     newest-first everywhere (webview feed, toast pick).
 *  2. Seen/notified tracking: a first run must seed silently (no toast flood), a genuinely
 *     new announcement must be reported exactly once, and the unseen dot must count items
 *     the user hasn't opened the Tips page for.
 *  3. A refresh that stops serving models must prune them from the local fallback chain
 *     (the "removed from remote ⇒ removed locally" half of the sync contract), and the
 *     provider defs fetched alongside must be persisted for cold-start restore.
 *
 * Run: npm run test:e2e:announcement-sync   (from the repo root — cwd locates media/catalog.json)
 */
import * as path from 'path';
import { Catalog, PROVIDER_DEFS_KEY } from '../src/catalog/catalog';
import { SettingsStore } from '../src/config/settingsStore';
import {
  parseAnnouncementsBody,
  unnotifiedAnnouncements,
  unseenAnnouncementCount,
  markAnnouncementsSeen,
  fetchAnnouncements,
  NOTIFIED_ANNOUNCEMENTS_KEY,
  SEEN_ANNOUNCEMENTS_KEY,
} from '../src/catalog/announcements';
import { getPlatformInfo } from '../src/providers';
import type { Platform } from '../src/shared/types';

const repoRoot = process.cwd();

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

/** Minimal vscode.Memento backed by a Map. */
class Mem {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get(key: string, defaultValue?: unknown): unknown { return this.map.has(key) ? this.map.get(key) : defaultValue; }
  async update(key: string, value: unknown): Promise<void> { this.map.set(key, value); }
}

const annBody = (rows: Array<{ id: number; title: string }>) =>
  JSON.stringify({ version: '1.6', last_updated: '2026-08-20', announcements: rows.map((r) => ({ id: r.id, title: r.title, details: `details ${r.id}` })) });

console.log('— announcements arrive newest-first —');
{
  const parsed = parseAnnouncementsBody(annBody([{ id: 3, title: 'third' }, { id: 1, title: 'first' }, { id: 2, title: 'second' }]))!;
  ok('parsed three items', parsed.items.length === 3);
  ok('sorted newest-first', JSON.stringify(parsed.items.map((i) => i.id)) === '[3,2,1]');
  ok('carries last_updated', parsed.lastUpdated === '2026-08-20');
  ok('garbage body → null', parseAnnouncementsBody('not json') === null);
  ok('wrong shape → null', parseAnnouncementsBody('{"foo":1}') === null);
}

console.log('\n— notified (toast) tracking: seed silently, then report each new item once —');
{
  const mem = new Mem();
  const first = unnotifiedAnnouncements(mem, parseAnnouncementsBody(annBody([{ id: 1, title: 'a' }, { id: 2, title: 'b' }]))!.items);
  ok('first run reports nothing (seed)', first.length === 0);
  ok('and seeds the notified set', mem.get<number[]>(NOTIFIED_ANNOUNCEMENTS_KEY)?.length === 2);

  const second = unnotifiedAnnouncements(mem, parseAnnouncementsBody(annBody([{ id: 1, title: 'a' }, { id: 2, title: 'b' }, { id: 3, title: 'NEW' }]))!.items);
  ok('a new announcement is reported', second.length === 1 && second[0].id === 3);
  const third = unnotifiedAnnouncements(mem, parseAnnouncementsBody(annBody([{ id: 1, title: 'a' }, { id: 2, title: 'b' }, { id: 3, title: 'NEW' }]))!.items);
  ok('but only once', third.length === 0);

  const empty = unnotifiedAnnouncements(mem, parseAnnouncementsBody(annBody([]))!.items);
  ok('empty list no-ops', empty.length === 0);
}

console.log('\n— unseen (dot) tracking: counts until the Tips page is opened —');
{
  const mem = new Mem();
  const before = parseAnnouncementsBody(annBody([{ id: 1, title: 'a' }]))!.items;
  ok('no dot on first run', unseenAnnouncementCount(mem, before) === 0);
  void markAnnouncementsSeen(mem, before); // page opened
  const after = parseAnnouncementsBody(annBody([{ id: 1, title: 'a' }, { id: 2, title: 'new' }]))!.items;
  ok('one unseen after a new item arrives', unseenAnnouncementCount(mem, after) === 1);
  void markAnnouncementsSeen(mem, after);
  ok('zero again once the page is opened', unseenAnnouncementCount(mem, after) === 0);
  ok('seen set persisted', mem.get<number[]>(SEEN_ANNOUNCEMENTS_KEY)?.length === 2);
}

// The two blocks below await network stubs — top-level await isn't available under the CJS
// e2e bundle format, so they run inside a main() instead.
async function main(): Promise<void> {
console.log('\n— fetchAnnouncements derives the endpoint from the catalog base —');
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, text: async () => annBody([{ id: 9, title: 'fetched' }]) })) as typeof fetch;
  try {
    const res = await fetchAnnouncements('https://worker.example/');
    ok('fetched via joinBase', res !== null && res.items[0].id === 9);
    ok('blank base → null', (await fetchAnnouncements('   ')) === null);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log('\n— refresh reconciles: removed models pruned locally, provider defs cached for cold start —');
{
  const catalogMem = new Mem();
  const settingsMem = new Mem();
  const catalog = new Catalog(repoRoot); // bundled media/catalog.json as the starting point
  const settings = new SettingsStore(settingsMem, catalog);
  const before = settings.getFallback();
  ok('bundled catalog seeded the fallback list', before.length > 10, `${before.length} entries`);
  // How many of the worker's survivor rows exist in the bundled list (drives the removed count).
  const survivorsBefore = before.filter((e) => e.platform === 'groq' && e.modelId === 'llama-3.3-70b-versatile').length;

  // Serve a much smaller worker catalog: groq keeps one model, everything else is "retired",
  // plus a brand-new platform to prove defs+models flow end to end.
  const modelsBody = JSON.stringify({
    version: '1.7', last_updated: '2026-08-20',
    models: [
      { model_id: 'llama-3.3-70b-versatile', display_name: 'Llama 3.3 70B', enabled: true, provider_id: 'groq' },
      { model_id: 'acme-turbo', display_name: 'Acme Turbo', enabled: true, provider_id: 'acmetest' },
    ],
  });
  const providersBody = JSON.stringify({
    providers: [{ provider_id: 'acmetest', display_name: 'Acme Test', base_url: 'https://api.acmetest.example/v1', keyless: false }],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL) => {
    const s = String(u);
    const body = s.endsWith('/models') ? modelsBody : s.endsWith('/providers') ? providersBody : annBody([{ id: 1, title: 'a' }]);
    return { ok: true, text: async () => body } as Response;
  }) as typeof fetch;
  try {
    const report = await catalog.refresh('https://worker.example/', catalogMem);
    ok('refresh reported removals', (report?.removed.length ?? -1) === before.length - survivorsBefore, `${report?.removed.length} removed`);
    ok('refresh reported the new acmetest model', report?.added.includes('acmetest::acme-turbo') === true);

    const after = settings.getFallback(); // runs reconcile() against the new catalog
    const keys = new Set(after.map((e) => `${e.platform}::${e.modelId}`));
    ok('fallback pruned to what the worker still serves', after.length === 2, `${after.length} entries`);
    ok('retired models are gone', [...keys].every((k) => k === 'groq::llama-3.3-70b-versatile' || k === 'acmetest::acme-turbo'));
    ok('surviving model kept', keys.has('groq::llama-3.3-70b-versatile'));
    ok('new model appended', keys.has('acmetest::acme-turbo'));

    // The provider defs from /providers must be persisted so a cold start (fresh window,
    // offline first tick) can register the remote provider without a live fetch.
    const defs = catalogMem.get<Array<{ platform: string; baseUrl: string; name?: string }>>(PROVIDER_DEFS_KEY);
    ok('provider defs cached', Array.isArray(defs) && defs.some((d) => d.platform === 'acmetest' && d.baseUrl === 'https://api.acmetest.example/v1'));
    const cold = new Catalog(repoRoot);
    cold.loadCached(catalogMem, 'https://worker.example/');
    ok('cached model list restored on cold start', cold.all().length === 2);
    const info = getPlatformInfo('acmetest' as Platform);
    ok('acmetest registered with its display name', info?.name === 'Acme Test' && info?.defaultBaseUrl === 'https://api.acmetest.example/v1');
  } finally {
    globalThis.fetch = originalFetch;
  }
}
}

main()
  .then(() => {
    console.log(bad ? `\n${bad} FAILURE(S)` : '\nALL PASS');
    process.exit(bad ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
