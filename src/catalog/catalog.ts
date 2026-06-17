// Loads the bundled model catalog (offline) and derives a default fallback chain.
import * as fs from 'fs';
import * as path from 'path';
import type { CatalogModel, FallbackEntry } from '../shared/types';

export class Catalog {
  private models: CatalogModel[] = [];

  constructor(private readonly extensionPath: string) {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(path.join(this.extensionPath, 'media', 'catalog.json'), 'utf8');
      const parsed = JSON.parse(raw) as { models?: CatalogModel[] };
      this.models = Array.isArray(parsed.models) ? parsed.models : [];
    } catch (e) {
      console.error('[tiermux] failed to load catalog.json', e);
      this.models = [];
    }
  }

  all(): CatalogModel[] {
    return this.models;
  }

  find(platform: string, modelId: string): CatalogModel | undefined {
    return this.models.find((m) => m.platform === platform && m.modelId === modelId);
  }

  /** Key used to identify a model across catalog + fallback entries. */
  static key(platform: string, modelId: string): string {
    return `${platform}::${modelId}`;
  }

  /**
   * Default fallback chain: every catalog model enabled, ordered by
   * intelligence then speed (smartest/fastest first).
   */
  defaultFallback(): FallbackEntry[] {
    const sorted = [...this.models].sort((a, b) =>
      a.intelligenceRank - b.intelligenceRank || a.speedRank - b.speedRank,
    );
    return sorted.map((m, i) => ({ platform: m.platform, modelId: m.modelId, enabled: true, priority: i }));
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
