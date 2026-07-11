

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

export class RateTracker {

  private ts = new Map<string, number[]>();

  /** True if sending now would stay within both the per-minute and per-day limits. */
  canSend(platform: string, modelId: string, rpmLimit: number | null, rpdLimit: number | null): boolean {
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

  /** How many ms until this model is under its RPM limit again (0 = ready now). */
  rpmCooldownMs(platform: string, modelId: string, rpmLimit: number | null): number {
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
