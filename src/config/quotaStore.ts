import * as vscode from 'vscode';

/** Persistent backing for the RateTracker's RPM/RPD windows. The tracker is in-memory, so a
 *  window reload used to zero it and the next request re-hammered a provider that had just
 *  429'd. Same Memento idiom as UsageStore: versioned shape, hydrate once, debounced write-back. */

interface PersistedQuotaV1 {
  version: 1;
  /** Per-model (`platform::modelId`) outbound-request timestamps (epoch ms). */
  stamps: Record<string, number[]>;
}

const STORE_KEY = 'tiermux.quotaLedger';
const EMPTY: PersistedQuotaV1 = { version: 1, stamps: {} };
const DAY_MS = 86_400_000;
/** Debounce for write-back after record(); keeps globalState writes off the request path. */
const FLUSH_DELAY_MS = 2_000;
/** Force a write after this many records even inside the debounce window. */
const FLUSH_EVERY_N = 50;
/** Cap on stored stamps per model; past it the oldest drop and the provider's own 429 handling
 *  takes over, so globalState stays bounded. */
const MAX_STAMPS_PER_MODEL = 2_000;

export class QuotaStore {
  private data: PersistedQuotaV1;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingSinceFlush = 0;

  constructor(private readonly mem: vscode.Memento) {
    const raw = mem.get<PersistedQuotaV1>(STORE_KEY, EMPTY);
    this.data = raw && raw.version === 1 && raw.stamps && typeof raw.stamps === 'object'
      ? raw
      : { ...EMPTY };
  }

  /** All stored stamps, pruned to the trailing 24h. Called once, at RateTracker construction. */
  snapshot(): Map<string, number[]> {
    const now = Date.now();
    const out = new Map<string, number[]>();
    for (const [key, arr] of Object.entries(this.data.stamps)) {
      if (!Array.isArray(arr)) continue;
      const live = arr.filter((t) => now - t < DAY_MS);
      if (live.length > 0) out.set(key, live);
    }
    return out;
  }

  /** Replace one model's stamps (the tracker's post-record window). Debounced write-back. */
  setStamps(key: string, stamps: number[]): void {
    const now = Date.now();
    const live = stamps.filter((t) => now - t < DAY_MS);
    if (live.length > MAX_STAMPS_PER_MODEL) live.splice(0, live.length - MAX_STAMPS_PER_MODEL);
    this.data = { version: 1, stamps: { ...this.data.stamps, [key]: live } };
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
