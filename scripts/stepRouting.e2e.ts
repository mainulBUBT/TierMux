// End-to-end test for Phase-2 step routing: per-step difficulty (planner [easy]/[hard] tags →
// TodoItem.difficulty → Router rank constraints per round) and the scoring engine's price term.
//
// Part A drives the REAL runTurn() with a scripted fake Router (same seam as coreLoop/selfCorrect
// e2e) and captures the RouteOptions each route() call received.
// Part B unit-checks the difficulty parsing/inference.
// Part C exercises the ScoringEngine's price tie-break directly (same fakes as scoring.e2e.ts).
//
// Run: npm run test:e2e:step-routing
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTurn } from '../src/agent/core/loop';
import { setGates } from '../src/agent/core/tools/gates';
import { CommandGate, type CommandApproval } from '../src/edits/commandGate';
import { EditGate } from '../src/edits/applyEdit';
import { parseStepDifficultyTag, inferStepDifficulty } from '../src/agent/stepDifficulty';
import { ScoringEngine } from '../src/router/scoring';
import { MetricsStore } from '../src/router/metricsStore';
import type { Router } from '../src/router/router';
import type { AgentOpts } from '../src/agent/agent';
import type { Catalog } from '../src/catalog/catalog';
import type { CatalogModel, FallbackEntry, Platform } from '../src/shared/types';
import type * as vscode from 'vscode';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

