// Per-model latency tracker. Keeps a rolling window of the last 20 request
// durations so the router can prefer genuinely fast models for simple tasks.

const MAX_SAMPLES = 20;

export class LatencyTracker {
  private samples = new Map<string, number[]>();

  record(platform: string, modelId: string, elapsedMs: number): void {
    const key = `${platform}::${modelId}`;
    const arr = this.samples.get(key) ?? [];
    arr.push(elapsedMs);
    if (arr.length > MAX_SAMPLES) arr.shift();
    this.samples.set(key, arr);
  }

  /** Median latency in ms, or null if fewer than 3 samples (too noisy). */
  p50(platform: string, modelId: string): number | null {
    const arr = this.samples.get(`${platform}::${modelId}`);
    if (!arr || arr.length < 3) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
}
