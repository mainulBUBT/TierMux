// askUser e2e — the mid-turn clarifying-question tool: 1-4 questions on ONE card, a legacy
// single-question shape, dismissed ≠ cancelled, and a skip ends an agent/ask turn.
// Run: npm run test:e2e:ask-user

import { createAskUserTool } from '../src/agent/core/tools/v3/askUser';
import { buildV3ToolSet } from '../src/agent/core/tools/v3/index';
import type { AskQuestion, AskResult } from '../src/shared/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMockModel } from './mockModel';
import { runAgentStream, runAskStream, runPlanStream, type AgentOpts } from '../src/agent/agent';
import { __setEngineModelForTests } from '../src/agent/core/engine';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';

let failures = 0;
let caseNo = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  caseNo++;
  const tag = cond ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${caseNo}. ${name}${cond ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
};

type Exec = (input: unknown, opts: unknown) => Promise<string | { error: string }>;
const run = (t: { execute?: unknown }, input: unknown) => (t.execute as Exec)(input, {});
const answered = (...answers: string[]): AskResult => ({ status: 'answered', answers });

async function main(): Promise<void> {
  // ── 1. Toolset wiring ─────────────────────────────────────────────────────
  const agent = buildV3ToolSet('agent');
  const plan = buildV3ToolSet('plan');
  const ask = buildV3ToolSet('ask');
  ok('1a. askUser offered in agent mode', 'askUser' in agent);
  ok('1b. askUser offered in plan mode', 'askUser' in plan);
  ok('1c. askUser offered in ask mode', 'askUser' in ask, 'ask mode is everything-but-edits, not read-only-tools-only');
  ok('1d. toolset passes the host callback through', typeof (agent.askUser as { execute?: unknown }).execute === 'function');

  // ── 2. Single question (the legacy shape still works) ─────────────────────
  const seen: AskQuestion[][] = [];
  const tool = createAskUserTool(async (qs) => { seen.push(qs); return answered('Use Postgres.'); });

  const one = await run(tool, { question: 'Which database?', options: ['Postgres', 'MySQL', ' '] });
  ok('2a. a single answer round-trips as "User response"', one === 'User response: Use Postgres.', JSON.stringify(one));
  ok('2b. the callback got one question with trimmed options',
    seen[0]?.length === 1 && seen[0][0].question === 'Which database?' && JSON.stringify(seen[0][0].options) === JSON.stringify(['Postgres', 'MySQL']), JSON.stringify(seen[0]));

  // ── 3. Several questions on one card ──────────────────────────────────────
  const multi = createAskUserTool(async (qs) => { seen.push(qs); return answered('Postgres', 'API and CLI'); });
  const many = await run(multi, { questions: [
    { question: 'Which database?', header: 'DB', options: ['Postgres — the default we already run', 'MySQL — needs a new driver'] },
    { question: 'Which surfaces need it?', header: 'Scope', options: ['API', 'CLI'], multiSelect: true },
  ] });
  ok('3a. two questions reach the host in ONE call, header and multiSelect kept',
    seen[1]?.length === 2 && seen[1][0].header === 'DB' && seen[1][1].multiSelect === true, JSON.stringify(seen[1]));
  ok('3b. answers come back paired with their questions',
    typeof many === 'string' && many.includes('1. Which database? → Postgres') && many.includes('2. Which surfaces need it? → API and CLI'), JSON.stringify(many));
  const five = await run(multi, { questions: Array.from({ length: 6 }, (_, i) => ({ question: `Q${i + 1}?` })) });
  ok('3c. more than four questions is capped at four', seen.at(-1)?.length === 4 || (typeof five === 'object' && five !== null && 'error' in five), JSON.stringify(seen.at(-1)?.length));
  const blankInside = await run(multi, { questions: [{ question: '  ' }, { question: 'Real one?' }] });
  ok('3d. blank questions are dropped, the real one is asked', typeof blankInside === 'string' && seen.at(-1)?.length === 1 && seen.at(-1)?.[0].question === 'Real one?', JSON.stringify(blankInside));

  // ── 4. Dismissed is not cancelled ─────────────────────────────────────────
  const skipped = createAskUserTool(async () => ({ status: 'dismissed', answers: [] }), 'agent');
  const skippedAgent = await run(skipped, { question: 'Proceed?' });
  ok('4a. a skipped question outside plan mode is a "no", never "proceed with the safest approach"',
    typeof skippedAgent === 'string' && /chose not to go ahead/.test(skippedAgent) && !/safest/.test(skippedAgent), JSON.stringify(skippedAgent));
  const skippedPlan = await run(createAskUserTool(async () => ({ status: 'dismissed', answers: [] }), 'plan'), { question: 'Which fix?' });
  ok('4b. in plan mode a skip means ask again or state the assumption — never "just guess"',
    typeof skippedPlan === 'string' && /ask ONCE more/.test(skippedPlan) && /interpretation/.test(skippedPlan) && !/safest/.test(skippedPlan), JSON.stringify(skippedPlan));
  const cancelled = await run(createAskUserTool(async () => ({ status: 'cancelled', answers: [] }), 'plan'), { question: 'Which fix?' });
  ok('4c. a cancelled turn is reported as cancelled, not as a skip',
    typeof cancelled === 'string' && /cancelled/.test(cancelled) && !/skipped/.test(cancelled), JSON.stringify(cancelled));
  const emptyAnswer = await run(createAskUserTool(async () => answered('', '  '), 'plan'), { questions: [{ question: 'A?' }, { question: 'B?' }] });
  ok('4d. an "answered" result with only blank answers counts as a skip',
    typeof emptyAnswer === 'string' && /skipped/.test(emptyAnswer), JSON.stringify(emptyAnswer));

  // ── 5. Degenerate input ───────────────────────────────────────────────────
  const noCallback = createAskUserTool();
  const unavailable = await run(noCallback, { question: 'Q?' });
  ok('5a. no host callback degrades to { error }',
    typeof unavailable === 'object' && unavailable !== null && 'error' in unavailable, JSON.stringify(unavailable));
  const blank = await run(tool, { question: '   ' });
  ok('5b. an empty question returns { error }', typeof blank === 'object' && blank !== null && 'error' in blank, JSON.stringify(blank));
  const neither = await run(tool, {});
  ok('5c. no question at all returns { error } that names `questions`',
    typeof neither === 'object' && neither !== null && 'error' in neither && /questions/.test((neither as { error: string }).error), JSON.stringify(neither));

  // ── 6. The engine ends an agent/ask turn on a skip (live report 2026-09-29: skip → it edited) ──
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ask-'));
    fs.writeFileSync(path.join(root, 'A.php'), 'hello world\n');
    const script = (then: Record<string, unknown>) => [
      { toolCalls: [{ toolName: 'askUser', input: { question: 'Change A.php?', options: ['Yes', 'No'] } }] },
      then,
      { text: 'done' },
    ];
    const edit = { toolCalls: [{ toolName: 'editFile', input: { path: 'A.php', search: 'hello', replace: 'bye' } }] };
    const turn = async (mode: 'agent' | 'ask' | 'plan', steps: unknown[], reply: AskResult) => {
      const m = createMockModel(steps as never, `ask-${mode}`);
      __setEngineModelForTests(m);
      const runner = mode === 'agent' ? runAgentStream : mode === 'ask' ? runAskStream : runPlanStream;
      try {
        const r = await runWithWorkspaceRoot(root, () => runner({
          messages: [{ role: 'user', content: 'update A.php' }], mode, effort: 'medium', autoApprove: true,
          onChunk: () => {}, onTool: () => {}, onReasoning: () => {}, onModel: () => {}, onFailover: () => {}, onStep: () => {}, onTodos: () => {},
          onAskUser: async () => reply, onError: () => {},
        } as unknown as AgentOpts));
        return { m, r };
      } finally { __setEngineModelForTests(undefined); }
    };
    const skip: AskResult = { status: 'dismissed', answers: [] };

    const a = await turn('agent', script(edit), skip);
    ok('6a. agent: a skip ends the turn on that step — the edit after it never runs',
      a.m.calls.length === 1 && fs.readFileSync(path.join(root, 'A.php'), 'utf8') === 'hello world\n', `${a.m.calls.length} model calls`);
    ok('6b. agent: the reply says it stopped because of the skip, and is not a paused turn',
      /you skipped the question/.test(a.r.text) && !a.r.paused, JSON.stringify({ text: a.r.text, paused: a.r.paused }));

    const q = await turn('ask', script({ text: 'I went ahead anyway.' }), skip);
    ok('6c. ask: same stop', q.m.calls.length === 1 && /you skipped the question/.test(q.r.text), `${q.m.calls.length} model calls`);

    const blank = await turn('agent', script(edit), answered('', ' '));
    ok('6d. an "answered" card with only blank answers stops the same way', blank.m.calls.length === 1, `${blank.m.calls.length} model calls`);

    const yes = await turn('agent', script(edit), answered('Yes'));
    ok('6e. an answer resumes the turn as before (the edit runs)',
      yes.m.calls.length >= 2 && fs.readFileSync(path.join(root, 'A.php'), 'utf8') === 'bye world\n' && !/you skipped/.test(yes.r.text), `${yes.m.calls.length} model calls`);

    const PLAN = { outcome: 'plan', title: 'Change A', interpretation: 'r', steps: [{ what: 'change it', files: ['A.php'], evidence: 'A.php:1' }] };
    const p = await turn('plan', script({ toolCalls: [{ toolName: 'exitPlanMode', input: PLAN }] }), skip);
    ok('6f. plan mode keeps its rule: a skip continues to a plan (which still needs approval)',
      p.m.calls.length === 2 && !!(p.r as { plan?: unknown }).plan && !/you skipped/.test(p.r.text), `${p.m.calls.length} model calls`);
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
  process.exit(failures ? 1 : 0);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
