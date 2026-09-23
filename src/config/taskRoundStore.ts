import * as vscode from 'vscode';

/** Persistent backing for the picker's per-task-kind equal-rank rotation counter
 *  (taskRoundCounters in picker.ts). Pure in-memory before this (2026-09-23 gap): a window
 *  reload zeroed it, which is harmless for a task kind exercised many times per session
 *  (coding/agent turns re-roll the counter dozens of times) but meant a rarely-exercised
 *  kind like `vision` — often the only vision turn in a session — kept reading round 0 and
 *  the SAME table-head candidate (TASK_ROUTING.vision[0]) led every time, even though the
 *  rotation code path is identical to coding's. Same Memento idiom as QuotaStore: versioned
 *  shape, hydrate once, debounced write-back. */

interface PersistedTaskRoundV1 {
  version: 1;
  /** taskKind → next round counter value. */
  rounds: Record<string, number>;
}

const STORE_KEY = 'tiermux.taskRoundLedger';
const EMPTY: PersistedTaskRoundV1 = { version: 1, rounds: {} };
/** Debounce for write-back after setRound(); keeps globalState writes off the request path. */
const FLUSH_DELAY_MS = 2_000;
/** Force a write after this many records even inside the debounce window. */
const FLUSH_EVERY_N = 20;

export class TaskRoundStore {
  private data: PersistedTaskRoundV1;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingSinceFlush = 0;

  constructor(private readonly mem: vscode.Memento) {
    const raw = mem.get<PersistedTaskRoundV1>(STORE_KEY, EMPTY);
    this.data = raw && raw.version === 1 && raw.rounds && typeof raw.rounds === 'object'
      ? raw
      : { ...EMPTY };
  }

  /** All persisted counters, read once at picker wiring time. */
  snapshot(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [kind, round] of Object.entries(this.data.rounds)) {
      if (typeof round === 'number' && Number.isFinite(round)) out.set(kind, round);
    }
    return out;
  }

  /** One task kind's counter, after nextTaskRound() advances it. Debounced write-back. */
  setRound(taskKind: string, round: number): void {
    this.data = { version: 1, rounds: { ...this.data.rounds, [taskKind]: round } };
    this.dirty = true;
    this.pendingSinceFlush++;
    this.scheduleFlush();
    if (this.pendingSinceFlush >= FLUSH_EVERY_N) this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, FLUSH_DELAY_MS);
  }

  /** Write pending data now (also usable as an explicit flush on shutdown paths). */
  flush(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.pendingSinceFlush = 0;
    try {
      void this.mem.update(STORE_KEY, this.data).then(undefined, () => { /* best-effort */ });
    } catch {
      /* best-effort — a failed persist must never break routing */
    }
  }
}
