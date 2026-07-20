

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CatalogModel, FallbackEntry, Platform } from '../shared/types';
import { toCatalogModel, type DiscoveredModel, type ProviderFetch } from './discovery';

const CACHE_KEY = 'tiermux.catalogCache';
/** Snapshot of the list as it was before the last provider sync (one level of undo). */
const UNDO_KEY = 'tiermux.catalogSyncUndo';

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
      return;
    }
    const cached = mem.get<CatalogModel[]>(CACHE_KEY);
    if (Array.isArray(cached) && cached.length) this.remote = cached;
  }

  /** Fetch the published CSV at `url`, parse it, and adopt it when it has models
   *  and differs from the current list. Best-effort: any failure (offline, bad
   *  URL, empty/garbled CSV) silently keeps the cached/bundled list. Fires
   *  onDidChange only when the active list actually changes. */
  async refresh(url: string | undefined, mem: vscode.Memento): Promise<void> {
    const target = (url ?? '').trim();
    if (!target) return;
    let text: string;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(target, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return;
      text = await res.text();
    } catch {
      return; // offline / timeout / bad URL → keep what we have
    }
    const models = parseCsvCatalog(text);
    if (!models.length) return; // empty or unparseable → ignore
    if (JSON.stringify(models) === JSON.stringify(this.remote)) return; // unchanged
    this.remote = models;
    await mem.update(CACHE_KEY, models);
    this._onDidChange.fire();
  }

  /**
   * Reconcile the catalog against what the keyless providers actually serve right now:
   * add models that appeared, drop models that vanished, refresh provider-reported facts
   * on the ones that remain.
   *
   * Deletion is real (rows go away) but only for a provider whose fetch came back HEALTHY —
   * a 401/timeout/garbled body/empty list yields `models: null` and that provider is skipped
   * entirely. Without that gate one bad response would wipe hand-curated ranks permanently.
   * The pre-sync list is snapshotted to `UNDO_KEY` so a bad sync is recoverable.
   *
   * Curated fields (intelligenceRank, speedRank, tags, rpm/rpdLimit, insight, …) are NEVER
   * overwritten on an existing row — only provider-reported facts are refreshed. Discovery
   * knows what exists; it does not know what's good.
   */
  async syncFromProviders(
    mem: vscode.Memento,
    fetchAll: () => Promise<ProviderFetch[]>,
  ): Promise<CatalogSyncReport> {
    const before = this.all();
    const results = await fetchAll();

    const healthy = results.filter((r) => r.models !== null);
    const skipped = results.filter((r) => r.models === null).map((r) => ({ platform: r.platform, error: r.error ?? 'unhealthy' }));
    if (!healthy.length) return { added: [], removed: [], updated: 0, skipped, changed: false };

    const syncedPlatforms = new Set(healthy.map((r) => r.platform));
    const live = new Map<string, DiscoveredModel>();
    for (const r of healthy) for (const d of r.models!) live.set(Catalog.key(d.platform, d.modelId), d);

    const next: CatalogModel[] = [];
    const removed: string[] = [];

    for (const m of before) {
      const k = Catalog.key(m.platform, m.modelId);
      // Untouched: this provider wasn't synced (keyed, or its fetch was unhealthy).
      if (!syncedPlatforms.has(m.platform)) { next.push(m); continue; }
      const d = live.get(k);
      if (!d) { removed.push(k); continue; }
      // Refresh only what the provider is authoritative about; keep curation intact.
      next.push({
        ...m,
        contextWindow: d.contextWindow ?? m.contextWindow,
        supportsTools: d.supportsTools ?? m.supportsTools,
        supportsVision: d.supportsVision ?? m.supportsVision,
        supportsReasoning: d.supportsReasoning ?? m.supportsReasoning,
        released: m.released ?? d.released,
      });
      live.delete(k);
    }

    // Whatever is left in `live` is genuinely new — rank it from the model name.
    const added: string[] = [];
    for (const [k, d] of live) { next.push(toCatalogModel(d)); added.push(k); }

    const updated = next.length - added.length;
    const changed = added.length > 0 || removed.length > 0 || JSON.stringify(next) !== JSON.stringify(before);
    if (changed) {
      await mem.update(UNDO_KEY, before);
      this.remote = next;
      await mem.update(CACHE_KEY, next);
      this._onDidChange.fire();
    }
    return { added, removed, updated, skipped, changed };
  }

  /** Restore the list captured before the last `syncFromProviders`. */
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
