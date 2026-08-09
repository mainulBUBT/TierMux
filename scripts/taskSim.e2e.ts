/* Give TierMux real technical tasks, in English, and grade what comes back — deterministically.
 *
 * Complements the quality bench (which scores retrieval against curated ground truth) and
 * humanSim (which tests multi-turn continuity). This one asks the question a user actually cares
 * about for a coding agent: when I hand it a task, does the plan refer to files that EXIST, and
 * did it look at them?
 *
 * Grading is non-LLM on purpose:
 *   - every workspace-looking path the answer names is checked against the filesystem
 *   - a plan that names no file at all is called out (generic recipe, not a plan for THIS repo)
 *   - tool calls are counted, so "answered from memory" is visible
 *
 * Read-only: plan mode has no write/edit/delete/runCommand, so this cannot modify the repo.
 *
 * Run: npm run test:e2e:task-sim
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildHarness, syncRemoteProviders } from './bench/routerHarness';
import { setWorkspaceRoot } from './bench/agentHarness';
import { runTurn } from '../src/agent/core/loop';
import type { AgentOpts } from '../src/agent/agent';

const TASKS = [
  'Add a setting that lets the user cap how many tool calls one turn may make, and stop the turn when it is exceeded.',
  'The router sometimes picks a model that is still in rate-limit cooldown. Where would you fix that, and how?',
  'Add a unit test for the task classifier covering the romanized-Bengali inputs.',
  'Rename the getSymbolGraph tool to findDefinition everywhere, without breaking the tool schema.',
];

/** Paths the answer claims, in workspace-relative form. Same shape as loop.ts's own
 *  unresolvedPlanPaths: nested `a/b.ts` or a bare root file like `package.json`. */
function claimedPaths(text: string): string[] {
  const out = new Set<string>();
  const re = /\b((?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,5}|[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|md))\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1].replace(/^\.\//, ''));
  return [...out];
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'coverage', '.benchmarks']);

/** Every file in the repo, as a set of workspace-relative paths plus a basename index. Built once.
 *  Needed because a plan legitimately writes `loop.ts` or `symbolGraph.ts` rather than the full
 *  `src/agent/core/loop.ts` — the first version of this grader checked those against the workspace
 *  ROOT only and reported real files as missing, which would have been read as hallucination. */
function indexRepo(root: string): { rel: Set<string>; byBase: Map<string, string[]> } {
  const rel = new Set<string>();
  const byBase = new Map<string, string[]>();
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.tiermux') continue;
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      const r = path.relative(root, full).replace(/\\/g, '/');
      rel.add(r);
      const list = byBase.get(e.name) ?? [];
      list.push(r);
      byBase.set(e.name, list);
    }
  };
  walk(root);
  return { rel, byBase };
}

/** Does this claimed path correspond to a file that exists — by exact relative path, by suffix, or
 *  (for a bare `loop.ts`) by basename? */
function resolves(claim: string, idx: { rel: Set<string>; byBase: Map<string, string[]> }): boolean {
  if (idx.rel.has(claim)) return true;
  for (const r of idx.rel) if (r.endsWith(`/${claim}`)) return true;
  return (idx.byBase.get(claim.split('/').pop() ?? '')?.length ?? 0) > 0 && !claim.includes('/');
}

(async () => {
  const root = process.cwd();
  setWorkspaceRoot(root);
  await syncRemoteProviders().catch(() => {});
  const { router } = buildHarness({});
  const repoIdx = indexRepo(root);

  let totalClaimed = 0;
  let totalReal = 0;

  for (let i = 0; i < TASKS.length; i++) {
    const task = TASKS[i];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 300_000);
    let model = '';
    let tools = 0;
    const names: string[] = [];

    const opts = {
      messages: [{ role: 'user', content: task }],
      mode: 'plan',
      effort: 'medium',
      sessionId: 'tasksim-1',
      abortSignal: ac.signal,
      onChunk: () => {},
      onTool: (e: { state: string; name: string }) => { if (e.state === 'running') { tools++; names.push(e.name); } },
      onReasoning: () => {},
      onModel: (p: string, m: string) => { model = `${p}::${m}`; },
      onFailover: () => {},
      onStep: () => {},
      onTodos: () => {},
      onAskUser: async () => '',
      onError: () => {},
    } as unknown as AgentOpts;

    const t0 = Date.now();
    const res = await runTurn(router, opts);
    clearTimeout(timer);
    const answer = (res.text ?? '').trim();

    const claimed = claimedPaths(answer);
    const real = claimed.filter((p) => resolves(p, repoIdx));
    const fake = claimed.filter((p) => !real.includes(p));
    totalClaimed += claimed.length;
    totalReal += real.length;

    console.log(`\n─── task ${i + 1}: ${task}`);
    console.log(`    kind=${res.taskKind}  model=${model}  tools=${tools} [${names.slice(0, 8).join(', ')}]  ${Math.round((Date.now() - t0) / 1000)}s`);
    // "unresolved", not "hallucinated": a plan legitimately names files it intends to CREATE, and
    // this grader cannot tell those from invented ones. Treat the list as something to eyeball.
    console.log(`    paths named: ${claimed.length}   resolve to a real file: ${real.length}   UNRESOLVED: ${fake.length ? fake.join(', ') : '—'}`);
    if (!claimed.length) console.log('    ⚠ named no file at all — a generic recipe, not a plan for this repo');
    console.log(`    answer: ${answer.slice(0, 300).replace(/\n/g, ' ')}`);
  }

  const pct = totalClaimed ? Math.round((100 * totalReal) / totalClaimed) : 0;
  console.log(`\n═══ path resolution: ${totalReal}/${totalClaimed} named paths map to a real file (${pct}%)`);
  console.log('    (unresolved ≠ hallucinated — a plan may name files it proposes to create)');
})();
