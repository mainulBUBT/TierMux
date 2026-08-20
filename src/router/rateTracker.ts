

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * Conservative stand-ins for a limit the catalog declares as exactly `0`.
 *
 * `0` is never a real rate limit — it means the source spreadsheet cell was blank or garbled.
 * The old falsy check (`if (!rpmLimit && !rpdLimit) return true`) read it as "no limit at all",
 * so the models that looked MOST restricted were the only ones with no throttling whatsoever,
 * and they hammered their provider straight into 429s. Guessing low is the safe direction: an
 * over-tight guess costs some throughput, an over-loose one costs the whole provider.
 *
 * `null`/`undefined` still mean genuinely unlimited — that is the custom-endpoint case (local
 * llama.cpp / LM Studio), where there really is no quota. Every catalogued model carries a
 * positive number, so the two cases never collide.
 */
const UNKNOWN_RPM = 5;
const UNKNOWN_RPD = 200;

/** Resolve a declared limit: `null` = unlimited, `0` = unknown (use a conservative floor). */
function declared(limit: number | null, fallback: number): number | null {
  if (limit === null || limit === undefined) return null;
  return limit > 0 ? limit : fallback;
}

export class RateTracker {

  private ts = new Map<string, number[]>();

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
  }

  /**
   * Remaining quota as a fraction [0..1] against the *tightest* declared limit — 1 = untouched,
   * 0 = at the cap. Unlike `canSend` (a cliff that only fires once you've already hit the wall)
   * this is a gradient, so a model at 90% of its daily allowance yields to an idle peer before
   * either one is exhausted. Models with no declared limit report 1 (neutral, not "infinite
   * headroom") so they neither gain nor lose against limited peers.
   */
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
