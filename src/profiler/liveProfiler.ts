import * as crypto from 'crypto';
import { TimerStack } from './timerStack';
import type {
  TurnId, TurnTrace, ModelAggregate, ReportData, ProfilerExport,
  ProviderAttempt, BeginTurnOpts, EndTurnData, IProfilerService, TimingPhase,
  TurnTraceTiming,
} from './types';

const DEFAULT_RING_SIZE = 200;
const MIN_PERCENTILE_SAMPLE = 20;

function newTurnId(): TurnId {
  return crypto.randomUUID() as TurnId;
}

function emptyTiming(): TurnTraceTiming {
  return { totalMs: 0, sessionSetupMs: 0, ttftMs: 0, providerMs: 0, routerMs: 0, toolMs: 0, qualityGateMs: 0, replayMs: 0, ocOverheadMs: 0 };
}

function emptyAggregate(modelId: string): ModelAggregate {
  return {
    modelId, turnCount: 0, totalAttempts: 0, successfulAttempts: 0,
    avgTotalLatencyMs: 0, avgTTFTMs: 0, avgTokensPerSecond: 0, avgToolCallsPerTurn: 0,
    qualityGateRate: 0, fallbackRate: 0,
    p50LatencyMs: 0, p95LatencyMs: 0, p99LatencyMs: 0,
    latencies: [], ttfts: [],
  };
}

function p(arr: number[], pct: number): number {
  if (arr.length < 2) return arr[0] ?? 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * pct / 100) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function p50(arr: number[]): number { return p(arr, 50); }
function p95(arr: number[]): number { return p(arr, 95); }
function p99(arr: number[]): number { return p(arr, 99); }

export class LiveProfiler implements IProfilerService {
  private turns = new Map<TurnId, TurnTrace>();
  private turnStartTimes = new Map<TurnId, number>();
  private recentTurns: TurnTrace[] = [];
  private ringSize: number;
  private modelAggregates = new Map<string, ModelAggregate>();
  private timerStacks = new Map<TurnId, TimerStack>();

  constructor(ringSize = DEFAULT_RING_SIZE) {
    this.ringSize = Math.max(1, Math.min(2000, ringSize));
  }

  beginTurn(opts: BeginTurnOpts): TurnId {
    const turnId = newTurnId();
    const now = Date.now();
    this.turnStartTimes.set(turnId, now);

    const trace: TurnTrace = {
      turnId,
      sessionId: opts.sessionId,
      mode: opts.mode,
      timestamp: now,
      promptLength: opts.promptLength,
      taskKind: opts.taskKind,
      containsMentions: opts.containsMentions,
      containsAttachments: opts.containsAttachments,
      selectedModel: '',
      chainHops: [],
      finalHopIndex: 0,
      timing: emptyTiming(),
      totalTokens: 0,
      tokensPerSecond: 0,
      toolCalls: {},
      totalToolCalls: 0,
      qualityGate: { triggered: false, signals: [], score: 0 },
      fallbacks: [],
      providerAttempts: [],
      timeline: [],
    };

    this.turns.set(turnId, trace);
    this.timerStacks.set(turnId, new TimerStack());
    return turnId;
  }

  endTurn(turnId: TurnId, data: EndTurnData): TurnTrace {
    const trace = this.turns.get(turnId);
    if (!trace) {
      throw new Error(`[tiermux-profiler] endTurn: no trace for turnId ${turnId}`);
    }

    const startMs = this.turnStartTimes.get(turnId) ?? trace.timestamp;
    trace.timing.totalMs = Date.now() - startMs;

    if (trace.timing.providerMs === 0 && trace.timing.totalMs > 0) {
      trace.timing.providerMs = Math.max(0, trace.timing.totalMs - trace.timing.sessionSetupMs - trace.timing.toolMs);
    }
    trace.selectedModel = data.model;
    trace.finalHopIndex = data.hop;
    trace.totalTokens = data.tokens.total;
    if (trace.timing.totalMs > 0) {
      trace.tokensPerSecond = Math.round(data.tokens.completion / (trace.timing.totalMs / 1000));
    }

    this.timerStacks.delete(turnId);
    this.turnStartTimes.delete(turnId);
    this.turns.delete(turnId);

    this.recentTurns.unshift(trace);
    if (this.recentTurns.length > this.ringSize) {
      this.recentTurns.pop();
    }

    this.updateAggregates(trace);

    return trace;
  }

