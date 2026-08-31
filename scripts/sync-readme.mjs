#!/usr/bin/env node
/**
 * Regenerate the catalog-derived parts of README.md.
 *
 * The provider/model counts and the provider name lists come from the SAME remote catalog
 * the extension routes on, so they drift the moment a provider is added upstream — README
 * said "585 models across 33 platforms" while the live catalog already served 600. Anything
 * here that a human would have to remember to update is regenerated instead.
 *
 * Source of truth: the remote catalog (tiermux.catalog.url's default). Falls back to the
 * bundled media/catalog.json when offline so CI and local runs never fail on a network blip.
 *
 *   node scripts/sync-readme.mjs          # rewrite README.md in place
 *   node scripts/sync-readme.mjs --check  # exit 1 if stale (CI gate)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REMOTE = 'https://tiermux.mainulislam3057.workers.dev/';
const START = '<!-- catalog:start -->';
const END = '<!-- catalog:end -->';

/** Remote shape: { providers: [{ provider_id, display_name, keyless, enabled, models[] }] }. */
async function fromRemote() {
  const res = await fetch(REMOTE, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
  const body = await res.json();
  const providers = (body.providers ?? []).filter((p) => p.enabled !== false);
  return {
    source: 'remote catalog',
    models: providers.reduce((n, p) => n + (p.models?.length ?? 0), 0),
    providers: providers.map((p) => ({
      id: p.provider_id,
      name: p.display_name || p.provider_id,
      keyless: !!p.keyless,
      models: p.models?.length ?? 0,
    })),
  };
}

/** Bundled shape: { models: [{ platform, ... }] } — no keyless flag, no display names. */
function fromBundled() {
  const body = JSON.parse(readFileSync(join(ROOT, 'media/catalog.json'), 'utf8'));
  const byPlatform = new Map();
  for (const m of body.models ?? []) byPlatform.set(m.platform, (byPlatform.get(m.platform) ?? 0) + 1);
  return {
    source: 'bundled media/catalog.json',
    models: body.models?.length ?? 0,
    providers: [...byPlatform].map(([id, models]) => ({ id, name: id, keyless: false, models })),
  };
}

/**
 * Display names, read from the extension's own provider registry.
 *
 * The remote catalog's `display_name` is inconsistent ("Ovh", "Llm7", "Openrouter"), while
 * src/providers/index.ts carries the polished names the UI already shows ("OVH AI Endpoints",
 * "LLM7", "OpenRouter"). Parsing them keeps one source of truth instead of a hand-kept
 * override list here — which is exactly the maintenance burden this script exists to remove.
 */
function displayNames() {
  const src = readFileSync(join(ROOT, 'src/providers/index.ts'), 'utf8');
  const map = new Map();
  for (const m of src.matchAll(/platform:\s*'([a-z0-9]+)',\s*name:\s*['"]([^'"]+)['"]/g)) {
    if (!map.has(m[1])) map.set(m[1], m[2]);
  }
  return map;
}

const join_ = (names) => names.sort((a, b) => a.localeCompare(b, 'en')).join(' · ');

function render({ models, providers }) {
  const names = displayNames();
  const label = (p) => names.get(p.id) ?? p.name;
  const keyless = providers.filter((p) => p.keyless && p.models > 0).map(label);
  const keyed = providers.filter((p) => !p.keyless && p.models > 0).map(label);
  return `${START}
**${models} models** across **${providers.length} providers**, and the catalog updates itself —
new free models and whole new providers appear without an extension update.

| | |
|---|---|
| **Keyless — zero setup** | ${join_(keyless)} |
| **With a free API key** | ${join_(keyed)} |
| **Your own** | any OpenAI-compatible URL — vLLM, LiteLLM, LM Studio, Ollama, llama.cpp, Azure OpenAI |
${END}`;
}

let data;
try {
  data = await fromRemote();
} catch (e) {
  console.warn(`! remote catalog unavailable (${e.message}) — falling back to the bundled copy`);
  data = fromBundled();
}

const path = join(ROOT, 'README.md');
const before = readFileSync(path, 'utf8');
const i = before.indexOf(START);
const j = before.indexOf(END);
if (i === -1 || j === -1) {
  console.error(`README.md is missing the ${START} / ${END} markers.`);
  process.exit(2);
}
const after = before.slice(0, i) + render(data) + before.slice(j + END.length);

if (process.argv.includes('--check')) {
  if (after !== before) {
    console.error('README.md catalog block is stale — run: npm run sync:readme');
    process.exit(1);
  }
  console.log(`README.md is current (${data.models} models / ${data.providers.length} providers)`);
} else {
  if (after !== before) {
    writeFileSync(path, after);
    console.log(`README.md updated from the ${data.source}: ${data.models} models / ${data.providers.length} providers`);
  } else {
    console.log(`README.md already current (${data.models} models / ${data.providers.length} providers)`);
  }
}
