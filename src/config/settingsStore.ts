

import * as vscode from 'vscode';
import type { FallbackEntry, Platform, CustomEndpoint } from '../shared/types';
import type { Catalog } from '../catalog/catalog';
import { allPlatformInfo } from '../providers';

const FALLBACK_KEY = 'tiermux.fallback';
const ENDPOINTS_KEY = 'tiermux.endpoints';
const DISABLED_PROVIDERS_KEY = 'tiermux.disabledProviders';
const CUSTOM_ENDPOINTS_KEY = 'tiermux.customEndpoints';
const NOTIFIED_MODELS_KEY = 'tiermux.notifiedModels';

/** Platform left enabled by default — a keyless gateway that works with zero setup.
 *  Every other provider starts off until the user opts in (usually by adding a key). */
const DEFAULT_ENABLED_PLATFORM: Platform = 'kilo';

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

    const endpoints = this.getCustomEndpoints();
    const epIds = new Set(endpoints.map((ep) => ep.id));
    const kept = stored.filter((e) =>
      inCatalog.has(`${e.platform}::${e.modelId}`) ||
      (e.platform === 'custom' && epIds.has(e.modelId.split('::')[0]))
    );
    const known = new Set(kept.map((e) => `${e.platform}::${e.modelId}`));

    let nextPriority = kept.reduce((mx, e) => Math.max(mx, e.priority), -1) + 1;
    for (const m of catalogModels) {
      const k = `${m.platform}::${m.modelId}`;
      if (!known.has(k)) kept.push({ platform: m.platform, modelId: m.modelId, enabled: false, priority: nextPriority++ });
    }
    return kept.sort((a, b) => a.priority - b.priority);
  }

  /** Entries newly appended to the fallback chain since the last check, i.e. models
   *  the user hasn't been told about yet. Marks them as notified as a side effect. */
  checkForNewModels(): FallbackEntry[] {
    const fallback = this.getFallback(); // runs reconcile(), which appends new catalog models
    const notified = new Set(this.state.get<string[]>(NOTIFIED_MODELS_KEY, []));
    // Skip models the catalog flags as not-yet-ready (ready===false) so staging a
    // new model in the remote sheet doesn't notify users until it's published.
    const fresh = fallback.filter(
      (e) =>
        !notified.has(`${e.platform}::${e.modelId}`) &&
        this.catalog.find(e.platform, e.modelId)?.ready !== false,
    );
    if (fresh.length) {
      void this.state.update(NOTIFIED_MODELS_KEY, [...notified, ...fresh.map((e) => `${e.platform}::${e.modelId}`)]);
    }
    return fresh;
  }

  /** Silently mark every currently-known model as notified, without firing any
   *  notification. Used once, the first time this feature runs on an install, so
   *  existing users don't get flooded with "N new models!" for their whole catalog. */
  seedNotifiedModels(): void {
    const keys = this.getFallback().map((e) => `${e.platform}::${e.modelId}`);
    void this.state.update(NOTIFIED_MODELS_KEY, keys);
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

  getDisabledProviders(): Platform[] {
    const stored = this.state.get<Platform[]>(DISABLED_PROVIDERS_KEY);
    if (stored) return stored;

    const def = allPlatformInfo()
      .map((p) => p.platform)
      .filter((p) => p !== DEFAULT_ENABLED_PLATFORM);
    void this.state.update(DISABLED_PROVIDERS_KEY, def);
    return def;
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

  getCustomEndpoints(): CustomEndpoint[] {
    return this.state.get<CustomEndpoint[]>(CUSTOM_ENDPOINTS_KEY) ?? [];
  }

  getCustomEndpoint(id: string): CustomEndpoint | undefined {
    return this.getCustomEndpoints().find((ep) => ep.id === id);
  }

  async setCustomEndpoints(list: CustomEndpoint[]): Promise<void> {
    await this.state.update(CUSTOM_ENDPOINTS_KEY, list);
    this._onChange.fire();
  }

  async upsertCustomEndpoint(endpoint: CustomEndpoint): Promise<void> {
    const current = this.getCustomEndpoints();
    const existingIndex = current.findIndex((ep) => ep.id === endpoint.id);
    if (existingIndex >= 0) {
      current[existingIndex] = endpoint;
    } else {
      current.push(endpoint);
    }
    await this.setCustomEndpoints(current);
  }

  async removeCustomEndpoint(id: string): Promise<void> {
    const current = this.getCustomEndpoints();
    const filtered = current.filter((ep) => ep.id !== id);
    await this.setCustomEndpoints(filtered);
  }
}
