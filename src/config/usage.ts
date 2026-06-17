// Session-wide token-usage accumulator.
import type { TokenUsage } from '../shared/types';

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
}

export class UsageTracker {
  private totals: UsageTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };

  add(usage: TokenUsage | undefined): void {
    if (!usage) return;
    this.totals.promptTokens += usage.prompt_tokens || 0;
    this.totals.completionTokens += usage.completion_tokens || 0;
    this.totals.totalTokens += usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
    this.totals.requests += 1;
  }

  get(): UsageTotals {
    return { ...this.totals };
  }

  reset(): void {
    this.totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
  }
}
