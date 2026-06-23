// Lifetime token-usage accumulator. Persisted across sessions in globalState so
// the user can see their "est. $ saved" and total token counts even after a
// reload. Distinct from `UsageTracker` (src/config/usage.ts), which is the
// in-memory per-session accumulator that the router already updates — this one
// is the persistent counterpart the footer reads to show lifetime totals.
//
// Estimated savings are computed from the user's reference-price settings
// (tiermux.usage.referencePriceInPer1M / referencePriceOutPer1M, defaults
// $5/$15 = OpenAI GPT-4o). The price is re-applied on every read so a user
// tuning the price retroactively updates the displayed savings — we don't
// snapshot the dollar value at write time, because there's no real cost
// (every provider here is free) and the number is a marketing/awareness
// signal, not a bill.
import * as vscode from 'vscode';

export interface LifetimeUsage {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalRequests: number;
  estimatedSavingsUsd: number;
  /** Epoch-ms when this user first recorded a request. */
  firstRecordedAt: number;
}

interface PersistedLifetime {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalRequests: number;
  firstRecordedAt: number;
}

const STORE_KEY = 'tiermux.lifetimeUsage';
const EMPTY: PersistedLifetime = { totalPromptTokens: 0, totalCompletionTokens: 0, totalRequests: 0, firstRecordedAt: 0 };

export class UsageStore {
  private data: PersistedLifetime;

  constructor(private readonly mem: vscode.Memento) {
    this.data = mem.get<PersistedLifetime>(STORE_KEY, EMPTY);
  }

  /** Record one successful request's token counts. Dollar savings are recomputed on read. */
  addRequest(promptTokens: number, completionTokens: number): void {
    const p = Math.max(0, Math.round(promptTokens || 0));
    const c = Math.max(0, Math.round(completionTokens || 0));
    if (p === 0 && c === 0) return;
    this.data = {
      totalPromptTokens: (this.data.totalPromptTokens || 0) + p,
      totalCompletionTokens: (this.data.totalCompletionTokens || 0) + c,
      totalRequests: (this.data.totalRequests || 0) + 1,
      firstRecordedAt: this.data.firstRecordedAt || Date.now(),
    };
    void this.mem.update(STORE_KEY, this.data);
  }

  /** Reset all lifetime counters to zero. */
  async clear(): Promise<void> {
    this.data = { ...EMPTY };
    await this.mem.update(STORE_KEY, this.data);
  }

  /** Read the current lifetime totals, applying the configured reference prices. */
  getLifetime(): LifetimeUsage {
    const cfg = vscode.workspace.getConfiguration('tiermux.usage');
    const inPrice = Math.max(0, cfg.get<number>('referencePriceInPer1M', 5));
    const outPrice = Math.max(0, cfg.get<number>('referencePriceOutPer1M', 15));
    const p = this.data.totalPromptTokens || 0;
    const c = this.data.totalCompletionTokens || 0;
    const savings = (p / 1_000_000) * inPrice + (c / 1_000_000) * outPrice;
    return {
      totalPromptTokens: p,
      totalCompletionTokens: c,
      totalTokens: p + c,
      totalRequests: this.data.totalRequests || 0,
      estimatedSavingsUsd: savings,
      firstRecordedAt: this.data.firstRecordedAt || 0,
    };
  }
}
