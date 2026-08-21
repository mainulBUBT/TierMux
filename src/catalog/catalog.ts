

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CatalogModel, FallbackEntry, Platform } from '../shared/types';
import { deriveMetadata } from './discovery';
import { allPlatformInfo, upsertCompatFromCatalog, type RemoteProviderDef } from '../providers';

const CACHE_KEY = 'tiermux.catalogCache';
/** Provider defs (`/providers`) applied by the last successful refresh, restored on startup so
 *  offline/first-run loads still register remote providers (names + base URLs) alongside the
 *  cached model list — without it, restored models show raw platform ids until a fetch lands. */
export const PROVIDER_DEFS_KEY = 'tiermux.catalogProviderDefs';
/** Snapshot of the list as it was before the last provider sync (one level of undo). */
const UNDO_KEY = 'tiermux.catalogSyncUndo';
/** Platforms the shared worker catalog currently reports `enabled: false` for. */
const REMOTE_DISABLED_KEY = 'tiermux.catalogRemoteDisabled';

export interface CatalogSyncReport {
  /** `platform::modelId` keys newly discovered and added. */
  added: string[];
  /** `platform::modelId` keys deleted because their provider no longer serves them. */
  removed: string[];
  /** Rows carried over (refreshed or untouched). */
  updated: number;
  /** Providers skipped because their fetch was unhealthy — nothing was deleted for these. */
  skipped: Array<{ platform: Platform; error: string }>;
  changed: boolean;
}

