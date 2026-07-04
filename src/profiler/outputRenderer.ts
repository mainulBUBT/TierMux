import type { ReportData, TurnTraceTiming } from './types';

const TIMING_FIELDS: Array<{ key: keyof TurnTraceTiming; label: string }> = [
  { key: 'providerMs', label: 'Provider' },
  { key: 'toolMs', label: 'Tool Execution' },
  { key: 'ocOverheadMs', label: 'OC Overhead' },
  { key: 'routerMs', label: 'Router' },
  { key: 'sessionSetupMs', label: 'Session Setup' },
  { key: 'qualityGateMs', label: 'Quality Gate' },
  { key: 'replayMs', label: 'Replay' },
];

function msStr(n: number): string {
  if (n < 1000) return `${n}ms`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n / 1000)}s`;
}

function toolStr(toolCalls: Record<string, number>): string {
  const total = Object.values(toolCalls).reduce((s, v) => s + v, 0);
  if (!total) return '0';
  const parts = Object.entries(toolCalls)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([n, c]) => `${n.slice(0, 1)}:${c}`);
  return parts.length ? `${total}(${parts.join(',')})` : `${total}`;
}

function pctOf(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function bar(part: number, total: number): string {
  const pct = pctOf(part, total);
  const chars = Math.round(pct / 2);
  return '█'.repeat(Math.min(chars, 40));
}

function truncate(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

export function render(report: Readonly<ReportData>): string {
  const { turns, modelStats, summary } = report;
  const lines: string[] = [];
  lines.push('═══ TierMux Profiler ═══');
  lines.push(`Turns: ${summary.totalTurns}`);
  lines.push('');

  if (!turns.length) {
    lines.push('No traces yet. Send a message to collect data.');
    return lines.join('\n');
  }

  lines.push('── Highlights ──');
  const slowest = turns.reduce((max, t) => (t.timing.totalMs > max.timing.totalMs ? t : max), turns[0]);
  const fastest = turns.reduce((min, t) => (t.timing.totalMs < min.timing.totalMs ? t : min), turns[0]);
  lines.push(`Slowest:        ${slowest.mode} / ${truncate(slowest.selectedModel, 30)} / ${msStr(slowest.timing.totalMs)} / ${slowest.totalToolCalls} tools`);
  lines.push(`Fastest:        ${fastest.mode} / ${truncate(fastest.selectedModel, 30)} / ${msStr(fastest.timing.totalMs)} / ${fastest.totalToolCalls} tools`);

  const worstTTFT = turns.reduce((max, t) => (t.timing.ttftMs > max.timing.ttftMs ? t : max), turns[0]);
  if (worstTTFT.timing.ttftMs > 0) {
    lines.push(`Worst TTFT:     ${truncate(worstTTFT.selectedModel, 30)} (${msStr(worstTTFT.timing.ttftMs)})`);
  }

  if (summary.totalFallbacks > 0) {
    const fbkModel = modelStats.reduce((max, m) => (m.fallbackRate > max.fallbackRate ? m : max), modelStats[0]);
    lines.push(`Most fallback:  ${truncate(fbkModel.modelId, 30)} (${fbkModel.fallbackRate}% rate)`);
  }

  const allTools = new Map<string, number>();
  for (const t of turns) {
    for (const [name, count] of Object.entries(t.toolCalls)) {
      allTools.set(name, (allTools.get(name) ?? 0) + count);
    }
  }
  const topTool = Array.from(allTools.entries()).sort((a, b) => b[1] - a[1])[0];
  if (topTool) {
    lines.push(`Top tool:       ${topTool[0]} (${topTool[1]} calls)`);
  }

  if (summary.totalQualityGates > 0) {
    const qgPct = summary.totalTurns ? Math.round((summary.totalQualityGates / summary.totalTurns) * 100) : 0;
    const qgModels = turns.filter((t) => t.qualityGate.triggered).map((t) => t.selectedModel);
    const uniqueQg = new Set(qgModels);
    lines.push(`Quality gates:  ${summary.totalQualityGates} of ${summary.totalTurns} turns (${qgPct}%) — ${Array.from(uniqueQg).join(', ')}`);
  }

  lines.push('');
  lines.push('── Latency Distribution ──');
  const p50 = summary.p50LatencyMs;
  const p95 = summary.p95LatencyMs >= 0 ? msStr(summary.p95LatencyMs) : '--';
  const p99 = summary.p99LatencyMs >= 0 ? msStr(summary.p99LatencyMs) : '--';
  const needMore = summary.totalTurns < 20 ? ' (need ≥ 20 turns for reliable P95/P99)' : '';
  lines.push(`P50: ${msStr(p50)}  P95: ${p95}  P99: ${p99}${needMore}`);

  lines.push('');
  lines.push('── Per-Turn ──');
  lines.push('#  Mode   Model                  Tools          TTFT  Total   TPS  QG  Fbk');
  for (let i = 0; i < Math.min(turns.length, 20); i++) {
    const t = turns[i];
    const qg = t.qualityGate.triggered ? '✓' : '✗';
    const fb = t.fallbacks.length > 0 ? '✓' : '✗';
    lines.push(`${String(i + 1).padEnd(2)} ${t.mode.padEnd(6)} ${truncate(t.selectedModel, 22).padEnd(22)} ${toolStr(t.toolCalls).padEnd(10)} ${msStr(t.timing.ttftMs).padEnd(5)} ${msStr(t.timing.totalMs).padEnd(6)} ${String(t.tokensPerSecond).padEnd(4)} ${qg}   ${fb}`);
  }

  lines.push('');
  lines.push('── Per-Model ──');
  lines.push('Model                                    Turn  Att  OK  Avg     TTFT   TPS   Tools QG%  Fbk%');
  for (const m of modelStats.slice(0, 10)) {
    const okStr = `${m.successfulAttempts}/${m.totalAttempts}`;
    lines.push(`${truncate(m.modelId, 40).padEnd(40)} ${String(m.turnCount).padEnd(4)} ${String(m.totalAttempts).padEnd(3)} ${okStr.padEnd(3)} ${msStr(m.avgTotalLatencyMs).padEnd(6)} ${msStr(m.avgTTFTMs).padEnd(5)} ${String(m.avgTokensPerSecond).padEnd(4)} ${String(m.avgToolCallsPerTurn).padEnd(4)} ${String(m.qualityGateRate).padEnd(3)} ${String(m.fallbackRate).padEnd(4)}`);
  }

  if (turns.length > 0) {
    lines.push('');
    lines.push('── Phase Breakdown (avg across all turns) ──');
    const avgTiming: TurnTraceTiming = {
      totalMs: 0, sessionSetupMs: 0, ttftMs: 0, providerMs: 0, routerMs: 0, toolMs: 0, qualityGateMs: 0, replayMs: 0, ocOverheadMs: 0,
    };
    for (const t of turns) {
      for (const { key } of TIMING_FIELDS) {
        avgTiming[key] += t.timing[key];
      }
    }
    for (const { key } of TIMING_FIELDS) {
      avgTiming[key] = Math.round(avgTiming[key] / turns.length);
    }
    const total = turns.reduce((s, t) => s + t.timing.totalMs, 0) / turns.length;
    for (const { key, label } of TIMING_FIELDS) {
      const pct = pctOf(avgTiming[key], total);
      const b = bar(avgTiming[key], total);
      lines.push(`${label.padEnd(15)} ${b.padEnd(40)} ${String(pct).padStart(3)}%  (${msStr(avgTiming[key])})`);
    }

    const last = turns[0];
    if (last.timeline.length > 0) {
      lines.push('');
      lines.push(`── Timeline (last turn, ${last.mode} / ${truncate(last.selectedModel, 25)} / ${msStr(last.timing.totalMs)}) ──`);
      for (const e of last.timeline) {
        const dur = e.durationMs > 0 ? ` (${msStr(e.durationMs)})` : '';
        lines.push(`  ${msStr(e.startMs).padEnd(6)} ─┤ ${e.label}${dur}`);
      }
      lines.push(`  ${msStr(last.timing.totalMs).padEnd(6)} ─┤ session.idle`);
    }
  }

  return lines.join('\n');
}
