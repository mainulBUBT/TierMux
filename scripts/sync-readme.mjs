#!/usr/bin/env node
/**
 * Regenerate the catalog-derived parts of README.md.
 *
 * The provider/model counts and the provider name lists come from the catalog the extension
 * actually ships, so they drift the moment a provider is added — README said "585 models
 * across 33 platforms" while the bundled catalog already carried 600. Anything here that a
 * human would have to remember to update is regenerated instead.
 *
 * Counts: media/catalog.json, because that file is what ships and what the picker reads —
 * it carries platforms the worker does not manage (UnoRouter's 165 models). Names and the
 * keyless flags: src/providers/index.ts first (what the UI shows), topped up from the
 * worker's /providers for platforms the registry only learns about at runtime.
 *
 *   node scripts/sync-readme.mjs          # rewrite README.md in place
 *   node scripts/sync-readme.mjs --check  # exit 1 if stale (CI gate)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Moved off the worker root on 2026-09-16: `/` serves the admin page now, so the old URL
// answered HTML and every run fell back to the bundled copy without anyone noticing.
const REMOTE_PROVIDERS = 'https://tiermux.mainulislam3057.workers.dev/providers';
const START = '<!-- catalog:start -->';
const END = '<!-- catalog:end -->';

function bundledCounts() {
  const body = JSON.parse(readFileSync(join(ROOT, 'media/catalog.json'), 'utf8'));
  const byPlatform = new Map();
  for (const m of body.models ?? []) byPlatform.set(m.platform, (byPlatform.get(m.platform) ?? 0) + 1);
  return { models: body.models?.length ?? 0, byPlatform };
}

/**
 * Which platforms need no API key, and what they are called.
 *
 * src/providers/index.ts carries the polished names the UI already shows ("OVH AI Endpoints",
 * "LLM7") and the keyless flag the extension routes on, so it leads. The worker fills in the
 * platforms the registry only learns about at runtime. Reading keyless from the registry is
 * what keeps an offline run honest: deriving it from the bundled catalog is impossible, and
 * assuming false emptied the "Keyless — zero setup" row outright.
 */
async function providerMeta() {
  const names = new Map();
  const keyless = new Set();
  const src = readFileSync(join(ROOT, 'src/providers/index.ts'), 'utf8');
  for (const line of src.split('\n')) {
    const platform = line.match(/platform:\s*'([a-z0-9]+)'/);
    if (!platform) continue;
    const name = line.match(/name:\s*['"]([^'"]+)['"]/);
    if (name && !names.has(platform[1])) names.set(platform[1], name[1]);
    if (/keyless:\s*true/.test(line)) keyless.add(platform[1]);
  }
  let source = 'src/providers/index.ts';
  try {
    const res = await fetch(REMOTE_PROVIDERS, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    for (const p of (await res.json()).providers ?? []) {
      if (p.display_name && !names.has(p.provider_id)) names.set(p.provider_id, p.display_name);
      if (p.keyless) keyless.add(p.provider_id);
    }
    source += ' + the worker provider list';
  } catch (e) {
    console.warn(`! worker provider list unavailable (${e.message}) — registry names/keyless only`);
  }
  return { names, keyless, source };
}

const join_ = (names) => names.sort((a, b) => a.localeCompare(b, 'en')).join(' · ');

function render({ models, byPlatform }, { names, keyless }) {
  const ids = [...byPlatform.keys()].filter((id) => byPlatform.get(id) > 0);
  const label = (id) => names.get(id) ?? id;
  const free = ids.filter((id) => keyless.has(id)).map(label);
  const keyed = ids.filter((id) => !keyless.has(id)).map(label);
  return `${START}
**${models} models** across **${ids.length} providers**, and the catalog updates itself —
new free models and whole new providers appear without an extension update.

| | |
|---|---|
| **Keyless — zero setup** | ${join_(free)} |
| **With a free API key** | ${join_(keyed)} |
| **Your own** | any OpenAI-compatible URL — vLLM, LiteLLM, LM Studio, Ollama, llama.cpp, Azure OpenAI |
${END}`;
}

const counts = bundledCounts();
const meta = await providerMeta();
const providerCount = [...counts.byPlatform.keys()].length;
const unnamed = [...counts.byPlatform.keys()].filter((id) => !meta.names.has(id));
if (unnamed.length) console.warn(`! no display name for ${unnamed.join(', ')} — README prints the raw id until it is added to src/providers/index.ts`);

const path = join(ROOT, 'README.md');
const before = readFileSync(path, 'utf8');
const i = before.indexOf(START);
const j = before.indexOf(END);
if (i === -1 || j === -1) {
  console.error(`README.md is missing the ${START} / ${END} markers.`);
  process.exit(2);
}
const after = before.slice(0, i) + render(counts, meta) + before.slice(j + END.length);

if (process.argv.includes('--check')) {
  if (after !== before) {
    console.error('README.md catalog block is stale — run: npm run sync:readme');
    process.exit(1);
  }
  console.log(`README.md is current (${counts.models} models / ${providerCount} providers)`);
} else if (after !== before) {
  writeFileSync(path, after);
  console.log(`README.md updated from media/catalog.json + ${meta.source}: ${counts.models} models / ${providerCount} providers`);
} else {
  console.log(`README.md already current (${counts.models} models / ${providerCount} providers)`);
}
