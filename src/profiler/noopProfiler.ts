import type { TurnId, IProfilerService, ProviderAttempt, BeginTurnOpts, EndTurnData, ReportData, ProfilerExport, TurnTrace, TimingPhase } from './types';

const emptyModelStats: [] = [] as unknown as [];
const emptyTurns: [] = [] as unknown as [];
const emptyReport: Readonly<ReportData> = Object.freeze({
  turns: emptyTurns,
  modelStats: emptyModelStats,
  summary: Object.freeze({
    totalTurns: 0, totalToolCalls: 0, totalFallbacks: 0,
    totalQualityGates: 0, avgLatencyMs: 0, avgTTFTMs: 0,
    p50LatencyMs: 0, p95LatencyMs: 0, p99LatencyMs: 0,
  }),
});

export class NoopProfiler implements IProfilerService {
  private noopId = 'noop-0' as TurnId;

  beginTurn(_opts: BeginTurnOpts): TurnId { return this.noopId; }
  endTurn(_turnId: TurnId, _data: EndTurnData): TurnTrace { return this.emptyTurn(); }
  timerStart(_turnId: TurnId, _phase: TimingPhase): void {}
  timerEnd(_turnId: TurnId, _phase: TimingPhase): number | undefined { return undefined; }
  recordTTFT(_turnId: TurnId, _ms: number): void {}
  addToolCall(_turnId: TurnId, _toolName: string): void {}
  setModel(_turnId: TurnId, _model: string, _hop: number): void {}
  setQualityGate(_turnId: TurnId, _signals: string[], _score: number): void {}
  addFallback(_turnId: TurnId, _from: string, _reason: string): void {}
  addProviderAttempt(_turnId: TurnId, _entry: ProviderAttempt): void {}
  getReportData(): Readonly<ReportData> { return emptyReport; }
  getSummary(): string { return 'TierMux Profiler is disabled. Enable tiermux.profiler.enabled to collect traces.'; }
  toExportData(): ProfilerExport { return { schemaVersion: 1, tiermuxVersion: '', exportedAt: '', platform: '', turns: [], modelStats: [] }; }
  reset(_opts?: { keepAggregates?: boolean }): void {}

  private emptyTurn(): TurnTrace {
    return {
      turnId: '', sessionId: '', mode: '', timestamp: 0,
      promptLength: 0, taskKind: '', containsMentions: false, containsAttachments: false,
      selectedModel: '', chainHops: [], finalHopIndex: 0,
      timing: { totalMs: 0, sessionSetupMs: 0, ttftMs: 0, providerMs: 0, routerMs: 0, toolMs: 0, qualityGateMs: 0, replayMs: 0, ocOverheadMs: 0 },
      totalTokens: 0, tokensPerSecond: 0, toolCalls: {}, totalToolCalls: 0,
      qualityGate: { triggered: false, signals: [], score: 0 },
      fallbacks: [], providerAttempts: [], timeline: [],
    };
  }
}
