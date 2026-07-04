// Smoke test for the profiler — exercises core API without VS Code
// Run: npx ts-node scripts/profilerSmoke.ts  (or: node --loader ts-node/esm ...)
// Or: esbuild scripts/profilerSmoke.ts --bundle --platform=node --format=cjs --outfile=dist/profilerSmoke.cjs && node dist/profilerSmoke.cjs

import { LiveProfiler } from '../src/profiler/liveProfiler';
import { NoopProfiler } from '../src/profiler/noopProfiler';
import { render } from '../src/profiler/outputRenderer';
import type { IProfilerService, BeginTurnOpts } from '../src/profiler/types';

function assert(condition: boolean, label: string): void {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  ✓ ${label}`);
}

function test(name: string, fn: () => void): void {
  console.log(`\n── ${name} ──`);
  fn();
}

function fakeBeginTurn(opts: Partial<BeginTurnOpts> = {}): BeginTurnOpts {
  return {
    sessionId: opts.sessionId ?? 'test-session',
    mode: opts.mode ?? 'chat',
    promptLength: opts.promptLength ?? 50,
    taskKind: opts.taskKind ?? 'chat',
    containsMentions: opts.containsMentions ?? false,
    containsAttachments: opts.containsAttachments ?? false,
  };
}

test('NoopProfiler', () => {
  const p: IProfilerService = new NoopProfiler();
  let turnId = p.beginTurn(fakeBeginTurn());
  assert(typeof turnId === 'string', 'beginTurn returns string');
  p.timerStart(turnId, 'Provider');
  p.timerEnd(turnId, 'Provider');
  p.addToolCall(turnId, 'read');
  p.addToolCall(turnId, 'grep');
  p.addToolCall(turnId, 'grep');
  p.setModel(turnId, 'fast', 0);
  p.setQualityGate(turnId, ['refusal'], 100);
  p.addFallback(turnId, 'tiermux/fast', 'no_answer');
  p.recordTTFT(turnId, 1200);
  const trace = p.endTurn(turnId, { model: 'fast', hop: 0, tokens: { prompt: 100, completion: 200, total: 300 } });
  assert(trace.turnId === '', 'noop trace has empty turnId');
  assert(trace.totalTokens === 0, 'noop trace has zero tokens');
  const report = p.getReportData();
  assert(report.turns.length === 0, 'noop report has zero turns');
  const summary = p.getSummary();
  assert(summary.includes('Profiler is disabled'), 'noop summary mentions disabled');
  const exported = p.toExportData();
  assert(exported.turns.length === 0, 'noop export has zero turns');
  console.log('  All noop tests passed (zero overhead when disabled)');
});

test('LiveProfiler — basic turn', () => {
  const p = new LiveProfiler(200);
  const turnId = p.beginTurn(fakeBeginTurn({ mode: 'chat', taskKind: 'chat' }));

  p.setModel(turnId, 'groq::llama-3.3-70b', 0);
  p.timerStart(turnId, 'Provider');
  // Simulate 2.5s LLM call
  const fakeLatency = 2500;
  p.timerEnd(turnId, 'Provider');
  p.recordTTFT(turnId, 800);
  p.timerStart(turnId, 'Tool');
  p.timerEnd(turnId, 'Tool');
  // recordTTFT is a milestone, not phase-timed — already called above

  // Simulate a tool being called (never called since recordTTFT tracks TTFT, but
  // tool calls use addToolCall separately
  p.addToolCall(turnId, 'grep');

  const trace = p.endTurn(turnId, { model: 'groq::llama-3.3-70b', hop: 0, tokens: { prompt: 100, completion: 200, total: 300 } });

  assert(trace.mode === 'chat', 'trace records mode');
  assert(trace.totalToolCalls === 1, 'trace records tool call count');
  assert(trace.toolCalls['grep'] === 1, 'trace records specific tool name');
  assert(trace.timing.totalMs >= 0, 'trace has total time >= 0 (zero ms when synchronous)');
  assert(trace.timing.ttftMs === 800, 'trace records TTFT');
  assert(trace.timing.providerMs >= 0, 'trace records provider time (zero when synchronous)');
  assert(trace.timing.toolMs >= 0, 'trace records tool time (zero when synchronous)');
  assert(trace.promptLength === 50, 'trace records prompt length (privacy-safe)');
  assert(trace.containsMentions === false, 'trace records mentions');
  assert(trace.totalTokens === 300, 'trace records total tokens');

  const report = p.getReportData();
  assert(report.turns.length === 1, 'report has 1 turn');
  assert(report.summary.totalTurns === 1, 'report summary correct');
  assert(report.modelStats.length >= 1, 'report has model stats');
});

test('LiveProfiler — quality gate + fallback', () => {
  const p = new LiveProfiler(200);
  const turnId = p.beginTurn(fakeBeginTurn({ mode: 'agent', taskKind: 'agent', promptLength: 200 }));

  p.setModel(turnId, 'pollinations::openai-fast', 0);
  p.setQualityGate(turnId, ['refusal', 'too_short'], 115); // score 115 > threshold 40
  p.addFallback(turnId, 'tiermux/fast', 'weak_answer');
  p.addToolCall(turnId, 'glob');
  p.addToolCall(turnId, 'grep');

  const trace = p.endTurn(turnId, { model: 'chutes::step-3.7-flash', hop: 1, tokens: { prompt: 300, completion: 500, total: 800 } });

  assert(trace.qualityGate.triggered === true, 'quality gate recorded');
  assert(trace.qualityGate.signals.length > 0, 'quality gate signals recorded');
  assert(trace.qualityGate.score > 0, 'quality gate score recorded');
  assert(trace.fallbacks.length === 1, 'fallback recorded');
  assert(trace.fallbacks[0].reason === 'weak_answer', 'fallback reason correct');
  assert(trace.finalHopIndex === 1, 'final hop correct');
});

test('LiveProfiler — report rendering', () => {
  const p = new LiveProfiler(200);

  // Add 3 turns
  for (let i = 0; i < 3; i++) {
    const id = p.beginTurn(fakeBeginTurn({ mode: i === 0 ? 'chat' : 'agent', taskKind: i === 0 ? 'chat' : 'agent' }));
    p.setModel(id, `model-${i}`, 0);
    p.timerStart(id, 'Provider');
    p.timerEnd(id, 'Provider');
    p.recordTTFT(id, 500 + i * 200);
    if (i > 0) { p.addToolCall(id, 'read'); p.addToolCall(id, 'grep'); }
    p.endTurn(id, { model: `model-${i}`, hop: 0, tokens: { prompt: 100, completion: 200, total: 300 } });
  }

  const report = p.getReportData();
  const output = render(report);

  assert(output.includes('═══ TierMux Profiler'), 'report has header');
  assert(output.includes('Highlights'), 'report has highlights section');
  assert(output.includes('Per-Turn'), 'report has per-turn table');
  assert(output.includes('Per-Model'), 'report has per-model section');
  assert(output.includes('Phase Breakdown'), 'report has phase breakdown');
  assert(output.includes('P50'), 'report has latency percentiles');

  // Verify summary
  const summary = p.getSummary();
  assert(summary.includes('TierMux Profiler'), 'summary has header');
  assert(summary.includes('Avg latency'), 'summary has avg latency');
  assert(summary.includes('Tool calls'), 'summary has tool calls');
});

test('LiveProfiler — export', () => {
  const p = new LiveProfiler(200);
  const id = p.beginTurn(fakeBeginTurn());
  p.setModel(id, 'test-model', 0);
  p.endTurn(id, { model: 'test-model', hop: 0, tokens: { prompt: 100, completion: 200, total: 300 } });

  const exported = p.toExportData();
  assert(exported.schemaVersion === 1, 'export has schemaVersion');
  assert(exported.platform !== '', 'export has platform');
  assert(exported.exportedAt !== '', 'export has timestamp');
  assert(exported.turns.length === 1, 'export has turns');
  assert(exported.modelStats.length >= 1, 'export has model stats');
});

test('LiveProfiler — reset', () => {
  const p = new LiveProfiler(200);
  const id = p.beginTurn(fakeBeginTurn());
  p.setModel(id, 'test-model', 0);
  p.endTurn(id, { model: 'test-model', hop: 0, tokens: { prompt: 100, completion: 200, total: 300 } });

  assert(p.getReportData().turns.length === 1, 'before reset: 1 turn');
  p.reset();
  assert(p.getReportData().turns.length === 0, 'after reset: 0 turns');
  assert(p.getReportData().modelStats.length === 0, 'after reset: 0 model stats');
});

test('LiveProfiler — ring buffer', () => {
  const p = new LiveProfiler(5); // small ring
  for (let i = 0; i < 10; i++) {
    const id = p.beginTurn(fakeBeginTurn({ sessionId: `s${i}` }));
    p.setModel(id, 'm', 0);
    p.endTurn(id, { model: 'm', hop: 0, tokens: { prompt: 10, completion: 20, total: 30 } });
  }
  const report = p.getReportData();
  assert(report.turns.length === 5, 'ring buffer caps at 5');
});

test('LiveProfiler — privacy (no userText)', () => {
  const p = new LiveProfiler(200);
  // Use a long prompt to verify we don't store it
  const longPrompt = 'This is a very long user message that should not be stored in the profiler for privacy reasons. It contains potentially sensitive information.';
  const id = p.beginTurn(fakeBeginTurn({ promptLength: longPrompt.length }));
  p.setModel(id, 'm', 0);
  const trace = p.endTurn(id, { model: 'm', hop: 0, tokens: { prompt: 10, completion: 20, total: 30 } });

  assert(trace.promptLength === longPrompt.length, 'stores prompt length only');
  // Verify no userText field exists on TurnTrace type (compile-time check already passed)
  assert(!('userText' in trace), 'no userText field in trace');
});

test('LiveProfiler — nested timing', () => {
  const p = new LiveProfiler(200);
  const id = p.beginTurn(fakeBeginTurn());

  p.timerStart(id, 'Provider');
  p.timerStart(id, 'Tool');       // nested OK — different phases
  p.timerEnd(id, 'Tool');
  p.timerEnd(id, 'Provider');

  const trace = p.endTurn(id, { model: 'm', hop: 0, tokens: { prompt: 10, completion: 20, total: 30 } });

  assert(trace.timing.providerMs >= 0, 'provider timing recorded');
  assert(trace.timing.toolMs >= 0, 'tool timing recorded');
  // In production with real LLM calls, providerMs > toolMs when nested.
  // Synchronous tests produce zero values — still structurally correct.
});

console.log('\n═══ All profiler smoke tests passed ═══');
