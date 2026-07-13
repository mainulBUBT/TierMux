// Regenerate media/catalog.json from the remote catalog CSV so the bundled
// fallback always matches the published sheet (including removals of models or
// whole providers). Dev-staged rows (ready=false) are excluded so the bundled
// file only ever contains published models — keeps the offline fallback clean.
//
//   node scripts/sync-catalog.mjs [csvUrl]
//
// Defaults to the `tiermux.catalog.url` value declared in package.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function defaultCatalogUrl() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return pkg?.contributes?.configuration?.properties?.['tiermux.catalog.url']?.default ?? '';
}

const url = process.argv[2] || defaultCatalogUrl();
if (!url) {
  console.error('No catalog URL found (pass one as argv, or set tiermux.catalog.url default in package.json).');
  process.exit(1);
}

// --- minimal RFC-4180-ish CSV parser (mirrors src/catalog/catalog.ts) ---
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const num = (s) => {
  if (s === undefined || s.trim() === '') return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
};
const bool = (s, def) => {
  if (s === undefined || s.trim() === '') return def;
  return /^(true|1|yes)$/i.test(s.trim());
};

async function main() {
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Catalog fetch failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const text = await res.text();
  const rows = parseCsv(text);
  if (rows.length < 2) {
    console.error('Catalog CSV has no model rows.');
    process.exit(1);
  }
  const header = rows[0].map((h) => h.trim());
  const col = (name) => header.indexOf(name);
  const iPlatform = col('platform');
  const iModel = col('modelId');
  if (iPlatform < 0 || iModel < 0) {
    console.error('CSV missing required "platform"/"modelId" columns.');
    process.exit(1);
  }
  const get = (row, name) => { const i = col(name); return i >= 0 ? row[i] : undefined; };

  const models = [];
  const providers = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const platform = (row[iPlatform] ?? '').trim();
    const modelId = (row[iModel] ?? '').trim();
    if (!platform || !modelId) continue;
    if (bool(get(row, 'ready'), true) === false) continue; // skip dev-staged rows
    const tagsRaw = (get(row, 'tags') ?? '').trim();
    models.push({
      platform,
      modelId,
      displayName: (get(row, 'displayName') ?? '').trim() || modelId,
      intelligenceRank: num(get(row, 'intelligenceRank')) ?? 5,
      speedRank: num(get(row, 'speedRank')) ?? 3,
      released: (get(row, 'released') ?? '').trim() || undefined,
      sizeLabel: (get(row, 'sizeLabel') ?? '').trim(),
      contextWindow: num(get(row, 'contextWindow')),
      rpmLimit: num(get(row, 'rpmLimit')),
      rpdLimit: num(get(row, 'rpdLimit')),
      monthlyTokenBudget: (get(row, 'monthlyTokenBudget') ?? '').trim(),
      supportsTools: bool(get(row, 'supportsTools'), true),
      supportsVision: bool(get(row, 'supportsVision'), false),
      supportsReasoning: bool(get(row, 'supportsReasoning'), false),
      ...(get(row, 'rejectsRawPdf') && bool(get(row, 'rejectsRawPdf'), false)
        ? { rejectsRawPdf: true } : {}),
      ...(tagsRaw ? { tags: tagsRaw.split(/[·|,]/).map((t) => t.trim()).filter(Boolean) } : {}),
      ...((get(row, 'insight') ?? '').trim() ? { insight: (get(row, 'insight') ?? '').trim() } : {}),
      ...(num(get(row, 'origInputPricePer1M_USD')) != null
        ? { origInputPricePer1M: num(get(row, 'origInputPricePer1M_USD')) } : {}),
      ...(num(get(row, 'origOutputPricePer1M_USD')) != null
        ? { origOutputPricePer1M: num(get(row, 'origOutputPricePer1M_USD')) } : {}),
    });
    providers.add(platform);
  }

  const out = {
    version: 2,
    note: `Synced from remote catalog \u2014 ${models.length} models from ${providers.size} providers.`,
    models,
  };
  const dest = join(root, 'media', 'catalog.json');
  writeFileSync(dest, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${models.length} models (${providers.size} providers) to ${dest}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
