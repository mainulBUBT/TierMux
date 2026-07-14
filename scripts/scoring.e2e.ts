/**
 * Smart Auto scoring engine — standalone verification.
 *
 * Bundles + runs under node (no VS Code) with fakes, exercising the seven
 * behaviors from the plan:
 *   1. cold start → order equals orderForTask
 *   2. balance rule: 98%-but-45s loses to 95%-but-5s
 *   3. short-window TTFT spike → demoted fast
 *   4. provider all-failing → its models sink below a healthy gateway
 *   5. tool_unsupported excludes for coding only
 *   6. small-sample confidence: n=3@100% does not outrank n=200@97%
 *   7. exploration only matters within the margin (deterministic here)
 */
import { ScoringEngine } from '../src/router/scoring';
import { MetricsStore } from '../src/router/metricsStore';
import { SCORING_CONFIG } from '../src/router/scoringConfig';
import { VISION_BLIND } from '../src/agent/answerQuality';
import type { Catalog } from '../src/catalog/catalog';
import type { CatalogModel, FallbackEntry, Platform } from '../src/shared/types';
import type * as vscode from 'vscode';

// ---- fakes ----

class FakeMemento implements vscode.Memento {
  private data: Record<string, unknown> = {};
  get<T>(key: string, defaultValue?: T): T {
    return (this.data[key] as T | undefined) ?? (defaultValue as T);
  }
  keys(): string[] {
    return Object.keys(this.data);
  }
  update(key: string, value: unknown): Thenable<void> {
    this.data[key] = value;
    return Promise.resolve();
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setKeysForSync(_keys: string[]): void { /* no-op */ }
}

function model(p: string, id: string, over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    platform: p as Platform,
    modelId: id,
    displayName: id,
    intelligenceRank: 3,
    speedRank: 3,
    sizeLabel: '',
    contextWindow: 32768,
    rpmLimit: null,
    rpdLimit: null,
    monthlyTokenBudget: '',
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    ...over,
  };
}

function fakeCatalog(models: CatalogModel[]): Catalog {
  return { find: (p: string, id: string) => models.find((m) => m.platform === p && m.modelId === id) } as unknown as Catalog;
}

function entry(p: string, id: string): FallbackEntry {
  return { platform: p as Platform, modelId: id, enabled: true, priority: 0 };
}

function rt(over: Partial<{ health: 'ok' | 'half-open' | 'bad'; canSend: boolean; hasKey: boolean; capable: boolean }> = {}) {
  return { health: 'ok' as const, canSend: true, hasKey: true, capable: true, ...over };
}

// ---- test harness ----

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function freshEngine(models: CatalogModel[]): { engine: ScoringEngine; metrics: MetricsStore } {
  const metrics = new MetricsStore(new FakeMemento());
  const engine = new ScoringEngine(fakeCatalog(models), metrics);
  return { engine, metrics };
}

function rank(
  engine: ScoringEngine,
  kind: any,
  entries: FallbackEntry[],
  runtime: Map<string, any>,
  requireTools = false,
  isVision = false,
  rng: () => number = () => 1,
) {
  return engine.rank({ taskKind: kind, entries, runtime, requireTools, isVision }, rng).ordered;
}

// Seed N samples into a model+task aggregate (success + a ttft/total profile).
// Uses real time (no `now` arg) so samples land contiguously — wall-clock decay
// is exercised by the store's half-life in real usage, not by synthetic jumps.
function seed(metrics: MetricsStore, p: string, id: string, kind: string, n: number, opts: { okPct?: number; ttft?: number; total?: number; ratePct?: number } = {}): void {
  const { okPct = 1, ttft = 1000, total = 3000, ratePct = 0 } = opts;
  for (let i = 0; i < n; i++) {
    const ok = i / n < okPct;
    const rateLimited = i / n < ratePct;
    metrics.record(p, id, kind, { ok, ttftMs: ttft, totalMs: total, rateLimited, failureType: ok ? undefined : 'http_5xx' });
  }
}

