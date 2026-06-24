// In-process telemetry counters — zero external dependencies, zero I/O.
//
// KPI targets (MVP validation):
//   Retrieval  → symbolHitRate ≥80%, grepRate ≤20%, windowReadRate ≥80%, largeReadRate ≤5%
//   Efficiency → avgToolCalls ≤ 3.5 overall (Explain ≤2, Bug ≤4, Feature ≤6)
//
// Lifetime: extension session. Resets on reload. Not persisted to disk.

export interface TelemetrySnapshot {
  totalRequests: number;
  totalToolCalls: number;
  symbolIndexHits: number;
  bundleCacheHits: number;
  invertedIndexHits: number;
  grepCalls: number;
  largeContextReads: number;
  windowReads: number;
  fullFileReads: number;
  // Derived
  symbolHitRate: number;
  cacheHitRate: number;
  grepRate: number;
  largeReadRate: number;
  windowReadRate: number;
  fullFileReadRate: number;
  avgToolCalls: number;
}

const counts = {
  totalRequests: 0,
  totalToolCalls: 0,
  symbolIndexHits: 0,
  bundleCacheHits: 0,
  invertedIndexHits: 0,
  grepCalls: 0,
  largeContextReads: 0,
  windowReads: 0,
  fullFileReads: 0,
};

// ---- Listeners ----
const listeners = new Set<() => void>();
export function onTelemetryUpdate(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function notify(): void { listeners.forEach((cb) => { try { cb(); } catch { /**/ } }); }

// ---- Counters ----
export function trackRequest(): void      { counts.totalRequests++;       notify(); }
export function trackToolCall(): void     { counts.totalToolCalls++;      notify(); }
export function trackSymbolHit(): void    { counts.symbolIndexHits++;     notify(); }
export function trackCacheHit(): void     { counts.bundleCacheHits++;     notify(); }
export function trackIndexHit(): void     { counts.invertedIndexHits++;   notify(); }
export function trackGrep(): void         { counts.grepCalls++;           notify(); }
export function trackLargeRead(): void    { counts.largeContextReads++;   notify(); }
export function trackWindowRead(): void   { counts.windowReads++;         notify(); }
export function trackFullFileRead(): void { counts.fullFileReads++;       notify(); }

// ---- Snapshot ----
function rate(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 100);
}

export function getSnapshot(): TelemetrySnapshot {
  const t = counts.totalRequests;
  const totalReads = counts.windowReads + counts.fullFileReads;
  return {
    ...counts,
    symbolHitRate:    rate(counts.symbolIndexHits, t),
    cacheHitRate:     rate(counts.bundleCacheHits, t),
    grepRate:         rate(counts.grepCalls, t),
    largeReadRate:    rate(counts.largeContextReads, t),
    windowReadRate:   rate(counts.windowReads, totalReads),
    fullFileReadRate: rate(counts.fullFileReads, totalReads),
    avgToolCalls:     t === 0 ? 0 : Math.round((counts.totalToolCalls / t) * 10) / 10,
  };
}

export function resetTelemetry(): void {
  counts.totalRequests = 0;
  counts.totalToolCalls = 0;
  counts.symbolIndexHits = 0;
  counts.bundleCacheHits = 0;
  counts.invertedIndexHits = 0;
  counts.grepCalls = 0;
  counts.largeContextReads = 0;
  counts.windowReads = 0;
  counts.fullFileReads = 0;
}

// ---- Report ----
function kpi(value: number, target: number, op: '>=' | '<='): string {
  return (op === '>=' ? value >= target : value <= target) ? '✓' : '✗';
}

export function formatTelemetryReport(): string {
  const s = getSnapshot();
  const totalReads = s.windowReads + s.fullFileReads;
  const allPass =
    s.symbolHitRate  >= 80 &&
    s.grepRate       <= 20 &&
    s.windowReadRate >= 80 &&
    s.largeReadRate  <= 5  &&
    s.avgToolCalls   <= 3.5;

  return [
    `=== TierMux MVP Validation ===`,
    ``,
    `Queries tested      : ${s.totalRequests}`,
    ``,
    `Retrieval`,
    `-----------`,
    `Symbol hit rate     : ${s.symbolHitRate}%   ${kpi(s.symbolHitRate, 80, '>=')} target ≥80%`,
    `Cache hit rate      : ${s.cacheHitRate}%`,
    `Grep fallback       : ${s.grepRate}%   ${kpi(s.grepRate, 20, '<=')} target ≤20%`,
    `Window reads        : ${s.windowReadRate}%   ${kpi(s.windowReadRate, 80, '>=')} target ≥80%  (${s.windowReads}/${totalReads} reads)`,
    `Large reads         : ${s.largeReadRate}%   ${kpi(s.largeReadRate, 5, '<=')} target ≤5%`,
    ``,
    `Efficiency`,
    `----------`,
    `Total tool calls    : ${s.totalToolCalls}`,
    `Avg tool calls/task : ${s.avgToolCalls.toFixed(1)}   ${kpi(s.avgToolCalls, 3.5, '<=')} target ≤3.5`,
    `  Explain target    : ≤2`,
    `  Bug/Debug target  : ≤4`,
    `  Feature target    : ≤6`,
    ``,
    `Answer Quality`,
    `--------------`,
    `(manual — grade correct-file / correct-symbol / correct-answer per query)`,
    ``,
    `Status: MVP ${allPass ? 'PASSED ✓' : 'FAILING ✗'}`,
    allPass ? `→ Architecture freeze. Next: model/provider routing tuning.` : `→ Check failing KPIs above.`,
  ].join('\n');
}