function baseResponse(overrides: Record<string, unknown>) {
  return {
    id: 'r', object: 'chat.completion' as const, created: 0, model: 'fake',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant' as const, content: null, ...overrides } }],
  };
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode');
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-steproute-e2e-'));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot, path: workspaceRoot } }];

  const commandGate = new CommandGate(() => 'always' as CommandApproval, () => 5000, () => []);
  const editGate = new EditGate(() => false);
  setGates(editGate, commandGate);

  const setConfig = (overrides: Record<string, unknown>) => { (globalThis as any).__tiermuxTestConfig = overrides; };

  function makeOpts(overrides: Partial<AgentOpts> = {}): AgentOpts {
    return {
      messages: [{ role: 'user', content: 'edit the file' }],
      mode: 'agent',
      effort: 'medium',
      onChunk: () => {},
      onTool: () => {},
      onReasoning: () => {},
      onModel: () => {},
      onFailover: () => {},
      onStep: () => {},
      onTodos: () => {},
      onAskUser: async () => '',
      onError: (m) => console.error('onError:', m),
      ...overrides,
    };
  }

  const strongExecutor = () =>
    ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } });

  /** A turn that makes one runCommand mutation then answers — minimal scripted shape. */
  function scriptedRouter(capture: any[]) {
    let n = 0;
    return {
      async route(messages: any[], opts: any) {
        capture.push(opts ?? {});
        n++;
        if (n === 1) {
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 's1', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: 'printf edited' }) } }] }),
          };
        }
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Fixed.' }) };
      },
      peekTopSelection: strongExecutor,
    } as unknown as Router;
  }

  // --- Part A: difficulty → Router constraints per attempt ---
  {
    setConfig({ mixturePipeline: 'off', verifyCommand: 'off', stepRouting: true });

    const easyOpts: any[] = [];
    await runTurn(scriptedRouter(easyOpts), makeOpts({ stepDifficulty: 'easy' }));
    const easyRoute = easyOpts.find((o) => o.taskKind !== 'plan');
    ok('easy step: route constrained to the cheap pool (minIntelligenceRank 3)', easyRoute?.minIntelligenceRank === 3);
    ok('easy step: no top-tier constraint', easyRoute?.maxIntelligenceRank === undefined);

    const hardOpts: any[] = [];
    await runTurn(scriptedRouter(hardOpts), makeOpts({ stepDifficulty: 'hard' }));
    const hardRoute = hardOpts.find((o) => o.taskKind !== 'plan');
    ok('hard step: route constrained to the top tier (maxIntelligenceRank 2)', hardRoute?.maxIntelligenceRank === 2);
    ok('hard step: no cheap-pool constraint', hardRoute?.minIntelligenceRank === undefined);

    const plainOpts: any[] = [];
    await runTurn(scriptedRouter(plainOpts), makeOpts());
    const plainRoute = plainOpts.find((o) => o.taskKind !== 'plan');
    ok('no difficulty: route unconstrained (medium/default behavior)', plainRoute?.minIntelligenceRank === undefined && plainRoute?.maxIntelligenceRank === undefined);

    const medOpts: any[] = [];
    await runTurn(scriptedRouter(medOpts), makeOpts({ stepDifficulty: 'medium' }));
    const medRoute = medOpts.find((o) => o.taskKind !== 'plan');
    ok('medium difficulty: route unconstrained', medRoute?.minIntelligenceRank === undefined && medRoute?.maxIntelligenceRank === undefined);

    const offOpts: any[] = [];
    setConfig({ mixturePipeline: 'off', verifyCommand: 'off', stepRouting: false });
    await runTurn(scriptedRouter(offOpts), makeOpts({ stepDifficulty: 'easy' }));
    const offRoute = offOpts.find((o) => o.taskKind !== 'plan');
    ok('stepRouting disabled: easy step routes unconstrained', offRoute?.minIntelligenceRank === undefined);
  }

  // --- Part A2: planner [easy]/[hard] tags land on the seeded todos, tag stripped ---
  {
    setConfig({ mixturePipeline: 'on', verifyCommand: 'off' });
    const todoLists: any[][] = [];
    let n = 0;
    const plan = ''
      + 'Goal: fix the gate.\n'
      + 'Steps:\n'
      + '1. [easy] Read src/a.ts to understand the current wiring.\n'
      + '2. [hard] Refactor src/a.ts to inject the guard at the call site.\n'
      + 'Verify: none';
    const fakeRouter = {
      async route() {
        n++;
        if (n === 1) return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: plan }) };
        if (n === 2) {
          return {
            platform: 'custom' as const, model: 'fake',
            response: baseResponse({ tool_calls: [{ id: 'p1', type: 'function' as const, function: { name: 'runCommand', arguments: JSON.stringify({ command: 'printf edited' }) } }] }),
          };
        }
        return { platform: 'custom' as const, model: 'fake', response: baseResponse({ content: 'Fixed.' }) };
      },
      peekTopSelection: strongExecutor,
    } as unknown as Router;

    await runTurn(fakeRouter, makeOpts({ onTodos: (t) => todoLists.push(t as any[]) }));
    const seeded = todoLists[0] ?? [];
    ok('planner: todos seeded from tagged steps', seeded.length === 2);
    ok('planner: [easy] tag became difficulty=easy and was stripped from the text',
      seeded[0]?.difficulty === 'easy' && /^Read src\/a\.ts/.test(seeded[0]?.content ?? ''));
    ok('planner: [hard] tag became difficulty=hard and was stripped from the text',
      seeded[1]?.difficulty === 'hard' && /^Refactor src\/a\.ts/.test(seeded[1]?.content ?? ''));
  }

  // --- Part B: difficulty parsing + conservative inference ---
  {
    const t1 = parseStepDifficultyTag('[EASY] Read config.json');
    ok('parse: uppercase tag recognized, content trimmed', t1.difficulty === 'easy' && t1.content === 'Read config.json');
    const t2 = parseStepDifficultyTag('No tag here');
    ok('parse: untagged line → no difficulty, content intact', t2.difficulty === undefined && t2.content === 'No tag here');

    ok('infer: pure read step → easy', inferStepDifficulty('Read the router config and check its entries') === 'easy');
    ok('infer: edit step → hard (never routed to the cheap pool by mistake)', inferStepDifficulty('Edit src/a.ts to add the guard') === 'hard');
    ok('infer: ambiguous step → medium (unconstrained default)', inferStepDifficulty('Understand the deployment flow') === 'medium');
    ok('infer: read verb + edit verb → hard (edit wins)', inferStepDifficulty('Read config and update the timeout value') === 'hard');
  }

  // --- Part C: price tie-break in the scoring engine ---
  {
    class FakeMemento implements vscode.Memento {
      private data: Record<string, unknown> = {};
      get<T>(key: string, defaultValue?: T): T { return (this.data[key] as T | undefined) ?? (defaultValue as T); }
      keys(): string[] { return Object.keys(this.data); }
      update(key: string, value: unknown): Thenable<void> { this.data[key] = value; return Promise.resolve(); }
      setKeysForSync(_keys: string[]): void { /* no-op */ }
    }
    const model = (p: string, id: string, over: Partial<CatalogModel> = {}): CatalogModel => ({
      platform: p as Platform, modelId: id, displayName: id, intelligenceRank: 3, speedRank: 3,
      sizeLabel: '', contextWindow: 32768, rpmLimit: null, rpdLimit: null, monthlyTokenBudget: '',
      supportsTools: true, supportsVision: false, supportsReasoning: false, ...over,
    });
    const fakeCatalog = (models: CatalogModel[]): Catalog =>
      ({ find: (p: string, id: string) => models.find((m) => m.platform === p && m.modelId === id) }) as unknown as Catalog;
    const entry = (p: string, id: string): FallbackEntry => ({ platform: p as Platform, modelId: id, enabled: true, priority: 0 });
    const rt = () => ({ health: 'ok' as const, canSend: true, hasKey: true, capable: true });

    const models = [
      model('a', 'paid-twin', { origInputPricePer1M: 3, origOutputPricePer1M: 15 }),
      model('b', 'free-twin', { origInputPricePer1M: 0, origOutputPricePer1M: 0 }),
    ];
    const engine = new ScoringEngine(fakeCatalog(models), new MetricsStore(new FakeMemento()));
    const entries = [entry('a', 'paid-twin'), entry('b', 'free-twin')];
    const runtime = new Map([['a::paid-twin', rt()], ['b::free-twin', rt()]]);
    const ordered = engine.rank({ taskKind: 'chat', entries, runtime, requireTools: false, isVision: false }, () => 1).ordered;
    ok('price: identical twins — free model wins the tie-break', ordered[0].modelId === 'free-twin');

    const unknownModels = [
      model('a', 'mystery-a'),
      model('b', 'mystery-b'),
    ];
    const engine2 = new ScoringEngine(fakeCatalog(unknownModels), new MetricsStore(new FakeMemento()));
    const entries2 = [entry('a', 'mystery-a'), entry('b', 'mystery-b')];
    const runtime2 = new Map([['a::mystery-a', rt()], ['b::mystery-b', rt()]]);
    const rationale = engine2.rank({ taskKind: 'chat', entries: entries2, runtime: runtime2, requireTools: false, isVision: false }, () => 1).rationale;
    ok('price: unpublished prices stay neutral (signal 1.0 for all)', rationale.every((r) => Math.abs(r.signals.price - 1) < 1e-9));
  }

  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