// ---- tests ----

function test_coldStartMatchesOrderForTask(): void {
  console.log('1. cold start → order tracks catalog fitness');
  const models = [
    model('groq', 'fast-a', { speedRank: 1, intelligenceRank: 4 }),
    model('groq', 'fast-b', { speedRank: 2, intelligenceRank: 4 }),
    model('openrouter', 'smart', { speedRank: 5, intelligenceRank: 1 }),
  ];
  const { engine } = freshEngine(models);
  const entries = [entry('groq', 'fast-a'), entry('groq', 'fast-b'), entry('openrouter', 'smart')];
  const runtime = new Map([['groq::fast-a', rt()], ['groq::fast-b', rt()], ['openrouter::smart', rt()]]);
  // trivial → speed-first: fast-a should win
  const ordered = rank(engine, 'trivial', entries, runtime);
  assert(ordered[0].modelId === 'fast-a', 'trivial cold start picks fastest (fast-a)');
}

function test_balanceRule(): void {
  console.log('2. balance rule: reliable-but-slow loses to slightly-less-reliable-but-fast');
  const models = [
    model('a', 'slow-reliable', { speedRank: 3, intelligenceRank: 3 }),
    model('b', 'fast-slightly-less', { speedRank: 2, intelligenceRank: 3 }),
  ];
  const { engine, metrics } = freshEngine(models);
  // 98% success but 45s; vs 95% but 1.2s
  seed(metrics, 'a', 'slow-reliable', 'chat', 100, { okPct: 0.98, ttft: 8000, total: 45000 });
  seed(metrics, 'b', 'fast-slightly-less', 'chat', 100, { okPct: 0.95, ttft: 400, total: 1200 });
  const entries = [entry('a', 'slow-reliable'), entry('b', 'fast-slightly-less')];
  const runtime = new Map([['a::slow-reliable', rt()], ['b::fast-slightly-less', rt()]]);
  const ordered = rank(engine, 'chat', entries, runtime);
  assert(ordered[0].modelId === 'fast-slightly-less', 'fast 95% beats slow 98% (balance rule)');
}

function test_tftfSpikeDemotesFast(): void {
  console.log('3. short-window TTFT spike above baseline demotes quickly');
  const models = [model('g', 'stable', { speedRank: 2 }), model('g', 'spiking', { speedRank: 1 })];
  const { engine, metrics } = freshEngine(models);
  // spiking: long baseline ~1s, then several slow samples (fast EWMA jumps)
  seed(metrics, 'g', 'spiking', 'chat', 20, { ttft: 1000, total: 3000 });
  for (let i = 0; i < 8; i++) metrics.record('g', 'spiking', 'chat', { ok: true, ttftMs: 9000, totalMs: 20000, rateLimited: false });
  seed(metrics, 'g', 'stable', 'chat', 20, { ttft: 1100, total: 3200 });
  const entries = [entry('g', 'spiking'), entry('g', 'stable')];
  const runtime = new Map([['g::spiking', rt()], ['g::stable', rt()]]);
  const ordered = rank(engine, 'chat', entries, runtime);
  assert(ordered[0].modelId === 'stable', 'drifted model demoted within ~8 samples');
}

