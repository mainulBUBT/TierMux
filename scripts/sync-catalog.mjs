// Regenerate media/catalog.json from the remote worker /models JSON catalog so the
// bundled offline fallback ships every published model — including additions and removals.
//
//   node scripts/sync-catalog.mjs [catalogUrl]
//
// Defaults to the `tiermux.catalog.url` value declared in package.json, then appends
// `/models`. The worker serves JSON there now (it used to serve a curated CSV); this
// script reads that JSON.
//
// Merge policy (the bundled file is hand-curated, so we don't blindly overwrite):
//  - SURVIVORS (model present in both worker + bundled): keep the bundled curation
//    (intelligenceRank, speedRank, sizeLabel, released, insight, monthlyTokenBudget,
//    rejectsRawPdf, displayName) and refresh only worker-authoritative fields
//    (contextWindow, rpm/rpd limits, supportsTools/Vision/Reasoning, pricing, tags).
//  - NEW (worker only): derive ranks/sizeLabel from the id (port of deriveMetadata)
//    and fill the rest from the worker row.
//  - REMOVED (bundled only): dropped — the worker is the source of truth for availability.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const DEST = join(root, 'media', 'catalog.json');

function defaultCatalogUrl() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return pkg?.contributes?.configuration?.properties?.['tiermux.catalog.url']?.default ?? '';
}

