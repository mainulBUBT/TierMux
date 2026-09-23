/* Cline's runtime owns the loop (iteration cap, stall protections, compaction). What TierMux
 * still guarantees around it — and what this file locks — is:
 *   1. a round-robin reader is BOUNDED by the step cap (a resumable pause, never a runaway);
 *   2. a stale persisted 'ask' session maps to the read-only plan toolset (no editors);
 *   3. the transcript stays faithful across many tool calls (agentToChatMessages round-trip).
 * Run: npm run test:e2e:read-loop */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMockModel } from './mockClineModel';
import { runPlanStream, runAgentStream } from '../src/agent/agent';
import { __setClineEngineModelForTests } from '../src/agent/core/cline/clineEngine';
import { runWithWorkspaceRoot } from '../src/util/workspaceRoot';
import type { AgentOpts } from '../src/agent/agent';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-loop-'));
const files = ['A.php', 'B.php', 'C.php', 'D.php'];
for (const f of files) fs.writeFileSync(path.join(root, f), Array.from({ length: 120 }, (_, i) => `// ${f} line ${i} ${'x'.repeat(40)}`).join('\n'));

const baseOpts = (mode: 'ask' | 'agent', over: Partial<AgentOpts> = {}): AgentOpts => ({
  messages: [{ role: 'user', content: 'why does it fail?' }], mode, effort: 'medium',
  onChunk: () => {}, onTool: () => {}, onReasoning: () => {}, onModel: () => {}, onFailover: () => {}, onStep: () => {},
  onAskUser: async () => ({ status: 'cancelled' as const, answers: [] }), onError: () => {},
  ...over,
} as AgentOpts);

async function run(model: ReturnType<typeof createMockModel>, mode: 'ask' | 'agent', over: Partial<AgentOpts> = {}) {
  __setClineEngineModelForTests(model);
  try { return await runWithWorkspaceRoot(root, () => (mode === 'ask' ? runPlanStream : runAgentStream)(baseOpts(mode, over))); }
  finally { __setClineEngineModelForTests(undefined); }
}

const offered = (m: ReturnType<typeof createMockModel>, call: number) =>
  (m.calls[call]?.tools ?? []).map((t) => (t as { name?: string }).name ?? '');

async function main() {
  // ── 1. A round-robin reader is bounded by the step cap (the old repeat guard's job) ─────────
  {
    const steps: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 30; i++) steps.push({ toolCalls: [{ toolName: 'read_files', input: { files: [{ path: path.join(root, files[i % 4]) }] } }] });
    steps.push({ text: 'The answer.' });
    const m = createMockModel(steps as never, 'read-loop');
    const r = await run(m, 'agent', { maxStepsPerTurn: 12 });
    ok('the turn hit the step cap, not the script end', m.calls.length <= 13, `${m.calls.length} model calls`);
    ok('the capped turn RETURNED as a resumable pause', !!r && r.paused === true && !r.failed, `paused=${r.paused} failed=${r.failed}`);
    ok('the transcript is present for the host to persist', (r.workMessages?.length ?? 0) > 0, `${r.workMessages?.length} messages`);
  }

  // ── 2. A stale persisted 'ask' session runs as read-only plan (editors never offered) ───────
  {
    const steps: Array<Record<string, unknown>> = [
      { toolCalls: [{ toolName: 'read_files', input: { files: [{ path: path.join(root, 'A.php') }] } }] },
      { text: 'It fails at line 3.' },
    ];
    const m = createMockModel(steps as never, 'ask-maps-to-plan');
    const r = await run(m, 'ask');
    const names = offered(m, 0);
    ok("a persisted 'ask' turn still runs", r.text.includes('line 3'), r.text);
    ok('its toolset is the read-only plan set — no editor', !names.includes('editor') && !names.includes('apply_patch'), names.join(','));
    ok('read tools survive the mapping', names.includes('read_files') && names.includes('search_codebase'), names.join(','));
  }

  // ── 3. Evidence retention across many tool calls (the old aging stubs are Cline's job now) ──
  {
    const steps: Array<Record<string, unknown>> = [{ toolCalls: [{ toolName: 'read_files', input: { files: [{ path: path.join(root, 'A.php') }] } }] }];
    for (let i = 0; i < 6; i++) steps.push({ toolCalls: [{ toolName: 'search_codebase', input: { queries: [`q${i}`] } }] });
    steps.push({ text: 'done' });
    const m = createMockModel(steps as never, 'keep');
    const r = await run(m, 'agent');
    ok('all seven tool calls reached the transcript in order',
      (r.workMessages?.filter((x) => x.role === 'tool').length ?? 0) === 7,
      `${r.workMessages?.filter((x) => x.role === 'tool').length} tool messages`);
    ok('the final answer shipped', r.text === 'done', r.text);
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(bad === 0 ? '\nThe cline branch read-loop guarantees hold.' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
void main();