function test_providerCollapse(): void {
  console.log('4. provider all-failing sinks its models below a healthy gateway');
  const models = [
    model('sick', 'm1', { speedRank: 1, intelligenceRank: 2 }),
    model('sick', 'm2', { speedRank: 2, intelligenceRank: 2 }),
    model('healthy', 'm3', { speedRank: 3, intelligenceRank: 2 }),
  ];
  const { engine, metrics } = freshEngine(models);
  seed(metrics, 'sick', 'm1', 'chat', 50, { okPct: 0.2 });
  seed(metrics, 'sick', 'm2', 'chat', 50, { okPct: 0.2 });
  seed(metrics, 'healthy', 'm3', 'chat', 50, { okPct: 0.99 });
  // Provider-level aggregate for 'sick' is also fed by recording m1/m2 above (providerKey).
  const entries = [entry('sick', 'm1'), entry('sick', 'm2'), entry('healthy', 'm3')];
  const runtime = new Map([['sick::m1', rt()], ['sick::m2', rt()], ['healthy::m3', rt()]]);
  const ordered = rank(engine, 'chat', entries, runtime);
  assert(ordered[0].platform === 'healthy', 'healthy-gateway model wins despite worse catalog speed');
}

function test_toolUnsupportedCodingOnly(): void {
  console.log('5. tool_unsupported excludes for coding, not for chat');
  const models = [model('p', 'withtools', { supportsTools: true }), model('p', 'notools', { supportsTools: false })];
  const { engine, metrics } = freshEngine(models);
  // Record tool_unsupported failures for notools on coding.
  for (let i = 0; i < 10; i++) metrics.record('p', 'notools', 'coding', { ok: false, failureType: 'tool_unsupported', totalMs: 1000, rateLimited: false }, i * 60_000);
  const entries = [entry('p', 'notools'), entry('p', 'withtools')];
  const codingRt = new Map([['p::notools', rt({ capable: false })], ['p::withtools', rt()]]);
  const orderedCoding = rank(engine, 'coding', entries, codingRt, true);
  assert(orderedCoding[0].modelId === 'withtools', 'notools excluded for coding');
  // For chat (no requireTools), capable stays true for both → notools not excluded by capability.
  const chatRt = new Map([['p::notools', rt()], ['p::withtools', rt()]]);
  const orderedChat = rank(engine, 'chat', entries, chatRt, false);
  assert(orderedChat.includes(entries[0]) && orderedChat.includes(entries[1]), 'notools still considered for chat');
}

function test_smallSampleConfidence(): void {
  console.log('6. small-sample confidence: n=3@100% does not outrank n=200@97%');
  const models = [model('x', 'tiny', { speedRank: 2 }), model('y', 'proven', { speedRank: 2 })];
  const { engine, metrics } = freshEngine(models);
  seed(metrics, 'x', 'tiny', 'chat', 3, { okPct: 1.0, ttft: 1000, total: 3000 });
  seed(metrics, 'y', 'proven', 'chat', 200, { okPct: 0.97, ttft: 1000, total: 3000 });
  const entries = [entry('x', 'tiny'), entry('y', 'proven')];
  const runtime = new Map([['x::tiny', rt()], ['y::proven', rt()]]);
  const res = engine.rank({ taskKind: 'chat' as any, entries, runtime, requireTools: false, isVision: false }, () => 0);
  for (const r of res.rationale) console.log(`     ${r.modelId}: cap=${r.capability.toFixed(2)} runtime=×${r.runtimeMultiplier.toFixed(2)} score=${r.score.toFixed(3)} conf=${r.confidence.toFixed(2)} | ${r.reason}`);
  const ordered = res.ordered;
  assert(ordered[0].modelId === 'proven', 'proven 97% (n=200) beats tiny 100% (n=3)');
}

function test_explorationDeterministic(): void {
  console.log('7. exploration only perturbs a tie (rng=0 → best stays first)');
  const models = [model('p', 'a', { speedRank: 1 }), model('p', 'b', { speedRank: 2 })];
  const { engine } = freshEngine(models);
  const entries = [entry('p', 'a'), entry('p', 'b')];
  const runtime = new Map([['p::a', rt()], ['p::b', rt()]]);
  const ordered = rank(engine, 'trivial', entries, runtime, false, false, () => 0);
  assert(ordered[0].modelId === 'a', 'rng=0 keeps clear winner first');
}

