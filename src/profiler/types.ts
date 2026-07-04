export type TurnId = string;
export type TimingPhase = 'Provider' | 'Router' | 'SessionSetup' | 'Tool' | 'QualityGate' | 'Replay' | 'OCOverhead';

export type ErrorType =
  | 'timeout' | 'ratelimit' | 'network' | 'auth'
  | 'not_found' | 'bad_request' | 'empty_response'
  | 'paid_only' | 'server_error' | 'unknown';

export interface TurnTraceTiming {
  totalMs: number;
  sessionSetupMs: number;
  ttftMs: number;
  providerMs: number;
  routerMs: number;
  toolMs: number;
  qualityGateMs: number;
  replayMs: number;
  ocOverheadMs: number;
}

export interface TurnTrace {
  turnId: string;
  sessionId: string;
  mode: string;
  timestamp: number;
  promptLength: number;
  taskKind: string;
  containsMentions: boolean;
  containsAttachments: boolean;
  selectedModel: string;
  chainHops: string[];
  finalHopIndex: number;
  timing: TurnTraceTiming;
  totalTokens: number;
  tokensPerSecond: number;
  toolCalls: Record<string, number>;
  totalToolCalls: number;
  qualityGate: { triggered: boolean; signals: string[]; score: number };
  fallbacks: Array<{ from: string; reason: string; atMs: number }>;
  providerAttempts: Array<{
    platform: string;
    model: string;
    status: 'ok' | 'fail';
    latencyMs: number;
    errorType?: ErrorType;
    reason?: string;
  }>;
  timeline: Array<{
    phase: TimingPhase;
    label: string;
    startMs: number;
    durationMs: number;
  }>;
}

export interface ModelAggregate {
  modelId: string;
  turnCount: number;
  totalAttempts: number;
  successfulAttempts: number;
  avgTotalLatencyMs: number;
  avgTTFTMs: number;
  avgTokensPerSecond: number;
  avgToolCallsPerTurn: number;
  qualityGateRate: number;
  fallbackRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  latencies: number[];
  ttfts: number[];
}

export interface ReportData {
  readonly turns: readonly TurnTrace[];
  readonly modelStats: readonly ModelAggregate[];
  readonly summary: {
    readonly totalTurns: number;
    readonly totalToolCalls: number;
    readonly totalFallbacks: number;
    readonly totalQualityGates: number;
    readonly avgLatencyMs: number;
    readonly avgTTFTMs: number;
    readonly p50LatencyMs: number;
    readonly p95LatencyMs: number;
    readonly p99LatencyMs: number;
  };
}

export interface ProfilerExport {
  schemaVersion: 1;
  tiermuxVersion: string;
  exportedAt: string;
  platform: string;
  turns: TurnTrace[];
  modelStats: ModelAggregate[];
}

export interface ProviderAttempt {
  platform: string;
  model: string;
  status: 'ok' | 'fail';
  latencyMs: number;
  errorType?: ErrorType;
  reason?: string;
}

export interface BeginTurnOpts {
  sessionId: string;
  mode: string;
  promptLength: number;
  taskKind: string;
  containsMentions: boolean;
  containsAttachments: boolean;
}

export interface EndTurnData {
  model: string;
  hop: number;
  tokens: { prompt: number; completion: number; total: number };
}

export interface IProfilerService {
  beginTurn(opts: BeginTurnOpts): TurnId;
  endTurn(turnId: TurnId, data: EndTurnData): TurnTrace;
  timerStart(turnId: TurnId, phase: TimingPhase): void;
  timerEnd(turnId: TurnId, phase: TimingPhase): number | undefined;
  recordTTFT(turnId: TurnId, ms: number): void;
  addToolCall(turnId: TurnId, toolName: string): void;
  setModel(turnId: TurnId, model: string, hop: number): void;
  setQualityGate(turnId: TurnId, signals: string[], score: number): void;
  addFallback(turnId: TurnId, from: string, reason: string): void;
  addProviderAttempt(turnId: TurnId, entry: ProviderAttempt): void;
  getReportData(): Readonly<ReportData>;
  getSummary(): string;
  toExportData(): ProfilerExport;
  reset(opts?: { keepAggregates?: boolean }): void;
}
