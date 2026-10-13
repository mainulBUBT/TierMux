/* The catalog refresh is conditional: an unchanged catalog comes back as a bodiless 304, a list the
 * shrink guard holds back does not adopt its ETag (so the next refresh re-reads the body and can
 * accept it), and no ETag is sent while nothing is cached. Run: npm run test:e2e:catalog-etag */
import * as path from 'path';
import { Catalog } from '../src/catalog/catalog';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const rows = (n: number) => ({ count: n, models: Array.from({ length: n }, (_, i) => ({ provider_id: 'groq', model_id: `m${i}`, display_name: `M${i}`, enabled: true, tools: true, context_window: 128000 })) });
let current = { body: JSON.stringify(rows(30)), etag: '"v1"' };
const seen: Array<{ url: string; inm: string | null; status: number }> = [];
globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
  const url = String(input);
  const inm = init?.headers?.['If-None-Match'] ?? null;
  const res = url.endsWith('/providers')
    ? new Response(JSON.stringify({ providers: [] }), { status: 200, headers: { etag: '"p1"' } })
    : inm === current.etag ? new Response(null, { status: 304 }) : new Response(current.body, { status: 200, headers: { etag: current.etag } });
  seen.push({ url, inm, status: res.status });
  return res;
}) as typeof fetch;

const store = new Map<string, unknown>();
const mem = { get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d), update: async (k: string, v: unknown) => { if (v === undefined) store.delete(k); else store.set(k, v); }, keys: () => [...store.keys()] };
const ROOT = path.join(__dirname, '..');
const BASE = 'https://worker.test/';
const lastModels = () => seen.filter((s) => s.url.endsWith('/models')).at(-1)!;

async function main() {
  const catalog = new Catalog(ROOT);
  catalog.loadCached(mem as never, BASE);
  const first = await catalog.refresh(BASE, mem as never);
  ok('first refresh adopts the list', first?.changed === true && catalog.all().length === 30, String(catalog.all().length));
  ok('no ETag sent while nothing was cached', lastModels().inm === null);

  const again = await catalog.refresh(BASE, mem as never);
  ok('second refresh sends the ETag and gets a 304', lastModels().inm === '"v1"' && lastModels().status === 304);
  ok('an unchanged catalog reports no change', again?.changed === false && catalog.all().length === 30);

  current = { body: JSON.stringify(rows(10)), etag: '"v2"' };
  const held = await catalog.refresh(BASE, mem as never);
  ok('a sudden shrink is held back', held === null && catalog.all().length === 30);
  const accepted = await catalog.refresh(BASE, mem as never);
  ok('the held list was re-read in full, not 304ed', lastModels().inm === '"v1"' && lastModels().status === 200);
  ok('and accepted the second time', accepted !== null && catalog.all().length === 10, String(catalog.all().length));
  await catalog.refresh(BASE, mem as never);
  ok('its ETag is the one sent next', lastModels().inm === '"v2"' && lastModels().status === 304);

  console.log(bad === 0 ? '\nConditional catalog refresh holds.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();
