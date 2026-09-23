// Task-round rotation persistence: the picker's equal-rank/table rotation counter must
// survive a "reload" (a fresh TaskRoundStore hydrating from the same globalState), so a task
// kind exercised rarely per session (vision, often one turn per session) doesn't keep
// re-reading round 0 forever just because the extension host restarted between turns.
// Repro (2026-09-23): vision always led with TASK_ROUTING.vision[0] (google::gemini-2.5-flash)
// because taskRoundCounters was pure in-memory, unlike RateTracker's QuotaStore.
// Run: npm run test:e2e:task-round-persist
import { selectModel, setModelSources, setTaskRoundStore, __resetTaskRoundCounters } from '../src/router/picker';
import { TaskRoundStore } from '../src/config/taskRoundStore';
import type { FallbackEntry } from '../src/shared/types';
import type * as vscode from 'vscode';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const entry = (platform: string, modelId: string, priority: number): FallbackEntry =>
  ({ platform, modelId, enabled: true, priority } as unknown as FallbackEntry);

function makeSources(fallback: FallbackEntry[]) {
  return {
    catalog: { find: () => ({ intelligenceRank: 1, speedRank: 1, supportsTools: true }) },
    settings: {
      getFallback: () => fallback,
      getDisabledProviders: () => [],
      enabledByPriority: () => fallback.filter((e) => e.enabled).sort((a, b) => a.priority - b.priority),
    },
    secrets: { getKeys: async () => ['sk-test'], getCloudflareAccountId: async () => undefined, isToolIncompatible: () => false },
  } as unknown as Parameters<typeof setModelSources>[0];
}

function mem(): { m: vscode.Memento; data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    m: {
      get: <T,>(k: string, d?: T): T => (data[k] as T) ?? (d as T),
      keys: () => Object.keys(data),
      update: (k: string, v: unknown) => { data[k] = v; return Promise.resolve(); },
      setKeysForSync: () => {},
    } as unknown as vscode.Memento,
  };
}

async function main() {
  // The two real TASK_ROUTING['coding'] leaders — reuses the existing "task table rotates"
  // repro's fixture shape (routingGates.e2e.ts) so this test isolates PERSISTENCE only; both
  // mock catalog rows report no rpm/rpd, so headroom ties at 1 and can't nudge the order.
  const fallback = [
    entry('groq', 'openai/gpt-oss-120b', 0),
    entry('cerebras', 'gpt-oss-120b', 1),
  ];
  setModelSources(makeSources(fallback));
  const message = [{ role: 'user', content: 'fix this bug in the code' } as never];

  console.log('— without a store, a "reload" forgets the rotation (today\'s bug, for contrast) —');
  {
    __resetTaskRoundCounters();
    setTaskRoundStore(undefined);
    const first = (await selectModel(message, { taskKind: 'coding' })).model;
    __resetTaskRoundCounters(); // the "reload" — an in-memory-only Map has nothing else to lose
    const afterReload = (await selectModel(message, { taskKind: 'coding' })).model;
    ok('no store ⇒ a reload re-reads round 0 and re-leads with the same candidate',
      first === afterReload, `${first} then ${afterReload}`);
  }

  console.log('\n— with a store wired, rotation survives a simulated reload —');
  {
    __resetTaskRoundCounters();
    const { m, data } = mem();
    const store1 = new TaskRoundStore(m);
    setTaskRoundStore(store1);
    const first = (await selectModel(message, { taskKind: 'coding' })).model;
    ok('first call ever still keeps today\'s untouched order (round 0 unchanged)',
      first === 'groq::openai/gpt-oss-120b', first);
    store1.flush();
    ok('the round was persisted to the memento', !!data['tiermux.taskRoundLedger']);

    // Simulate an extension-host restart: __resetTaskRoundCounters gives the same fresh,
    // empty in-memory Map a real module reinitialization would, and a FRESH TaskRoundStore
    // hydrates it from the SAME persisted memento — exactly what extension.ts's activation
    // does on every real reload (setTaskRoundStore(new TaskRoundStore(context.globalState))).
    __resetTaskRoundCounters();
    setTaskRoundStore(new TaskRoundStore(m));
    const afterReload = (await selectModel(message, { taskKind: 'coding' })).model;
    ok('after the "reload", rotation resumes — a different candidate leads, not round 0 again',
      afterReload !== first, `${first} then ${afterReload}`);
    ok('…specifically the peer that round 1 should pick',
      afterReload === 'cerebras::gpt-oss-120b', afterReload);
  }

  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();