  timerStart(turnId: TurnId, phase: TimingPhase): void {
    const stack = this.timerStacks.get(turnId);
    if (stack) stack.start(phase);
  }

  timerEnd(turnId: TurnId, phase: TimingPhase): number | undefined {
    const stack = this.timerStacks.get(turnId);
    if (!stack) return undefined;
    const elapsed = stack.end(phase);
    if (elapsed === undefined) return undefined;

    const trace = this.turns.get(turnId);
    if (trace) {
      const fieldMap: Record<string, keyof TurnTraceTiming> = {
        Provider: 'providerMs',
        Router: 'routerMs',
        SessionSetup: 'sessionSetupMs',
        Tool: 'toolMs',
        QualityGate: 'qualityGateMs',
        Replay: 'replayMs',
        OCOverhead: 'ocOverheadMs',
      };
      const field = fieldMap[phase];
      if (field) {
        trace.timing[field] += elapsed;
      }
      trace.timeline.push({
        phase,
        label: phase,
        startMs: Math.max(0, Date.now() - (this.turnStartTimes.get(turnId) ?? Date.now()) - elapsed),
        durationMs: elapsed,
      });
    }
    return elapsed;
  }

  recordTTFT(turnId: TurnId, ms: number): void {
    const trace = this.turns.get(turnId);
    if (trace) trace.timing.ttftMs = ms;
  }

  addToolCall(turnId: TurnId, toolName: string): void {
    const trace = this.turns.get(turnId);
    if (!trace) return;
    trace.toolCalls[toolName] = (trace.toolCalls[toolName] ?? 0) + 1;
    trace.totalToolCalls++;
  }

  setModel(turnId: TurnId, model: string, hop: number): void {
    const trace = this.turns.get(turnId);
    if (!trace) return;
    trace.selectedModel = model;
    trace.chainHops.push(model);
    trace.finalHopIndex = hop;
  }

  setQualityGate(turnId: TurnId, signals: string[], score: number): void {
    const trace = this.turns.get(turnId);
    if (!trace) return;
    trace.qualityGate = { triggered: true, signals, score };
  }

  addFallback(turnId: TurnId, from: string, reason: string): void {
    const trace = this.turns.get(turnId);
    if (!trace) return;
    const startMs = this.turnStartTimes.get(turnId) ?? trace.timestamp;
    trace.fallbacks.push({ from, reason, atMs: Date.now() - startMs });
  }

  addProviderAttempt(turnId: TurnId, entry: ProviderAttempt): void {
    const trace = this.turns.get(turnId);
    if (!trace) return;
    trace.providerAttempts.push(entry);
  }

  getReportData(): Readonly<ReportData> {
    const turns = this.recentTurns.slice();
    const modelStats = Array.from(this.modelAggregates.values()).map((a) => ({ ...a }));
    const latencies = turns.map((t) => t.timing.totalMs);
    const ttfts = turns.map((t) => t.timing.ttftMs).filter((v) => v > 0);

    const summary = {
      totalTurns: turns.length,
      totalToolCalls: turns.reduce((s, t) => s + t.totalToolCalls, 0),
      totalFallbacks: turns.reduce((s, t) => s + t.fallbacks.length, 0),
      totalQualityGates: turns.filter((t) => t.qualityGate.triggered).length,
      avgLatencyMs: latencies.length ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length) : 0,
      avgTTFTMs: ttfts.length ? Math.round(ttfts.reduce((s, v) => s + v, 0) / ttfts.length) : 0,
      p50LatencyMs: p50(latencies),
      p95LatencyMs: latencies.length >= MIN_PERCENTILE_SAMPLE ? p95(latencies) : -1,
      p99LatencyMs: latencies.length >= MIN_PERCENTILE_SAMPLE ? p99(latencies) : -1,
    };

