// Lifetime token-usage accumulator. Persisted across sessions in globalState so
// the user can see their "est. $ saved" and total token counts even after a
// reload. Distinct from `UsageTracker` (src/config/usage.ts), which is the
// in-memory per-session accumulator that the router already updates — this one
// is the persistent counterpart the footer reads to show lifetime totals.
//
// Estimated savings are computed per-model from the catalog's published
// "original provider" price (origInputPricePer1M / origOutputPricePer1M, USD
// per 1M tokens) — i.e. what you would have paid the model's original paid
// provider for the same tokens. Models with no published price contribute $0
// to savings (their tokens still count toward the token/request totals). The
// price is re-applied on every read against the *current* catalog so pricing
// corrections in the remote sheet retroactively update the displayed savings
// — we don't snapshot the dollar value at write time, because there's no real
// cost (every provider here is free) and the number is a marketing/awareness
// signal, not a bill.
import * as vscode from 'vscode';
import type { Catalog } from '../catalog/catalog';

interface ModelUsage {
  platform: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  requests: number;
}

interface LifetimeUsage {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalRequests: number;
  estimatedSavingsUsd: number;
  /** Epoch-ms when this user first recorded a request. */
  firstRecordedAt: number;
}

/** Current on-disk shape: per-model token/request breakdown. */
interface PersistedLifetimeV2 {
  version: 2;
  byModel: Record<string, ModelUsage>;
  firstRecordedAt: number;
}

/** Pre-per-model on-disk shape (flat totals, no model attribution). */
interface PersistedLifetimeV1 {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalRequests: number;
  firstRecordedAt: number;
}

const STORE_KEY = 'tiermux.lifetimeUsage';
const LEGACY_KEY = 'legacy::unknown';
const EMPTY: PersistedLifetimeV2 = { version: 2, byModel: {}, firstRecordedAt: 0 };

/** True for the old flat-totals shape (no `version`/`byModel` fields). */
function isLegacyShape(v: any): v is PersistedLifetimeV1 {
  return !!v && typeof v === 'object' && v.version !== 2 && !v.byModel;
}

/** Fold a pre-migration flat-totals record into a single "legacy::unknown"
 *  model bucket so existing users don't lose their accumulated token counts.
 *  Since the legacy record has no per-model attribution, it prices at $0
 *  (same as any model the catalog has no published price for) — only newly
 *  recorded requests get real per-model pricing. */
function migrate(v1: PersistedLifetimeV1): PersistedLifetimeV2 {
  const byModel: Record<string, ModelUsage> = {};
  if (v1.totalPromptTokens || v1.totalCompletionTokens || v1.totalRequests) {
    byModel[LEGACY_KEY] = {
      platform: 'legacy',
      modelId: 'unknown',
      promptTokens: v1.totalPromptTokens || 0,
      completionTokens: v1.totalCompletionTokens || 0,
      requests: v1.totalRequests || 0,
    };
  }
  return { version: 2, byModel, firstRecordedAt: v1.firstRecordedAt || 0 };
}

export class UsageStore {
  private data: PersistedLifetimeV2;

  constructor(private readonly mem: vscode.Memento) {
    const raw = mem.get<PersistedLifetimeV1 | PersistedLifetimeV2>(STORE_KEY, EMPTY);
    if (isLegacyShape(raw)) {
      this.data = migrate(raw);
      void this.mem.update(STORE_KEY, this.data);
    } else {
      this.data = raw as PersistedLifetimeV2;
    }
  }

  /** Record one successful request's token counts against the model that served it. */
  addRequest(platform: string, modelId: string, promptTokens: number, completionTokens: number): void {
    const p = Math.max(0, Math.round(promptTokens || 0));
    const c = Math.max(0, Math.round(completionTokens || 0));
    if (p === 0 && c === 0) return;
    const key = `${platform}::${modelId}`;
    const prev = this.data.byModel[key];
    this.data = {
      version: 2,
      byModel: {
        ...this.data.byModel,
        [key]: {
          platform,
          modelId,
          promptTokens: (prev?.promptTokens || 0) + p,
          completionTokens: (prev?.completionTokens || 0) + c,
          requests: (prev?.requests || 0) + 1,
        },
      },
      firstRecordedAt: this.data.firstRecordedAt || Date.now(),
    };
    void this.mem.update(STORE_KEY, this.data);
  }

  /** Reset all lifetime counters to zero. */
  async clear(): Promise<void> {
    this.data = { ...EMPTY, byModel: {} };
    await this.mem.update(STORE_KEY, this.data);
  }

  /** Read the current lifetime totals, pricing each model's tokens at the
   *  catalog's published origInputPricePer1M/origOutputPricePer1M. Models
   *  with no published price (or no longer present in the catalog) price
   *  at $0 for that slice of usage — never a flat/blended fallback. */
  getLifetime(catalog: Catalog): LifetimeUsage {
    let p = 0, c = 0, requests = 0, savings = 0;
    for (const usage of Object.values(this.data.byModel)) {
      p += usage.promptTokens;
      c += usage.completionTokens;
      requests += usage.requests;
      const model = catalog.find(usage.platform, usage.modelId);
      const inPrice = model?.origInputPricePer1M ?? 0;
      const outPrice = model?.origOutputPricePer1M ?? 0;
      savings += (usage.promptTokens / 1_000_000) * inPrice + (usage.completionTokens / 1_000_000) * outPrice;
    }
    return {
      totalPromptTokens: p,
      totalCompletionTokens: c,
      totalTokens: p + c,
      totalRequests: requests,
      estimatedSavingsUsd: savings,
      firstRecordedAt: this.data.firstRecordedAt || 0,
    };
  }
}
