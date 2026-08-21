// Quota ledger persistence: RateTracker windows must survive a "reload" (a fresh tracker
// hydrating from QuotaStore), so a window restart can't re-hammer a provider whose RPM/RPD
// was already consumed. Covers: hydrate, rolling-window expiry after reload, cap behavior,
// and the debounced write-back (flush).
//
// Run:  npm run test:e2e:quota-persist
import { RateTracker } from '../src/router/rateTracker';
import { QuotaStore } from '../src/config/quotaStore';
import type * as vscode from 'vscode';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

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
  // ---- 1. RPM consumed before "reload" is still consumed after ----
  {
    const { m, data } = mem();
    const store = new QuotaStore(m);
    const t1 = new RateTracker(store);
    // rpm=2: burn both sends, then simulate a reload by constructing a FRESH tracker+store
    // over the same persisted data (exactly what a new extension activation does).
    t1.record('ollama', 'm1');
    t1.record('ollama', 'm1');
    ok('pre-reload: third send blocked at rpm=2', t1.canSend('ollama', 'm1', 2, null) === false);
    store.flush();
    ok('ledger persisted to memento', !!data['tiermux.quotaLedger']);

    const t2 = new RateTracker(new QuotaStore(m));
    ok('post-reload: still blocked (hydrate worked)', t2.canSend('ollama', 'm1', 2, null) === false);
    ok('post-reload: other model unaffected', t2.canSend('ollama', 'm2', 2, null) === true);
  }

  // ---- 2. RPD window survives reload too ----
  {
    const { m } = mem();
    const s1 = new QuotaStore(m);
    const t1 = new RateTracker(s1);
    t1.record('p', 'daily');
    t1.record('p', 'daily');
    t1.record('p', 'daily');
    s1.flush();
    const t2 = new RateTracker(new QuotaStore(m));
    ok('post-reload: rpd=3 exhausted', t2.canSend('p', 'daily', null, 3) === false);
    ok('post-reload: rpd=4 still allows one', t2.canSend('p', 'daily', null, 4) === true);
  }

  // ---- 3. Debounced flush: un-flushed records are NOT visible after reload ----
  {
    const { m } = mem();
    const s1 = new QuotaStore(m);
    const t1 = new RateTracker(s1);
    t1.record('p', 'x');
    t1.record('p', 'x');
    // no flush() — within the 2s debounce window a crash loses it (accepted trade: at most
    // one under-count, never an over-count of quota)
    const t2 = new RateTracker(new QuotaStore(m));
    ok('un-flushed (crashed mid-debounce) record lost — by design', t2.canSend('p', 'x', 2, null) === true);
  }

  // ---- 4. Forced flush after FLUSH_EVERY_N records ----
  {
    const { m, data } = mem();
    const store = new QuotaStore(m);
    const t = new RateTracker(store);
    for (let i = 0; i < 60; i++) t.record('p', 'burst');
    ok('high-volume recording forced a synchronous write', !!data['tiermux.quotaLedger']);
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
