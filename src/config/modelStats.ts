

import type * as vscode from 'vscode';

export type Vote = 'up' | 'down' | 'none';
export interface ModelStat { up: number; down: number }
type StatMap = Record<string, ModelStat>; // key: `${taskKind}::${platform}::${modelId}`

const STORE_KEY = 'tiermux.modelStats';

export class ModelStatsStore {
  private map: StatMap;

  constructor(private readonly mem: vscode.Memento) {
    this.map = mem.get<StatMap>(STORE_KEY, {});
  }

  private key(taskKind: string, platform: string, modelId: string): string {
    return `${taskKind}::${platform}::${modelId}`;
  }

  /** Apply a vote, undoing the previous one for the same reply so toggling is idempotent. */
  recordVote(taskKind: string, platform: string, modelId: string, vote: Vote, prev: Vote = 'none'): void {
    const k = this.key(taskKind, platform, modelId);
    const s = this.map[k] ?? { up: 0, down: 0 };
    if (prev === 'up') s.up = Math.max(0, s.up - 1);
    if (prev === 'down') s.down = Math.max(0, s.down - 1);
    if (vote === 'up') s.up += 1;
    if (vote === 'down') s.down += 1;
    this.map[k] = s;
    void this.mem.update(STORE_KEY, this.map);
  }

  /** Net feedback for a model on a task kind (👍 − 👎); 0 when there's no signal. */
  score(taskKind: string, platform: string, modelId: string): number {
    const s = this.map[this.key(taskKind, platform, modelId)];
    return s ? s.up - s.down : 0;
  }

  /** Full local snapshot — the one place a future backend sync would read from. */
  snapshot(): StatMap {
    return { ...this.map };
  }
}