    return Object.freeze({ turns: Object.freeze(turns) as readonly TurnTrace[], modelStats: Object.freeze(modelStats) as readonly ModelAggregate[], summary: Object.freeze(summary) }) as Readonly<ReportData>;
  }

  getSummary(): string {
    const { summary, modelStats } = this.getReportData();
    const s = summary;
    const lines: string[] = [
      `TierMux Profiler — ${s.totalTurns} turns`,
      `  Avg latency:  ${s.avgLatencyMs}ms`,
      `  Avg TTFT:     ${s.avgTTFTMs}ms`,
      `  P50 latency:  ${s.p50LatencyMs}ms`,
      s.p95LatencyMs >= 0 ? `  P95 latency:  ${s.p95LatencyMs}ms` : `  P95 latency:  --`,
      s.p99LatencyMs >= 0 ? `  P99 latency:  ${s.p99LatencyMs}ms` : `  P99 latency:  --`,
      `  Tool calls:   ${s.totalToolCalls}`,
      `  Fallbacks:    ${s.totalFallbacks}`,
      `  Quality gates: ${s.totalQualityGates}`,
    ];
    if (modelStats.length) {
      const top = modelStats.slice(0, 5);
      lines.push(`  Models: ${top.map((m) => `${m.modelId}(${m.turnCount})`).join(', ')}`);
    }
    return lines.join('\n');
  }

  toExportData(): ProfilerExport {
    const { turns, modelStats } = this.getReportData();
    return {
      schemaVersion: 1,
      tiermuxVersion: '',
      exportedAt: new Date().toISOString(),
      platform: process.platform,
      turns: turns.map((t) => ({ ...t })),
      modelStats: modelStats.map((m) => ({ ...m })),
    };
  }

  reset(opts?: { keepAggregates?: boolean }): void {
    this.turns.clear();
    this.turnStartTimes.clear();
    this.recentTurns.length = 0;
    this.timerStacks.clear();
    if (!opts?.keepAggregates) {
      this.modelAggregates.clear();
    }
  }

  private updateAggregates(trace: TurnTrace): void {
    const modelId = trace.selectedModel || 'unknown';
    let agg = this.modelAggregates.get(modelId);
    if (!agg) {
      agg = emptyAggregate(modelId);
      this.modelAggregates.set(modelId, agg);
    }
    agg.turnCount++;
    agg.totalAttempts += trace.providerAttempts.length;
    agg.successfulAttempts += trace.providerAttempts.filter((a) => a.status === 'ok').length;
    if (trace.timing.totalMs > 0) agg.latencies.push(trace.timing.totalMs);
    if (trace.timing.ttftMs > 0) agg.ttfts.push(trace.timing.ttftMs);
    agg.avgTotalLatencyMs = agg.latencies.length ? Math.round(agg.latencies.reduce((s, v) => s + v, 0) / agg.latencies.length) : 0;
    agg.avgTTFTMs = agg.ttfts.length ? Math.round(agg.ttfts.reduce((s, v) => s + v, 0) / agg.ttfts.length) : 0;
    agg.avgTokensPerSecond = trace.tokensPerSecond > 0 ? Math.round((agg.avgTokensPerSecond * (agg.turnCount - 1) + trace.tokensPerSecond) / agg.turnCount) : agg.avgTokensPerSecond;
    agg.avgToolCallsPerTurn = Math.round(((agg.avgToolCallsPerTurn * (agg.turnCount - 1) + trace.totalToolCalls) / agg.turnCount) * 10) / 10;
    agg.qualityGateRate = Math.round(((agg.qualityGateRate * (agg.turnCount - 1) + (trace.qualityGate.triggered ? 100 : 0)) / agg.turnCount) * 10) / 10;
    agg.fallbackRate = Math.round(((agg.fallbackRate * (agg.turnCount - 1) + (trace.fallbacks.length > 0 ? 100 : 0)) / agg.turnCount) * 10) / 10;
    agg.p50LatencyMs = p50(agg.latencies);
    agg.p95LatencyMs = agg.latencies.length >= MIN_PERCENTILE_SAMPLE ? p95(agg.latencies) : -1;
    agg.p99LatencyMs = agg.latencies.length >= MIN_PERCENTILE_SAMPLE ? p99(agg.latencies) : -1;
  }
}
