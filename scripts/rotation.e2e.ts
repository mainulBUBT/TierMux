// Quota-aware tied-band rotation in ScoringEngine.rank(): statistically-tied candidates take
// deterministic turns (least-recently-served first, headroom breaking ties) instead of one
// model eating every request until it 429s. Covers: alternation across calls, quota-pressure
// trigger firing deterministically (rng disabled), no rotation outside the margin, and the
// never-served model winning the first exploration turn.
//
// Run:  npm run test:e2e:rotation
import { ScoringEngine } from '../src/router/scoring';
import { MetricsStore } from '../src/router/metricsStore';
import type { Catalog } from '../src/catalog/catalog';
import type { CatalogModel, FallbackEntry, Platform } from '../src/shared/types';
import type * as vscode from 'vscode';
import type { TaskKind } from '../src/agent/routing';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

function model(p: string, id: string): CatalogModel {
  return {
    platform: p as Platform, modelId: id, displayName: id,
    intelligenceRank: 3, speedRank: 3, sizeLabel: '', contextWindow: 32768,
    rpmLimit: null, rpdLimit: null, monthlyTokenBudget: '',
    supportsTools: true, supportsVision: false, supportsReasoning: false,
  };
}

function mem(): vscode.Memento {
  const data: Record<string, unknown> = {};
  return {
    get: <T,>(k: string, d?: T): T => (data[k] as T) ?? (d as T),
    keys: () => Object.keys(data),
    update: (k: string, v: unknown) => { data[k] = v; return Promise.resolve(); },
    setKeysForSync: () => {},
  } as unknown as vscode.Memento;
}

const MODELS = [model('p', 'a'), model('p', 'b'), model('p', 'c')];
const catalog: Partial<Catalog> = { find: (p, id) => MODELS.find((m) => m.platform === p && m.modelId === id) };
const engine = new ScoringEngine(catalog as Catalog, new MetricsStore(mem()));

type Rt = { health?: 'ok' | 'half-open' | 'bad'; canSend?: boolean; headroom?: number };
function rt(o: Rt = {}) {
  return { health: o.health ?? 'ok', canSend: o.canSend ?? true, hasKey: true, capable: true, headroom: o.headroom ?? 1, providerLoad: 0 };
}

const ENTRIES: FallbackEntry[] = [
  { platform: 'p' as Platform, modelId: 'a', enabled: true, priority: 0 },
  { platform: 'p' as Platform, modelId: 'b', enabled: true, priority: 1 },
  { platform: 'p' as Platform, modelId: 'c', enabled: true, priority: 2 },
];

function rank(runtime: Map<string, ReturnType<typeof rt>>, lastServedAt?: Map<string, number>, rng: () => number = () => 1): FallbackEntry[] {
  return engine.rank({
    taskKind: 'chat' as TaskKind, entries: ENTRIES, runtime, requireTools: false, isVision: false, lastServedAt,
  }, rng).ordered;
}

async function main() {
  const freshRt = new Map([['p::a', rt()], ['p::b', rt()], ['p::c', rt()]]);

  // 1. rng disabled (rng=1) + equal headroom → NO rotation: incumbent stays (legacy stability).
  const stable = rank(freshRt, undefined, () => 1);
  ok('rng off + equal headroom: top stays first (no gratuitous rotation)', stable[0].modelId === 'a');

  // 2. Quota pressure fires deterministically with rng OFF: incumbent 'a' partially burned
  //    (headroom 0.5), tied peers fresh → a peer must take the seat.
  const pressured = rank(new Map([['p::a', rt({ headroom: 0.5 })], ['p::b', rt()], ['p::c', rt()]]), undefined, () => 1);
  ok('quota pressure rotates the tied band even with exploration rng off', pressured[0].modelId !== 'a');

  // 3. LRS alternation: with exploration rng ON (rng=0 always fires), consecutive calls with
  //    updated lastServedAt alternate a → b → a — never 'a' twice in a row.
  const served = new Map<string, number>();
  const picks: string[] = [];
  for (let i = 0; i < 6; i++) {
    const ordered = rank(new Map([['p::a', rt()], ['p::b', rt()], ['p::c', rt()]]), served, () => 0);
    const pick = ordered[0].modelId;
    picks.push(pick);
    served.set(`p::${pick}`, Date.now() + i); // this model just served
  }
  const noRepeat = picks.every((p, i) => i === 0 || p !== picks[i - 1]);
  ok(`LRS rotation alternates (picks: ${picks.join(' → ')})`, noRepeat && new Set(picks).size >= 2);

  // 4. Never-served model wins the first exploration turn: 'a' served recently, 'b' never.
  const mixed = rank(freshRt, new Map([['p::a', Date.now()]]), () => 0);
  ok('never-served tied peer is promoted first (keeps earning samples)', mixed[0].modelId === 'b');

  // 5. Headroom tie-break: both never served, 'b' has less headroom than 'c' → 'c' preferred.
  const tie = rank(new Map([['p::a', rt({ headroom: 0.4 })], ['p::b', rt({ headroom: 0.6 })], ['p::c', rt({ headroom: 0.95 })]]), new Map([['p::a', Date.now()]]), () => 0);
  ok('exact LRS tie broken by headroom (freshest quota wins)', tie[0].modelId === 'c');

  // 6. Outside the margin: rotation must NOT reach a clearly-worse candidate.
  //    'a' at full health vs 'b'/'c' rate-limited (canSend false → 0.05× demotion, far outside margin).
  const gated = rank(new Map([['p::a', rt()], ['p::b', rt({ canSend: false })], ['p::c', rt({ canSend: false })]]), new Map([['p::a', Date.now()]]), () => 0);
  ok('rate-limited peers outside margin are never rotated in', gated[0].modelId === 'a');

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