export class Catalog {
  private bundled: CatalogModel[] = [];
  private remote: CatalogModel[] | undefined;
  private remoteDisabledPlatforms: Platform[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires after a remote fetch that actually changed the active model list. */
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly extensionPath: string) {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(path.join(this.extensionPath, 'media', 'catalog.json'), 'utf8');
      const parsed = JSON.parse(raw) as { models?: CatalogModel[] };
      this.bundled = Array.isArray(parsed.models) ? parsed.models : [];
    } catch (e) {
      console.error('[tiermux] failed to load catalog.json', e);
      this.bundled = [];
    }
  }

  /** Load the last successfully-fetched remote catalog from globalState. Instant,
   *  works offline — call once on startup before the list is first read.
   *  `catalogUrl` is the currently configured `tiermux.catalog.url`: when the user
   *  has blanked it out, any stale cache from a previous non-blank URL is dropped
   *  instead of silently continuing to shadow the bundled catalog. */
  loadCached(mem: vscode.Memento, catalogUrl: string): void {
    if (!catalogUrl.trim()) {
      this.remote = undefined;
      void mem.update(CACHE_KEY, undefined);
      void mem.update(PROVIDER_DEFS_KEY, undefined);
      return;
    }
    const cached = mem.get<CatalogModel[]>(CACHE_KEY);
    if (Array.isArray(cached) && cached.length) this.remote = cached;
    // Restore the provider registry snapshot too — model rows alone would reference platforms
    // with no name/baseUrl until the next live fetch succeeds.
    const defs = mem.get<RemoteProviderDef[]>(PROVIDER_DEFS_KEY);
    if (Array.isArray(defs) && defs.length) upsertCompatFromCatalog(defs);
    const disabled = mem.get<Platform[]>(REMOTE_DISABLED_KEY);
    if (Array.isArray(disabled)) this.remoteDisabledPlatforms = disabled;
  }

  /** Fetch the worker at `base`: `/models` is the catalog (providers→models), `/providers`
   *  carries endpoint metadata (base URLs/keyless/keyUrl) merged into the registry. Both are
   *  fetched together on each refresh. `/models` may also be a legacy published-sheet CSV.
   *  Best-effort: any failure (offline, bad URL, empty/garbled body) silently keeps the
   *  cached/bundled list. `/providers` failure degrades gracefully to a models-only refresh.
   *  Fires onDidChange only when the active list actually changes. */
  async refresh(baseRaw: string | undefined, mem: vscode.Memento): Promise<CatalogSyncReport | null> {
    const base = (baseRaw ?? '').trim();
    if (!base) return null;
    const modelsUrl = joinBase(base, 'models');
    const providersUrl = joinBase(base, 'providers');

    // Fetch both endpoints in parallel; each gets its own 8s timeout and fails over alone.
    const [modelsText, providersText] = await Promise.all([
      fetchText(modelsUrl),
      fetchText(providersUrl),
    ]);
    if (modelsText === null) return null; // offline / timeout / bad URL → keep what we have

    // Register/update providers BEFORE reading the registry below, so any new platform the
    // `/models` payload references is already resolvable. A missing/empty `/providers`
    // response is fine — the hardcoded registry stays as-is. `providersApplied` counts how
    // many entries were added/refreshed: even when the model list is unchanged, a registry
    // change (e.g. a brand-new platform appeared) must re-notify the webview so the new
    // provider shows up in settings.
    let providersApplied = 0;
    if (providersText) {
      const defs = parseWorkerProviders(providersText);
      if (defs.length) {
        providersApplied = upsertCompatFromCatalog(defs);
        void mem.update(PROVIDER_DEFS_KEY, defs);
      }
    }

    // The /models endpoint may serve the TierMux worker JSON (nested providers→models) or a
    // legacy published-sheet CSV. Try the worker shape first; if it isn't JSON in that
    // shape, fall back to CSV. Either way an empty/unparseable result is ignored.
    const worker = parseWorkerCatalog(modelsText);
    const models = worker?.models ?? parseCsvCatalog(modelsText);
    if (!models.length) return null; // empty or unparseable → ignore

    if (worker && JSON.stringify(worker.disabledPlatforms) !== JSON.stringify(this.remoteDisabledPlatforms)) {
      this.remoteDisabledPlatforms = worker.disabledPlatforms;
      await mem.update(REMOTE_DISABLED_KEY, worker.disabledPlatforms);
    }

    const before = this.all();
    const modelsChanged = JSON.stringify(models) !== JSON.stringify(before);

    // Nothing changed at all (same models, no provider registry delta) → no work, no notify.
    if (!modelsChanged && providersApplied === 0) {
      return { added: [], removed: [], updated: before.length, skipped: [], changed: false };
    }

    let added: string[] = [];
    let removed: string[] = [];
    let updated = before.length;
    if (modelsChanged) {
      const beforeKeys = new Set(before.map((m) => Catalog.key(m.platform, m.modelId)));
      const nextKeys = new Set(models.map((m) => Catalog.key(m.platform, m.modelId)));
      added = models.filter((m) => !beforeKeys.has(Catalog.key(m.platform, m.modelId))).map((m) => Catalog.key(m.platform, m.modelId));
      removed = before.filter((m) => !nextKeys.has(Catalog.key(m.platform, m.modelId))).map((m) => Catalog.key(m.platform, m.modelId));
      updated = models.length - added.length;

      await mem.update(UNDO_KEY, before);
      this.remote = models;
      await mem.update(CACHE_KEY, models);
    }
    // Fire when the model list changed OR the provider registry changed — the webview builds
    // its provider/settings list from the registry snapshot, so a new platform won't appear
    // until sendConfig re-runs.
    this._onDidChange.fire();

    return { added, removed, updated, skipped: [], changed: modelsChanged || providersApplied > 0 };
  }

  /** Restore the list captured before the last wholesale `refresh`. */
  async undoSync(mem: vscode.Memento): Promise<boolean> {
    const prev = mem.get<CatalogModel[]>(UNDO_KEY);
    if (!Array.isArray(prev) || !prev.length) return false;
    this.remote = prev;
    await mem.update(CACHE_KEY, prev);
    await mem.update(UNDO_KEY, undefined);
    this._onDidChange.fire();
    return true;
  }

  /** Active model list: the published sheet is the sole source of truth once a
   *  remote fetch has succeeded — bundled is offline/first-run fallback only. */
  all(): CatalogModel[] {
    return this.remote && this.remote.length ? this.remote : this.bundled;
  }

  find(platform: string, modelId: string): CatalogModel | undefined {
    return this.all().find((m) => m.platform === platform && m.modelId === modelId);
  }

  /** Platforms the shared worker catalog most recently reported `enabled: false` for.
   *  These already have zero models in `all()` — this is only for surfacing *why*
   *  in the provider toggle UI, since a locally-enabled provider with no catalog
   *  models otherwise looks broken rather than remotely disabled. */
  getRemoteDisabledPlatforms(): Platform[] {
    return this.remoteDisabledPlatforms;
  }

  /** Key used to identify a model across catalog + fallback entries. */
  static key(platform: string, modelId: string): string {
    return `${platform}::${modelId}`;
  }

  /**
   * Default fallback chain: every catalog model disabled by default, ordered by
   * intelligence then speed (smartest/fastest first) so the priority order is
   * ready once the user opts models in.
   */
  defaultFallback(): FallbackEntry[] {
    const sorted = [...this.all()].sort((a, b) =>
      a.intelligenceRank - b.intelligenceRank ||
      a.speedRank - b.speedRank ||
      (b.released ?? '').localeCompare(a.released ?? ''), // newer first among equals
    );
    // Enabled by default: TierMux is meant to work with zero setup, and a fresh install
    // where every model is off routes nothing at all. The real gate is provider-level
    // (getDisabledProviders leaves only DEFAULT_ENABLED_PLATFORM on), so this enables one
    // keyless gateway's models, not all 22 providers'. Staged rows (ready === false) stay off.
    return sorted.map((m, i) => ({
      platform: m.platform,
      modelId: m.modelId,
      enabled: m.ready !== false,
      priority: i,
    }));
  }

  /** Pick a fast model for inline completions among the given enabled entries. */
  fastestEnabled(entries: FallbackEntry[]): FallbackEntry | undefined {
    const enabled = entries.filter((e) => e.enabled);
    const withSpeed = enabled
      .map((e) => ({ e, m: this.find(e.platform, e.modelId) }))
      .filter((x): x is { e: FallbackEntry; m: CatalogModel } => !!x.m);
    withSpeed.sort((a, b) => a.m.speedRank - b.m.speedRank || a.e.priority - b.e.priority);
    return withSpeed[0]?.e;
  }
}

