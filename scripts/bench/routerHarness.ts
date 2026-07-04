/* Build a headless Router for benchmarking.
 *
 * Pattern lifted from scripts/circuitBreaker.e2e.ts: stub the 4 vscode-coupled
 * collaborators (SecretStore / SettingsStore / Catalog / UsageTracker) with
 * Partial<X>, then construct Router directly. The Router and providers have no
 * top-level `vscode` import, so esbuild --external:vscode bundles cleanly and
 * real global.fetch talks to real providers.
 *
 * Configuration (env or config object):
 *   - Catalog models loaded from media/catalog.json (real token/latency budgets).
 *   - Candidate list (enabledByPriority) built from catalog, optionally filtered
 *     to a platform subset (e.g. keyless smoke = kilo,pollinations,ovh).
 *   - API keys from env: BENCH_KEY_<PLATFORM_UPPER> (per-platform global key).
 *     Keyless providers (kilo/pollinations/ovh) need no key.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Router } from '../../src/router/router';
import type { SecretStore } from '../../src/config/secrets';
import type { SettingsStore } from '../../src/config/settingsStore';
import type { Catalog } from '../../src/catalog/catalog';
import type { UsageTracker } from '../../src/config/usage';
import type { CatalogModel, FallbackEntry, Platform } from '../../src/shared/types';

const KEYLESS_PLATFORMS = new Set(['kilo', 'pollinations', 'ovh']);

interface CatalogFile {
  models: CatalogModel[];
}

export interface HarnessDeps {
  /** Restrict candidates to these platforms (default: all catalog models). */
  platforms?: string[];
  /** Catalog file path (default: media/catalog.json). */
  catalogFile?: string;
}

/** Read the catalog and return models filtered to the requested platforms. */
function loadCatalogModels(catalogFile: string, platforms?: string[]): CatalogModel[] {
  const raw = JSON.parse(fs.readFileSync(catalogFile, 'utf8')) as CatalogFile;
  const all = raw.models ?? [];
  if (!platforms || platforms.length === 0) return all;
  const want = new Set(platforms);
  return all.filter((m) => want.has(m.platform));
}

/** Resolve an API key for a platform from env (BENCH_KEY_<PLATFORM_UPPER>). */
function resolveEnvKey(platform: string): string | undefined {
  return process.env[`BENCH_KEY_${platform.toUpperCase()}`];
}

/** Build the candidate list from catalog models, skipping any keyed platform
 *  that has no env key (so the run doesn't trip on providers we can't auth). */
function buildCandidates(models: CatalogModel[]): FallbackEntry[] {
  const entries: FallbackEntry[] = [];
  let priority = 0;
  // Stable order so reruns are comparable.
  const sorted = [...models].sort((a, b) =>
    a.platform === b.platform
      ? a.modelId.localeCompare(b.modelId)
      : a.platform.localeCompare(b.platform),
  );
  for (const m of sorted) {
    const keyless = KEYLESS_PLATFORMS.has(m.platform);
    const key = keyless ? undefined : resolveEnvKey(m.platform);
    // Skip keyed providers with no key configured — they'd just fail.
    if (!keyless && !key) continue;
    entries.push({
      platform: m.platform as Platform,
      modelId: m.modelId,
      enabled: true,
      priority: priority++,
      ...(key ? { key } : {}),
    });
  }
  return entries;
}

export interface BuiltHarness {
  router: Router;
  candidates: FallbackEntry[];
  modelsByCandidate: Map<string, CatalogModel>;
}

export function buildHarness(deps: HarnessDeps = {}): BuiltHarness {
  const catalogFile = deps.catalogFile ?? path.resolve(process.cwd(), 'media/catalog.json');
  const models = loadCatalogModels(catalogFile, deps.platforms);
  if (models.length === 0) {
    throw new Error(
      `No catalog models loaded from ${catalogFile}` +
        (deps.platforms ? ` for platforms [${deps.platforms.join(', ')}]` : '') +
        '. Check the catalog file or your --platforms filter.',
    );
  }
  const candidates = buildCandidates(models);
  if (candidates.length === 0) {
    throw new Error(
      'No candidates with an API key. Set BENCH_KEY_<PLATFORM> env vars, or use ' +
        '--platforms for keyless providers (kilo, pollinations, ovh).',
    );
  }

  // Index catalog models by "platform::modelId" for quick lookup.
  const modelsByCandidate = new Map<string, CatalogModel>();
  for (const m of models) modelsByCandidate.set(`${m.platform}::${m.modelId}`, m);

  // Catalog stub: only find() is exercised by Router.candidates().
  const catalog: Partial<Catalog> = {
    find: (platform: string, modelId: string) => modelsByCandidate.get(`${platform}::${modelId}`),
  };

  // Settings stub: return our candidate list (already prioritized).
  const settings: Partial<SettingsStore> = {
    enabledByPriority: () => candidates,
    getCustomEndpoints: () => [],
    getEndpoint: () => undefined,
  };

  // Secrets stub: resolve keys per request. Keyless providers get a sentinel.
  const secrets: Partial<SecretStore> = {
    cooldownRemaining: () => 0,
    getModelKey: async (_platform: string, _modelId: string) => undefined,
    resolveKey: async (platform: string, modelId: string) => {
      // Prefer a per-entry key from the candidate, then env, then keyless sentinel.
      const entry = candidates.find((c) => c.platform === platform && c.modelId === modelId);
      if (entry?.key) return entry.key;
      if (KEYLESS_PLATFORMS.has(platform)) return 'keyless';
      return resolveEnvKey(platform);
    },
    isToolIncompatible: () => false,
    isDeprecated: () => false,
    setStatus: () => {},
    setCooldownForKey: () => {},
    setCooldown: () => {},
    keyCooldownRemaining: () => 0,
    getKeys: async (platform: string) => {
      const k = resolveEnvKey(platform);
      return k ? [k] : [];
    },
    markToolIncompatible: () => {},
    markDeprecated: () => {},
  };

  const usage: Partial<UsageTracker> = { add: () => {} };

  const router = new Router(
    secrets as SecretStore,
    settings as SettingsStore,
    catalog as Catalog,
    usage as UsageTracker,
  );

  return { router, candidates, modelsByCandidate };
}
