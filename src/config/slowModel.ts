

import type * as vscode from 'vscode';

type SlowMap = Record<string, number>; // key: `${platform}::${modelId}` -> expiry epoch ms

const STORE_KEY = 'tiermux.slowModels';
export const SLOW_LATENCY_MS = 8_000;
export const SLOW_LABEL_MS = 30 * 60_000;

export class SlowModelStore {
  private map: SlowMap;

  constructor(private readonly mem: vscode.Memento) {
    this.map = mem.get<SlowMap>(STORE_KEY, {});
  }

  private key(platform: string, modelId: string): string {
    return `${platform}::${modelId}`;
  }

  /** Label a model slow for `ms` (default 30 min). */
  markSlow(platform: string, modelId: string, ms = SLOW_LABEL_MS): void {
    this.map[this.key(platform, modelId)] = Date.now() + Math.max(0, ms);
    void this.mem.update(STORE_KEY, this.map);
  }

  isSlow(platform: string, modelId: string): boolean {
    const until = this.map[this.key(platform, modelId)];
    return until !== undefined && until > Date.now();
  }

  /** Currently-flagged `platform::modelId` keys, for the picker badge. */
  slowKeys(): string[] {
    const now = Date.now();
    return Object.entries(this.map).filter(([, until]) => until > now).map(([k]) => k);
  }
}