/**
 * Worker tag vocabulary → internal tag vocabulary. The router/scorer read a small set of
 * canonical tags (`coding`, `planner`, `reasoner`, `general`, `router`, `vision`); the worker
 * uses `coder`/`planner`/etc. Map them so the catalog actually feeds routing. `vision` is a
 * first-class quality tag (dedicated VLM) kept DISTINCT from the `supportsVision` capability
 * boolean — the boolean gates "can it see at all", the tag signals "is it best at seeing".
 * Aggregator endpoints whose display name says "Router" get tagged `router` so vision turns
 * can demote them (they claim vision but delegate to arbitrary backends).
 */
const WORKER_TAG_MAP: Record<string, string> = {
  coder: 'coding', coding: 'coding',
  planner: 'planner', plan: 'planner',
  reasoner: 'reasoner', reasoning: 'reasoner',
  general: 'general', router: 'router',
};

/** Coerce a worker-JSON cell to a finite number, or null when absent/garbled. */
function wNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}
/** Coerce a worker-JSON cell to a boolean with a default for missing values. */
function wBool(v: unknown, def: boolean): boolean {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return def;
}

/** Join a worker base URL with a sub-path, normalizing slashes:
 *  `https://x.dev/` + `models` → `https://x.dev/models`; `https://x.dev` + `models` → same.
 *  A base that already ends with the sub-path (e.g. someone pointed catalog.url at
 *  `…/models` directly) is left as-is rather than doubled. */
export function joinBase(base: string, sub: string): string {
  const b = base.replace(/\/+$/, '');
  if (b.toLowerCase().endsWith('/' + sub.toLowerCase())) return b;
  return `${b}/${sub}`;
}

/** GET `url` as text with an 8s abort timeout. Returns null on any failure
 *  (offline, non-OK, timeout) so callers can fail over per-endpoint. */