function test_visionPrefersStrongDirectModel(): void {
  console.log('8. vision: strong direct model beats weak-but-fast and aggregator, text-only excluded');
  const models = [
    model('openrouter', 'auto', { supportsVision: true, intelligenceRank: 1, speedRank: 1, tags: ['router'] }), // aggregator claims vision
    model('g', 'weak-vlm', { supportsVision: true, intelligenceRank: 5, speedRank: 1 }),   // fast but weak
    model('o', 'strong-vlm', { supportsVision: true, intelligenceRank: 1, speedRank: 4 }), // slower but smart
    model('t', 'text-only', { supportsVision: false, intelligenceRank: 1, speedRank: 1 }), // no vision
  ];
  const { engine } = freshEngine(models);
  const entries = [entry('openrouter', 'auto'), entry('g', 'weak-vlm'), entry('o', 'strong-vlm'), entry('t', 'text-only')];
  // capable mirrors buildSelectionContext for a vision turn: only supportsVision models are capable.
  const runtime = new Map(entries.map((e) => {
    const m = models.find((x) => x.platform === e.platform && x.modelId === e.modelId)!;
    return [`${e.platform}::${e.modelId}`, rt({ capable: !!m.supportsVision })] as const;
  }));
  const ordered = rank(engine, 'vision', entries, runtime, false, true);
  assert(ordered[0].modelId === 'strong-vlm', 'strong direct vision model wins (intelligence-weighted)');
  assert(ordered[0].modelId !== 'auto', 'aggregator does not win vision');
  assert(ordered[ordered.length - 1].modelId === 'text-only', 'text-only vision-incapable model ranked last');
}

function test_visionBlindDemotes(): void {
  console.log('9. vision-blind: VISION_BLIND regex + recorded vision failures demote the model');
  assert(VISION_BLIND.test("I'm sorry, but I can't see the image you attached."), 'matches "can\'t see the image"');
  assert(VISION_BLIND.test('As a text-based AI, I cannot view screenshots.'), 'matches "text-based AI"');
  assert(VISION_BLIND.test('My capabilities are limited to text, so I cannot interpret the picture.'), 'matches "limited to text"');
  assert(!VISION_BLIND.test('The screenshot shows a Store Settings page with a Store-Managed Delivery toggle enabled.'), 'does NOT match a real image description');
  // Learned demotion: router.ts records ok:false for vision-blind completions — a model that
  // keeps doing so must rank below a clean vision model on the next vision turn.
  const models = [
    model('a', 'blind-vlm', { supportsVision: true, intelligenceRank: 1, speedRank: 1 }),
    model('b', 'clean-vlm', { supportsVision: true, intelligenceRank: 1, speedRank: 1 }),
  ];
  const { engine, metrics } = freshEngine(models);
  seed(metrics, 'a', 'blind-vlm', 'vision', 20, { okPct: 0.2 }); // repeated vision-blind failures
  seed(metrics, 'b', 'clean-vlm', 'vision', 20, { okPct: 0.99 });
  const entries = [entry('a', 'blind-vlm'), entry('b', 'clean-vlm')];
  const runtime = new Map(entries.map((e) => [`${e.platform}::${e.modelId}`, rt()] as const));
  const ordered = rank(engine, 'vision', entries, runtime, false, true);
  assert(ordered[0].modelId === 'clean-vlm', 'vision-blind model demoted below the clean vision model');
}

// ---- run ----

console.log(`SCORING_CONFIG: minSamples=${SCORING_CONFIG.minSamples} speedFloorRatio=${SCORING_CONFIG.speedFloorRatio} explorationMargin=${SCORING_CONFIG.explorationMargin}\n`);
test_coldStartMatchesOrderForTask();
test_balanceRule();
test_tftfSpikeDemotesFast();
test_providerCollapse();
test_toolUnsupportedCodingOnly();
test_smallSampleConfidence();
test_explorationDeterministic();
test_visionPrefersStrongDirectModel();
test_visionBlindDemotes();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
