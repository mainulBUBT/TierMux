/* Reproduces a real failure the user hit testing TierMux on an external project: turn 1 gets a
 * numbered proposal ending in "would you like me to implement any of these?", the user replies
 * with a short approval ("all"), and in agent mode the turn investigates but never edits — ending
 * on what looked like a dead stop.
 *
 * History is SEEDED with a real proposal-shaped assistant turn (not generated live) so the
 * reproduction is deterministic regardless of which model would have organically written it —
 * only the "all" follow-up in agent mode is live.
 *
 * SAFETY: agent mode (edits enabled) against a disposable git worktree passed as argv[2], never
 * the developer's checkout — same guard as complexTask.e2e.ts.
 *
 * Run: TIERMUX_DIAG=1 npm run test:e2e:deflection-repro -- <worktree-path>
 */
import * as fs from 'fs';
import { buildHarness, syncRemoteProviders } from './bench/routerHarness';
import { setWorkspaceRoot } from './bench/agentHarness';
import { runTurn } from '../src/agent/core/loop';
import { setGates } from '../src/agent/core/tools/gates';
import { CommandGate } from '../src/edits/commandGate';
import { EditGate } from '../src/edits/applyEdit';
import type { AgentOpts } from '../src/agent/agent';
import type { ChatMessage } from '../src/shared/types';

const SEEDED_PROPOSAL = `I looked at the router's failover handling. A few concrete improvements:

1. **Cache preflight results** — \`router.ts\`'s health check re-pings a model every route() call; caching it for a few seconds would cut redundant requests under load.
2. **Log the failover chain** — when all candidates fail, the error names them, but a successful failover (2nd/3rd candidate) is silent; a diagLog line would make routing failures easier to debug.
3. **Expose cooldown remaining in the UI** — the model picker doesn't show WHY a model is greyed out; surfacing the cooldown countdown would save users a support question.

Would you like me to implement any of these specific improvements?`;

(async () => {
  const root = process.argv[2];
  if (!root || !fs.existsSync(root)) { console.error('usage: deflection-repro <worktree-path>'); process.exit(2); }
  const resolved = fs.realpathSync(root);
  if (resolved === fs.realpathSync(process.cwd())) {
    console.error('REFUSING to run against the current working tree — pass a disposable git worktree.');
    process.exit(2);
  }

  setWorkspaceRoot(resolved);
  setGates(new EditGate(() => false), new CommandGate(() => 'always', () => 20_000, () => []));
  await syncRemoteProviders().catch(() => {});
  const { router } = buildHarness({});

  const history: ChatMessage[] = [
    { role: 'user', content: 'How can we improve the router\'s failover handling? Give me a few options.' },
    { role: 'assistant', content: SEEDED_PROPOSAL },
    { role: 'user', content: 'all' },
  ];

  const tools: string[] = [];
  const edited = new Set<string>();
  let model = '';
  let todos: Array<{ content?: string; status?: string }> = [];

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 600_000); // 10 min
  const t0 = Date.now();

  const opts = {
    messages: history,
    mode: 'agent',
    effort: 'medium',
    sessionId: 'deflection-repro-1',
    abortSignal: ac.signal,
    onChunk: () => {},
    onTool: (e: { state: string; name: string; args?: unknown }) => {
      if (e.state !== 'running') return;
      tools.push(e.name);
      const p = (e.args as { path?: unknown })?.path;
      if (typeof p === 'string' && /^(write|edit|create|delete)/i.test(e.name)) edited.add(p);
    },
    onReasoning: () => {},
    onModel: (p: string, m: string) => { model = `${p}::${m}`; },
    onFailover: () => {},
    onStep: () => {},
    onTodos: (t: typeof todos) => { todos = t; },
    onAskUser: async () => '',
    onError: (m: string) => console.error('onError:', m),
  } as unknown as AgentOpts;

  const res = await runTurn(router, opts);
  clearTimeout(timer);
  const answer = (res.text ?? '').trim();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  let diff = '';
  try {
    diff = require('child_process').execSync('git -C "' + resolved + '" diff --stat', { encoding: 'utf8' }).trim();
  } catch { /* best effort */ }

  console.log(`\n══════ deflection repro: proposal → "all" → agent mode ══════`);
  console.log(`model: ${model}   taskKind: ${res.taskKind}   ${secs}s`);
  console.log(`tool calls: ${tools.length}   stopReason: ${res.stopReason ?? '—'}   paused: ${res.paused}`);
  console.log(`tool sequence: ${tools.join(' → ') || '(none)'}`);
  console.log(`todos kept (${todos.length}): ${todos.map((t) => `[${t.status}] ${t.content}`).join(' | ') || '(none)'}`);
  console.log(`\ngit diff --stat in the sandbox:\n${diff || '  (no changes made)'}`);
  console.log(`\nFULL final answer text (${answer.length} chars), UNTRUNCATED — this is what the UI actually renders, not a placeholder:\n---\n${answer}\n---`);
})();