export async function fetchText(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Parse the TierMux worker catalog JSON into CatalogModels. The worker schema carries no
 * rank columns, so intelligence/speed are derived from the model id via deriveMetadata
 * (benchmark table → param proxy); capabilities, limits, pricing, and tags come straight
 * from the catalog. Provider/model `enabled` is honored — disabled rows are dropped.
 *
 * Two payload shapes are accepted:
 *  - nested:  { providers: [{ provider_id, enabled, models: [...] }] }
 *  - flat:    { models: [{ model_id, provider_id, enabled, ... }] }   (provider_id inline)
 *
 * Returns null when the body is neither shape so the caller can fall back to CSV.
 */
function parseWorkerCatalog(text: string): { models: CatalogModel[]; disabledPlatforms: Platform[] } | null {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return null; }
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;

  const out: CatalogModel[] = [];
  const disabledPlatforms: Platform[] = [];
  const presentPlatforms = new Set<string>();

  const providers = obj.providers;
  if (Array.isArray(providers)) {
    // Nested shape: provider → models[].
    for (const p of providers) {
      if (!p || typeof p !== 'object') continue;
      const pobj = p as Record<string, unknown>;
      const platform = String(pobj.provider_id ?? '').trim();
      if (!platform) continue;
      presentPlatforms.add(platform);
      if (!wBool(pobj.enabled, true)) {
        disabledPlatforms.push(platform as Platform);
        continue;
      }
      const models = pobj.models;
      if (!Array.isArray(models)) continue;
      for (const m of models) {
        const cm = modelRowToCatalog(platform, m);
        if (cm) out.push(cm);
      }
    }
  } else if (Array.isArray(obj.models)) {
    // Flat shape: every row carries its own provider_id.
    for (const m of obj.models) {
      if (!m || typeof m !== 'object') continue;
      const row = m as Record<string, unknown>;
      const platform = String(row.provider_id ?? '').trim();
      if (!platform) continue;
      presentPlatforms.add(platform);
      if (!wBool(row.enabled, true)) continue;
      const cm = modelRowToCatalog(platform, m);
      if (cm) out.push(cm);
    }
  } else {
    return null;
  }

  // Providers registered locally (they have a baseUrl/auth implementation) but absent
  // from the worker response entirely aren't reachable through the shared catalog either
  // — treat them the same as an explicit enabled:false rather than leaving them looking
  // like an untouched, fully-live toggle.
  for (const info of allPlatformInfo()) {
    if (!presentPlatforms.has(info.platform) && !disabledPlatforms.includes(info.platform)) {
      disabledPlatforms.push(info.platform);
    }
  }
  return { models: out, disabledPlatforms };
}

/** Build one CatalogModel from a worker model row, deriving ranks from the id. The worker
 *  has no rank columns, so capabilities are authoritative while intelligence/speed come from
 *  deriveMetadata. Returns null for rows without a usable model_id (or disabled, when the
 *  caller hasn't pre-filtered). */
function modelRowToCatalog(platform: string, raw: unknown): CatalogModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (!wBool(row.enabled, true)) return null;
  const modelId = String(row.model_id ?? '').trim();
  if (!modelId) return null;

  const caps = row.capabilities && typeof row.capabilities === 'object' ? row.capabilities as Record<string, unknown> : {};
  const limits = row.limits && typeof row.limits === 'object' ? row.limits as Record<string, unknown> : {};
  const pricing = row.pricing && typeof row.pricing === 'object' ? row.pricing as Record<string, unknown> : {};
  const ctx = wNum(row.context_window);

  const derived = deriveMetadata({
    platform: platform as Platform,
    modelId,
    contextWindow: ctx,
    supportsTools: undefined,
    supportsVision: undefined,
    supportsReasoning: undefined,
  });

  const rawTags = Array.isArray(row.tags)
    ? row.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
    : [];
  const tags: string[] = [];
  for (const t of rawTags) {
    // `free` is dropped here and re-derived from pricing below. `vision` is KEPT as a quality
    // tag (dedicated VLM) distinct from the `supportsVision` capability boolean (can see at all):
    // the boolean is the hard routing gate, the tag is a strong preference signal among capable
    // models. See src/router/capabilityProfile.ts.
    if (t === 'free') continue;
    const mapped = WORKER_TAG_MAP[t] ?? t;
    if (!tags.includes(mapped)) tags.push(mapped);
  }
  const dispName = String(row.display_name ?? '').toLowerCase();
  if (dispName.includes('router') && !tags.includes('router')) tags.push('router');
  if (wBool(pricing.free, false) && !tags.includes('free')) tags.push('free');

  return {
    platform: platform as Platform,
    modelId,
    displayName: String(row.display_name ?? '').trim() || modelId,
    intelligenceRank: derived.intelligenceRank,
    speedRank: derived.speedRank,
    sizeLabel: derived.sizeLabel,
    released: undefined,
      contextWindow: ctx,
      outputTokenLimit: wNum(limits.output),
      rpmLimit: wNum(limits.rpm),
    rpdLimit: wNum(limits.rpd),
    monthlyTokenBudget: '',
    supportsTools: wBool(caps.tools, true),
    supportsVision: wBool(caps.vision, false),
    supportsReasoning: wBool(caps.reasoning, false),
    ready: true,
    tags: tags.length ? tags : undefined,
    insight: undefined,
    origInputPricePer1M: wNum(pricing.input) ?? undefined,
    origOutputPricePer1M: wNum(pricing.output) ?? undefined,
  };
}

