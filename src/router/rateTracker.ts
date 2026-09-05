

import type { QuotaStore } from '../config/quotaStore';

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

/** Stand-ins for a limit the catalog declares as exactly `0` — never a real limit, just a blank
 *  sheet cell. The old falsy check read it as "unlimited", so the most restricted-looking models
 *  had no throttling and hammered straight into 429s. `null`/`undefined` still mean genuinely
 *  unlimited (custom/local endpoints); every catalogued model carries a positive number. */
const UNKNOWN_RPM = 5;
const UNKNOWN_RPD = 200;

/** Resolve a declared limit: `null` = unlimited, `0` = unknown (use a conservative floor). */
function declared(limit: number | null, fallback: number): number | null {
  if (limit === null || limit === undefined) return null;
  return limit > 0 ? limit : fallback;
}

export class RateTracker {

  private ts = new Map<string, number[]>();

  /** @param store Optional persistent ledger: hydrates windows from the last session's stamps and
   *  writes each model's stamps back (debounced inside the store). */
  constructor(private readonly store?: QuotaStore) {
    if (store) this.ts = store.snapshot();
  }

  /** True if sending now would stay within both the per-minute and per-day limits. */
  canSend(platform: string, modelId: string, rpmRaw: number | null, rpdRaw: number | null): boolean {
    const rpmLimit = declared(rpmRaw, UNKNOWN_RPM);
    const rpdLimit = declared(rpdRaw, UNKNOWN_RPD);
    if (!rpmLimit && !rpdLimit) return true;
    const now = Date.now();
    const key = `${platform}::${modelId}`;
    const stamps = this.prune(key, now);
    if (rpmLimit && stamps.filter(t => now - t < MIN_MS).length >= rpmLimit) return false;
    if (rpdLimit && stamps.filter(t => now - t < DAY_MS).length >= rpdLimit) return false;
    return true;
  }

  /** Call after every outbound HTTP attempt (success or failure — both count against limits). */
  record(platform: string, modelId: string): void {
    const key = `${platform}::${modelId}`;
    const now = Date.now();
    const stamps = this.prune(key, now);
    stamps.push(now);
    this.ts.set(key, stamps);
    this.store?.setStamps(key, stamps);
  }

  /** Remaining quota as a fraction [0..1] of the tightest declared limit — a gradient, unlike
   *  canSend's cliff, so a model at 90% of its daily allowance yields to an idle peer. No declared
   *  limit reports 1 (neutral). */
  headroom(platform: string, modelId: string, rpmRaw: number | null, rpdRaw: number | null): number {
    const rpmLimit = declared(rpmRaw, UNKNOWN_RPM);
    const rpdLimit = declared(rpdRaw, UNKNOWN_RPD);
    if (!rpmLimit && !rpdLimit) return 1;
    const now = Date.now();
    const stamps = this.prune(`${platform}::${modelId}`, now);
    let used = 0;
    if (rpmLimit) used = Math.max(used, stamps.filter((t) => now - t < MIN_MS).length / rpmLimit);
    if (rpdLimit) used = Math.max(used, stamps.filter((t) => now - t < DAY_MS).length / rpdLimit);
    return Math.max(0, 1 - used);
  }

  /** Requests sent to any model on this platform within `windowMs` — raw load, for spreading. */
  recentLoad(platform: string, windowMs = MIN_MS): number {
    const now = Date.now();
    let count = 0;
    for (const key of this.ts.keys()) {
      if (!key.startsWith(`${platform}::`)) continue;
      count += this.prune(key, now).filter((t) => now - t < windowMs).length;
    }
    return count;
  }

  /** How many ms until this model is under its RPM limit again (0 = ready now). */
  rpmCooldownMs(platform: string, modelId: string, rpmRaw: number | null): number {
    const rpmLimit = declared(rpmRaw, UNKNOWN_RPM);
    if (!rpmLimit) return 0;
    const now = Date.now();
    const key = `${platform}::${modelId}`;
    const stamps = this.prune(key, now).filter(t => now - t < MIN_MS);
    if (stamps.length < rpmLimit) return 0;

    const oldest = stamps.sort((a, b) => a - b)[0];
    return Math.max(0, oldest + MIN_MS - now);
  }

  private prune(key: string, now: number): number[] {
    const pruned = (this.ts.get(key) ?? []).filter(t => now - t < DAY_MS);
    this.ts.set(key, pruned);
    return pruned;
  }
}
