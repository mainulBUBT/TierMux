/* A model the user switched off stays off when it drops out of the catalog and comes back: the
 * fallback list loses absent models on save, so the opt-out has to outlive the row.
 * Run: npm run test:e2e:model-opt-out */
import { SettingsStore } from '../src/config/settingsStore';
import type { CatalogModel } from '../src/shared/types';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const store = new Map<string, unknown>();
const mem = { get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d), update: async (k: string, v: unknown) => { store.set(k, v); }, keys: () => [...store.keys()] };
const row = (modelId: string) => ({ platform: 'groq', modelId }) as CatalogModel;
let models = [row('a'), row('b'), row('c')];
const catalog = { all: () => models, defaultFallback: () => models.map((m, i) => ({ platform: m.platform, modelId: m.modelId, enabled: true, priority: i })) };
const settings = new SettingsStore(mem as never, catalog as never);

async function main() {
  const enabled = (id: string) => settings.getFallback().find((e) => e.modelId === id)?.enabled;
  settings.getFallback();
  await settings.setFallback(settings.getFallback().map((e) => (e.modelId === 'b' ? { ...e, enabled: false } : e)));
  ok('b is off', enabled('b') === false);

  models = [row('a'), row('c')];
  await settings.setFallback(settings.getFallback());
  ok('b left the catalog and the saved list', !settings.getFallback().some((e) => e.modelId === 'b'));

  models = [row('a'), row('b'), row('c')];
  ok('b came back still off', enabled('b') === false, String(enabled('b')));

  await settings.setFallback(settings.getFallback().map((e) => (e.modelId === 'b' ? { ...e, enabled: true } : e)));
  models = [row('a'), row('c')];
  await settings.setFallback(settings.getFallback());
  models = [row('a'), row('b'), row('c')];
  ok('after the user turns it back on, a return keeps it on', enabled('b') === true, String(enabled('b')));

  models = [row('a'), row('b'), row('c'), row('d')];
  ok('a genuinely new model still auto-enables', enabled('d') === true);

  console.log(bad === 0 ? '\nOpt-outs survive catalog churn.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();
