/* Human-in-the-loop simulation: one chat SESSION, several real Banglish turns, run through the
 * real runTurn() the way chatViewProvider drives it — accumulating history, a stable sessionId.
 *
 * This exists because the quality bench cannot test any of it: it runs one isolated query per
 * call and never sets `sessionId`, so session-sticky Auto routing, correction retention, and
 * Banglish classification are all invisible to it.
 *
 * Read-only by construction: every turn runs in 'ask' mode, so the tool set has no
 * write/edit/delete/runCommand and the simulation can never touch the repo.
 */
import { buildHarness, syncRemoteProviders } from './bench/routerHarness';
import { setWorkspaceRoot } from './bench/agentHarness';
import { runTurn } from '../src/agent/core/loop';
import { classifyTaskCore } from '../src/agent/routing';
import type { AgentOpts } from '../src/agent/agent';
import type { ChatMessage } from '../src/shared/types';

const TURNS = [
  'router ta kivabe kaj kore?',
  'na, ami model selection er kotha bolchilam, failover na',
  'oi same file e task classification kothay hoy?',
  'eta tumi verify korecho?',
];

(async () => {
  setWorkspaceRoot(process.cwd());
  await syncRemoteProviders().catch(() => {});
  const { router } = buildHarness({});

  const sessionId = 'humansim-session-1';
  const history: ChatMessage[] = [];
  let prevModel = '';

  for (let i = 0; i < TURNS.length; i++) {
    const text = TURNS[i];
    history.push({ role: 'user', content: text });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 300_000);
    let model = '';
    let tools = 0;
    const toolNames: string[] = [];

    const opts: AgentOpts = {
      messages: [...history],
      mode: 'ask',
      effort: 'medium',
      sessionId,
      abortSignal: ac.signal,
      onChunk: () => {},
      onTool: (e: any) => { if (e.state === 'running') { tools++; toolNames.push(e.name); } },
      onReasoning: () => {},
      onModel: (p: string, m: string) => { model = `${p}::${m}`; },
      onFailover: () => {},
      onStep: () => {},
      onTodos: () => {},
      onAskUser: async () => '',
      onError: () => {},
    } as AgentOpts;

    const t0 = Date.now();
    const res = await runTurn(router, opts);
    clearTimeout(timer);

    const answer = (res.text ?? '').trim();
    history.push({ role: 'assistant', content: answer });

    const regex = classifyTaskCore(text).kind;
    const same = prevModel && model === prevModel ? 'SAME' : prevModel ? 'CHANGED' : '—';
    console.log(`\n─── turn ${i + 1}: "${text}"`);
    console.log(`    regexKind=${regex}  runTurnKind=${res.taskKind}`);
    console.log(`    model=${model}  vs prev: ${same}`);
    console.log(`    tools=${tools} [${toolNames.slice(0, 8).join(', ')}]  ${Math.round((Date.now() - t0) / 1000)}s`);
    console.log(`    answer: ${answer.slice(0, 260).replace(/\n/g, ' ')}`);
    prevModel = model;
  }
})();
