// Persists the fallback chain (enabled + priority) and per-platform endpoint
// overrides in globalState. The model-management UI is the source of truth.
import * as vscode from 'vscode';
import type { FallbackEntry, Platform } from '../shared/types';
import type { Catalog } from '../catalog/catalog';

const FALLBACK_KEY = 'tiermux.fallback';
const ENDPOINTS_KEY = 'tiermux.endpoints';
const DISABLED_PROVIDERS_KEY = 'tiermux.disabledProviders';

export class SettingsStore {
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onChange.event;

  constructor(private readonly state: vscode.Memento, private readonly catalog: Catalog) {}

  /** Returns the persisted fallback chain, seeding defaults on first run and
   *  reconciling against the catalog (drop missing, append new). */
  getFallback(): FallbackEntry[] {
    const stored = this.state.get<FallbackEntry[]>(FALLBACK_KEY);
    if (!stored || stored.length === 0) {
      const def = this.catalog.defaultFallback();
      void this.state.update(FALLBACK_KEY, def);
      return def;
    }
    return this.reconcile(stored);
  }

  private reconcile(stored: FallbackEntry[]): FallbackEntry[] {
    const catalogModels = this.catalog.all();
    const inCatalog = new Set(catalogModels.map((m) => `${m.platform}::${m.modelId}`));
    // Keep stored entries that still exist; preserve user order/flags.
    const kept = stored.filter((e) => inCatalog.has(`${e.platform}::${e.modelId}`));
    const known = new Set(kept.map((e) => `${e.platform}::${e.modelId}`));
    // Append catalog models not yet in the chain (disabled by default).
    let nextPriority = kept.reduce((mx, e) => Math.max(mx, e.priority), -1) + 1;
    for (const m of catalogModels) {
      const k = `${m.platform}::${m.modelId}`;
      if (!known.has(k)) kept.push({ platform: m.platform, modelId: m.modelId, enabled: false, priority: nextPriority++ });
    }
    return kept.sort((a, b) => a.priority - b.priority);
  }

  async setFallback(entries: FallbackEntry[]): Promise<void> {
    const normalized = entries.map((e, i) => ({ ...e, priority: i }));
    await this.state.update(FALLBACK_KEY, normalized);
    this._onChange.fire();
  }

  /** Enabled entries ordered by priority, excluding provider-level disabled platforms. */
  enabledByPriority(): FallbackEntry[] {
    const disabled = new Set(this.getDisabledProviders());
    return this.getFallback()
      .filter((e) => e.enabled && !disabled.has(e.platform))
      .sort((a, b) => a.priority - b.priority);
  }

  // ---- provider-level on/off (preserves individual model enabled flags) ----

  getDisabledProviders(): Platform[] {
    return this.state.get<Platform[]>(DISABLED_PROVIDERS_KEY) ?? [];
  }

  isProviderDisabled(platform: Platform): boolean {
    return this.getDisabledProviders().includes(platform);
  }

  async setProviderEnabled(platform: Platform, enabled: boolean): Promise<void> {
    const current = this.getDisabledProviders();
    const next = enabled
      ? current.filter((p) => p !== platform)
      : current.includes(platform) ? current : [...current, platform];
    await this.state.update(DISABLED_PROVIDERS_KEY, next);
    this._onChange.fire();
  }

  // ---- endpoint overrides ----

  getEndpoints(): Record<string, string> {
    return this.state.get<Record<string, string>>(ENDPOINTS_KEY) ?? {};
  }

  getEndpoint(platform: Platform): string | undefined {
    return this.getEndpoints()[platform];
  }

  async setEndpoint(platform: Platform, url: string): Promise<void> {
    const map = { ...this.getEndpoints() };
    map[platform] = url.trim().replace(/\/+$/, '');
    await this.state.update(ENDPOINTS_KEY, map);
    this._onChange.fire();
  }

  async resetEndpoint(platform: Platform): Promise<void> {
    const map = { ...this.getEndpoints() };
    delete map[platform];
    await this.state.update(ENDPOINTS_KEY, map);
    this._onChange.fire();
  }
}