/** Parse the `/providers` endpoint: `{ providers: [{ provider_id, base_url, display_name,
 *  key_url?, keyless?, enabled? }] }`. Returns one RemoteProviderDef per entry that has a
 *  usable base_url — these are merged into the registry so new/moved provider endpoints
 *  propagate without an extension update. Tolerant: a non-JSON/wrong-shape body yields []. */
function parseWorkerProviders(text: string): RemoteProviderDef[] {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return []; }
  if (!body || typeof body !== 'object') return [];
  const providers = (body as Record<string, unknown>).providers;
  if (!Array.isArray(providers)) return [];
  const out: RemoteProviderDef[] = [];
  for (const p of providers) {
    if (!p || typeof p !== 'object') continue;
    const pobj = p as Record<string, unknown>;
    const platform = String(pobj.provider_id ?? '').trim();
    const baseUrl = typeof pobj.base_url === 'string' ? pobj.base_url.trim() : '';
    if (!platform || !baseUrl) continue;
    out.push({
      platform,
      baseUrl,
      ...(typeof pobj.display_name === 'string' && pobj.display_name.trim() ? { name: pobj.display_name.trim() } : {}),
      ...(typeof pobj.key_url === 'string' && pobj.key_url.trim() ? { keyUrl: pobj.key_url.trim() } : {}),
      ...(pobj.keyless !== undefined ? { keyless: wBool(pobj.keyless, false) } : {}),
    });
  }
  return out;
}

/** Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped quotes ("")
 *  and both \n and \r\n line endings. Returns rows of string cells. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
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

/** Turn a published-sheet CSV into CatalogModels. Maps columns by header name
 *  (order-independent, tolerant of extra columns). Rows missing platform/modelId
 *  are skipped; unknown/blank cells fall back to sensible defaults. */
function parseCsvCatalog(text: string): CatalogModel[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  const col = (name: string): number => header.indexOf(name);
  const iPlatform = col('platform');
  const iModel = col('modelId');
  if (iPlatform < 0 || iModel < 0) return [];

  const num = (s: string | undefined): number | null => {
    if (s === undefined || s.trim() === '') return null;
    const n = Number(s.trim());
    return Number.isFinite(n) ? n : null;
  };
  const bool = (s: string | undefined, def: boolean): boolean => {
    if (s === undefined || s.trim() === '') return def;
    return /^(true|1|yes)$/i.test(s.trim());
  };

  const out: CatalogModel[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = (name: string): string | undefined => { const i = col(name); return i >= 0 ? row[i] : undefined; };
    const platform = (row[iPlatform] ?? '').trim();
    const modelId = (row[iModel] ?? '').trim();
    if (!platform || !modelId) continue;
    const tagsRaw = (get('tags') ?? '').trim();
    out.push({
      platform: platform as Platform,
      modelId,
      displayName: (get('displayName') ?? '').trim() || modelId,
      intelligenceRank: num(get('intelligenceRank')) ?? 5,
      speedRank: num(get('speedRank')) ?? 3,
      released: (get('released') ?? '').trim() || undefined,
      sizeLabel: (get('sizeLabel') ?? '').trim(),
      contextWindow: num(get('contextWindow')),
      outputTokenLimit: num(get('outputTokenLimit')),
      rpmLimit: num(get('rpmLimit')),
      rpdLimit: num(get('rpdLimit')),
      monthlyTokenBudget: (get('monthlyTokenBudget') ?? '').trim(),
      supportsTools: bool(get('supportsTools'), true),
      supportsVision: bool(get('supportsVision'), false),
      supportsReasoning: bool(get('supportsReasoning'), false),
      ready: bool(get('ready'), true),
      tags: tagsRaw ? tagsRaw.split(/[·|,]/).map((t) => t.trim()).filter(Boolean) : undefined,
      insight: (get('insight') ?? '').trim() || undefined,
      origInputPricePer1M: num(get('origInputPricePer1M_USD')) ?? undefined,
      origOutputPricePer1M: num(get('origOutputPricePer1M_USD')) ?? undefined,
    });
  }
  return out;
}
