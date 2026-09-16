// The model tier table, shared with the tiermux-admin worker repo.
//
// Every catalog row carries exactly one of frontier | strong | mid | small | unknown,
// and src/catalog/discovery.ts routes on it (tierOf). Rows the worker serves arrive
// already tagged -- the worker stamps them from this same table -- but the bundled
// catalog also carries platforms the worker does not manage (UnoRouter's 165 free
// models, and anything else curated only here). Those 174 rows reached the picker
// with no tier at all and fell through to tierOf()'s intelligenceRank fallback, which
// is the guesswork the tier system exists to replace.
//
// model-tiers.json here is a COPY of tiermux-admin/scripts/model-tiers.json. When that
// repo sits next to this one -- or TIERMUX_ADMIN points at it -- the copy is refreshed
// on every sync, so the two cannot drift apart unnoticed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelTierKey } from './modelTierKey.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCAL = join(HERE, 'model-tiers.json');
const ADMIN = process.env.TIERMUX_ADMIN
  ? join(process.env.TIERMUX_ADMIN, 'scripts', 'model-tiers.json')
  : join(HERE, '..', '..', 'tiermux-admin', 'scripts', 'model-tiers.json');

export { modelTierKey };

export const TIERS = ['frontier', 'strong', 'mid', 'small', 'unknown'];

/** Reads the table (refreshing the local copy from the admin repo when reachable) and
 *  returns a tierFor() that answers null -- never a guess -- for an id it has no entry
 *  for. The caller decides what an unanswerable id means; the validator fails on it. */
export function loadTierTable() {
  let source = 'bundled copy';
  if (existsSync(ADMIN)) {
    const fresh = readFileSync(ADMIN, 'utf8');
    let current = null;
    try { current = readFileSync(LOCAL, 'utf8'); } catch { /* first run */ }
    if (fresh !== current) writeFileSync(LOCAL, fresh, 'utf8');
    source = ADMIN;
  }
  const table = JSON.parse(readFileSync(LOCAL, 'utf8'));
  const index = new Map();
  for (const key of Object.keys(table)) {
    const k = modelTierKey(key);
    if (!index.has(k)) index.set(k, table[key]);
  }
  return {
    source,
    size: index.size,
    tierFor(modelId) {
      const entry = index.get(modelTierKey(modelId));
      return entry && entry.tier ? entry.tier : null;
    },
  };
}
