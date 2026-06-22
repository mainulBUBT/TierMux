// Loads the bundled model catalog (offline) and derives a default fallback chain.
// Optionally overlays a *remote* catalog fetched from a published CSV URL (e.g.
// Google Sheets → Publish to web → CSV), cached in globalState so it survives
// offline. Resolution order: remote (fetched/cached) → bundled.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CatalogModel, FallbackEntry, Platform } from '../shared/types';

const CACHE_KEY = 'tiermux.catalogCache';

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
   *  works offline — call once on startup before the list is first read. */
  loadCached(mem: vscode.Memento): void {
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

  /** Active model list: remote (fetched/cached) if present, else bundled. */
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
    return sorted.map((m, i) => ({ platform: m.platform, modelId: m.modelId, enabled: false, priority: i }));
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

// ---- CSV parsing (published Google Sheet) -------------------------------------

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
      tags: tagsRaw ? tagsRaw.split(/[·|,]/).map((t) => t.trim()).filter(Boolean) : undefined,
      insight: (get('insight') ?? '').trim() || undefined,
    });
  }
  return out;
}
