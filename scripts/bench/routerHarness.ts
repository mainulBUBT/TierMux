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
 *     to a platform subset (e.g. keyless smoke = kilo,pollinations,ovh,opencode).
 *   - Provider registry = static COMPAT + the remote /providers catalog, merged by
 *     syncRemoteProviders() so the bench sees what the extension sees.
 *   - API keys from env: BENCH_KEY_<PLATFORM_UPPER> (per-platform global key).
 *     Keyless platforms are read from the registry, never hardcoded.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Router } from '../../src/router/router';
import { allPlatformInfo, upsertCompatFromCatalog, type RemoteProviderDef } from '../../src/providers/index';
import type { SecretStore } from '../../src/config/secrets';
import type { SettingsStore } from '../../src/config/settingsStore';
import type { Catalog } from '../../src/catalog/catalog';
import type { UsageTracker } from '../../src/config/usage';
import type { CatalogModel, FallbackEntry, Platform } from '../../src/shared/types';

/** Derived from the provider registry rather than hardcoded: this used to be a literal
 *  {kilo, pollinations, ovh}, which silently went stale when OpenCode Zen was added as a
 *  keyless platform — the harness kept skipping it as "keyed but no key", so a whole free
 *  provider was invisible to every benchmark run.
 *
 *  Read at call time, never cached: syncRemoteProviders() can register new keyless platforms
 *  after this module loads, and a snapshot taken at import would miss exactly those. */
function isKeyless(platform: string): boolean {
  return allPlatformInfo().some((p) => p.platform === platform && p.keyless);
}

interface CatalogFile {
  models: CatalogModel[];
}

export interface HarnessDeps {
  /** Restrict candidates to these platforms (default: all catalog models). */
  platforms?: string[];
  /** Catalog file path (default: media/catalog.json). */
  catalogFile?: string;
}

/** Default remote catalog, read from the same place the extension reads it. */
function defaultCatalogUrl(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
    return pkg?.contributes?.configuration?.properties?.['tiermux.catalog.url']?.default ?? '';
  } catch {
    return '';
  }
}

/**
 * Merge the remote `/providers` catalog into the provider registry, exactly as the extension
 * does on activate (Catalog.refresh → upsertCompatFromCatalog).
 *
 * Without this the harness only ever saw the hardcoded COMPAT array, so any platform that
 * exists ONLY in the remote catalog — nararouter (router.bynara.id) is the live example —
 * resolved to "no provider available" and was unbenchmarkable, even though it works fine in
 * the running extension. The bench must see the same provider set the product does, or it
 * measures a different program than the one users run.
 *
 * Best-effort: offline, timeout, or a wrong-shaped body leaves the static registry untouched.
 */
export async function syncRemoteProviders(url = defaultCatalogUrl(), timeoutMs = 8000): Promise<number> {
  if (!url) return 0;
  const endpoint = `${url.replace(/\/+$/, '')}/providers`;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(endpoint, { signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) return 0;
    const body = (await res.json()) as { providers?: unknown };
    if (!Array.isArray(body?.providers)) return 0;
    const defs: RemoteProviderDef[] = [];
    for (const p of body.providers) {
      const o = p as Record<string, unknown>;
      const platform = String(o?.provider_id ?? '').trim();
      const baseUrl = typeof o?.base_url === 'string' ? o.base_url.trim() : '';
      if (!platform || !baseUrl) continue;
      defs.push({
        platform,
        baseUrl,
        ...(typeof o.display_name === 'string' && o.display_name.trim() ? { name: o.display_name.trim() } : {}),
        ...(o.keyless !== undefined ? { keyless: o.keyless === true || o.keyless === 'true' || o.keyless === 1 } : {}),
      });
    }
    return defs.length ? upsertCompatFromCatalog(defs) : 0;
  } catch {
    return 0;
  }
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
    const keyless = isKeyless(m.platform);
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
    const needed = [...new Set(models.map((m) => m.platform))].filter((p) => !isKeyless(p));
    const keyless = allPlatformInfo().filter((p) => p.keyless).map((p) => p.platform).join(', ');
    throw new Error(
      'No candidates with an API key.' +
        (needed.length ? ` Set ${needed.map((p) => `BENCH_KEY_${p.toUpperCase()}`).join(' / ')}.` : '') +
        ` Keyless platforms need no key: ${keyless || '(none registered)'}.`,
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
      if (isKeyless(platform)) return 'keyless';
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
