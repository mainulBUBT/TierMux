

import type * as vscode from 'vscode';

export type Vote = 'up' | 'down' | 'none';
/** `up`/`down` are the user's explicit votes; `autoUp`/`autoDown` are outcome signals the host
 *  records on its own (verify passed/failed, a stuck turn) — half the weight of a vote. */
export interface ModelStat { up: number; down: number; autoUp?: number; autoDown?: number }
type StatMap = Record<string, ModelStat>; // key: `${taskKind}::${platform}::${modelId}`

/** What a finished turn says about the model that served it. Only wire-level facts: the verify
 *  command's exit code and the repeat-failure stop — never answer quality. */
export type TurnSignal = 'verifyPassed' | 'verifyFailed' | 'stuck';

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

  /** Record an implicit outcome for the model that served a turn. Persists like a vote, so the
   *  picker's peer tie-break learns across reloads which models finish work here. */
  recordSignal(taskKind: string, platform: string, modelId: string, signal: TurnSignal): void {
    const k = this.key(taskKind, platform, modelId);
    const s = this.map[k] ?? { up: 0, down: 0 };
    if (signal === 'verifyPassed') s.autoUp = (s.autoUp ?? 0) + 1;
    else s.autoDown = (s.autoDown ?? 0) + 1;
    this.map[k] = s;
    void this.mem.update(STORE_KEY, this.map);
  }

  /** Net feedback for a model on a task kind: (👍 − 👎) + half the net outcome signals; 0 when
   *  there is no signal. Used ONLY to break ties among equal-rank peers (picker.ts). */
  score(taskKind: string, platform: string, modelId: string): number {
    const s = this.map[this.key(taskKind, platform, modelId)];
    if (!s) return 0;
    return (s.up - s.down) + Math.trunc(((s.autoUp ?? 0) - (s.autoDown ?? 0)) / 2);
  }

  /** Full local snapshot — the one place a future backend sync would read from. */
  snapshot(): StatMap {
    return { ...this.map };
  }
}