// ---- JS port of src/catalog/discovery.ts deriveMetadata (kept in sync by hand) ----
const BENCH_INTEL = [
  [/nemotron.{0,4}ultra/i, 1],
  [/deepseek-r1\b/i, 1],
  [/gpt-4\.1\b(?!.*mini)/i, 1.5],
  [/gpt-4o\b(?!.*mini)/i, 1.5],
  [/glm-?5\b|glm-?5\.\d/i, 1.5],
  [/command-a.{0,3}plus/i, 1.5],
  [/kimi-k2\.[6-9]|kimi-k3/i, 1.5],
  [/glm-?4\.[7-9]/i, 2],
  [/deepseek.{0,3}v[3-9]/i, 2],
  [/qwen3-coder/i, 2],
  [/gpt-oss-120b/i, 2],
  [/llama-3\.1-405b/i, 2],
  [/mistral-large/i, 2],
  [/command-a\b(?!.*vision)(?!.*reasoning)/i, 2],
  [/minimax-m2/i, 2],
  [/step-3\.[7-9]/i, 2],
  [/nemotron.{0,4}super/i, 2.5],
  [/llama-3\.3-70b/i, 2.5],
  [/qwen2\.5-coder/i, 2.5],
  [/qwen2\.5-72b/i, 2.5],
  [/mistral-medium/i, 2.5],
  [/pixtral-large/i, 2.5],
  [/gemma-?4-31b/i, 3],
  [/qwen3[.\-]?\d?-27b|qwen3[.\-]?\d?-30b/i, 3],
  [/gpt-oss-20b/i, 3.5],
  [/ling-3\.0/i, 3],
  [/codestral/i, 3],
  [/mistral-small/i, 3.5],
  [/gpt-4\.1-mini|gpt-4o-mini/i, 4],
  [/flash-lite/i, 4],
  [/north-mini/i, 4],
  [/mimo/i, 4],
  [/mistral-nemo|open-mistral-nemo/i, 4.5],
];
const clampRank = (n) => Math.max(1, Math.min(5, Math.round(n)));
const paramsB = (id) => {
  const hits = [...id.toLowerCase().matchAll(/(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/g)]
    .map((m) => parseFloat(m[1]))
    .filter((n) => Number.isFinite(n) && n >= 0.5 && n <= 2000);
  return hits.length ? Math.max(...hits) : undefined;
};
function benchIntel(id) {
  for (const [re, rank] of BENCH_INTEL) if (re.test(id)) return rank;
  return undefined;
}
function deriveMetadata(modelId, ctx, supportsReasoning) {
  const id = modelId.toLowerCase();
  const p = paramsB(id);
  const big = /\b(opus|ultra|pro|large|max|405b|70b|72b|120b|235b|671b)\b/.test(id);
  const small = /\b(mini|flash|lite|small|nano|tiny|instant|turbo|haiku|air)\b/.test(id);
  const known = benchIntel(id);
  let intel = known ?? 3;
  if (known === undefined) {
    if (p !== undefined) intel = p >= 200 ? 1 : p >= 70 ? 2 : p >= 30 ? 2.5 : p >= 12 ? 3.5 : 4.5;
    else if (big) intel = 1.5;
    else if (small) intel = 4;
  }
  if ((ctx ?? 0) >= 1_000_000) intel -= 1;
  else if ((ctx ?? 0) >= 200_000) intel -= 0.5;
  let speed = 3;
  if (small) speed = 1.5;
  else if (p !== undefined) speed = p >= 200 ? 5 : p >= 70 ? 4 : p >= 30 ? 3.5 : p >= 12 ? 2.5 : 1.5;
  else if (big) speed = 4;
  const tags = [];
  if (/cod(e|er|ing)|program|dev\b|swe\b/.test(id)) tags.push('coding');
  return {
    intelligenceRank: clampRank(intel),
    speedRank: clampRank(speed),
    sizeLabel: p !== undefined ? `${p}B` : small ? 'small' : big ? 'large' : '',
    supportsReasoning: supportsReasoning ?? /\br1\b|reason|think|\bo[1-4]\b|kimi-k3/i.test(id),
    tags: tags.length ? tags : undefined,
  };
}

const WORKER_TAG_MAP = {
  coder: 'coding', coding: 'coding',
  planner: 'planner', plan: 'planner',
  reasoner: 'reasoner', reasoning: 'reasoner',
  general: 'general', router: 'router',
};

const num = (s) => {
  if (s === undefined || s === null || String(s).trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const wBool = (v, def) => {
  if (v === undefined || v === null) return def;
  if (typeof v === 'boolean') return v;
  return /^(true|1|yes)$/i.test(String(v).trim());
};

async function main() {
  const argv = process.argv.slice(2).filter((a) => a !== '--prune');
  const prune = process.argv.slice(2).includes('--prune');
  const base = (argv[0] || defaultCatalogUrl() || '').replace(/\/+$/, '');
  if (!base) {
    console.error('No catalog URL (pass one as argv, or set tiermux.catalog.url default in package.json).');
    process.exit(1);
  }
  const url = base + '/models';
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    // Network failure (offline, DNS) is non-fatal: a stale bundled catalog is better than
    // a broken build/publish. This script is wired into `npm run build`, so it must never
    // block the toolchain when the worker is unreachable.
    console.warn(`[sync-catalog] network error fetching ${url} — skipping (${e.message}).`);
    return;
  }
  if (!res.ok) {
    console.warn(`[sync-catalog] /models fetch failed: ${res.status} ${res.statusText} — skipping.`);
    return;
  }
  const json = await res.json();
  const rows = Array.isArray(json?.models) ? json.models : [];
  if (!rows.length) {
    console.error('/models JSON has no model rows.');
    process.exit(1);
  }

  // Load existing bundled catalog (may be missing on first run).
  let bundled = { models: [] };
  try {
    bundled = JSON.parse(readFileSync(DEST, 'utf8'));
    if (!Array.isArray(bundled.models)) bundled.models = [];
  } catch {
    console.error('No existing media/catalog.json — creating fresh.');
  }
  const byKey = new Map(bundled.models.map((m) => [`${m.platform}||${m.modelId}`, m]));

  const out = [];
  const survivorKeys = new Set();
  let added = 0;
  let kept = 0;

  for (const row of rows) {
    const platform = String(row.provider_id ?? '').trim();
    const modelId = String(row.model_id ?? '').trim();
    if (!platform || !modelId) continue;
    if (wBool(row.enabled, true) === false) continue; // skip dev-staged / disabled

    const caps = row.capabilities && typeof row.capabilities === 'object' ? row.capabilities : {};
    const limits = row.limits && typeof row.limits === 'object' ? row.limits : {};
    const pricing = row.pricing && typeof row.pricing === 'object' ? row.pricing : {};
    const ctx = num(row.context_window);
    const supportsReasoning = wBool(caps.reasoning, undefined);

    const key = `${platform}||${modelId}`;
    survivorKeys.add(key);
    const prev = byKey.get(key);

    // tags (worker-authoritative)
    const tags = [];
    for (const t of (Array.isArray(row.tags) ? row.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean) : [])) {
      // `vision` is kept as a quality tag (dedicated VLM) distinct from the supportsVision
      // capability boolean — mirror src/catalog/catalog.ts. See src/router/capabilityProfile.ts.
      if (t === 'free') continue;
      const mapped = WORKER_TAG_MAP[t] ?? t;
      if (!tags.includes(mapped)) tags.push(mapped);
    }
    const dispName = String(row.display_name ?? '').toLowerCase();
    if (dispName.includes('router') && !tags.includes('router')) tags.push('router');
    if (wBool(pricing.free, false) && !tags.includes('free')) tags.push('free');

    if (prev) {
      // SURVIVOR: preserve curation, refresh worker-authoritative fields only.
      kept++;
      out.push({
        ...prev,
        contextWindow: ctx && ctx > 0 ? ctx : prev.contextWindow ?? null,
        rpmLimit: num(limits.rpm) ?? prev.rpmLimit ?? null,
        rpdLimit: num(limits.rpd) ?? prev.rpdLimit ?? null,
        supportsTools: wBool(caps.tools, prev.supportsTools ?? true),
        supportsVision: wBool(caps.vision, prev.supportsVision ?? false),
        supportsReasoning: caps.reasoning !== undefined ? wBool(caps.reasoning, false) : (prev.supportsReasoning ?? false),
        tags: tags.length ? tags : undefined,
        ...(num(pricing.input) != null ? { origInputPricePer1M: num(pricing.input) } : {}),
        ...(num(pricing.output) != null ? { origOutputPricePer1M: num(pricing.output) } : {}),
      });
    } else {
      // NEW: derive everything not provided by the worker.
      added++;
      const d = deriveMetadata(modelId, ctx && ctx > 0 ? ctx : null, supportsReasoning);
      out.push({
        platform,
        modelId,
        displayName: String(row.display_name ?? '').trim() || modelId,
        intelligenceRank: d.intelligenceRank,
        speedRank: d.speedRank,
        released: undefined,
        contextWindow: ctx && ctx > 0 ? ctx : null,
        rpmLimit: num(limits.rpm),
        rpdLimit: num(limits.rpd),
        monthlyTokenBudget: '',
        supportsTools: wBool(caps.tools, true),
        supportsVision: wBool(caps.vision, false),
        supportsReasoning: d.supportsReasoning,
        tags: tags.length ? tags : d.tags,
        ...(num(pricing.input) != null ? { origInputPricePer1M: num(pricing.input) } : {}),
        ...(num(pricing.output) != null ? { origOutputPricePer1M: num(pricing.output) } : {}),
      });
    }
  }

  // The worker is NOT the sole source of truth: some platforms (e.g. github) are curated
  // entirely in this bundled file and never appear in /models. Keep those models verbatim.
  // For platforms the worker actively manages, only drop disappeared models when --prune is
  // passed (default off, so a worker hiccup can't silently delete curated entries).
  const workerPlatforms = new Set(
    rows.map((r) => String(r?.provider_id ?? '').trim()).filter(Boolean),
  );
  const externallyCurated = bundled.models.filter(
    (m) => !workerPlatforms.has(m.platform),
  );
  const prunable = prune
    ? bundled.models.filter(
        (m) => workerPlatforms.has(m.platform) && !survivorKeys.has(`${m.platform}||${m.modelId}`),
      )
    : [];
  const finalModels = [...out, ...externallyCurated];

  const providers = new Set(finalModels.map((m) => m.platform));
  const output = {
    version: 2,
    note: `Synced from remote /models JSON — ${finalModels.length} models from ${providers.size} providers.`,
    models: finalModels,
  };
  writeFileSync(DEST, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${finalModels.length} models (${providers.size} providers) to ${DEST}`);
  console.log(`  kept (curated): ${kept} · added (derived): ${added} · externally-curated (kept): ${externallyCurated.length} · pruned: ${prunable.length}`);
  if (added) console.log(`  added: ${out.filter((m) => !byKey.has(`${m.platform}||${m.modelId}`)).map((m) => `${m.platform}/${m.modelId}`).join(', ')}`);
  if (prunable.length) console.log(`  pruned: ${prunable.map((m) => `${m.platform}/${m.modelId}`).join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
