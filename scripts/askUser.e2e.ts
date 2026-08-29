// askUser e2e — the mid-turn clarifying-question tool.
// Run: npm run test:e2e:ask-user

import { createAskUserTool } from '../src/agent/core/tools/v3/askUser';
import { buildV3ToolSet } from '../src/agent/core/tools/v3/index';

let failures = 0;
let caseNo = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  caseNo++;
  const tag = cond ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${caseNo}. ${name}${cond ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
};

async function main(): Promise<void> {
  // ── 1. Toolset wiring ─────────────────────────────────────────────────────
  const agent = buildV3ToolSet('agent');
  const plan = buildV3ToolSet('plan');
  const ask = buildV3ToolSet('ask');
  ok('1a. askUser offered in agent mode', 'askUser' in agent);
  ok('1b. askUser offered in plan mode', 'askUser' in plan);
  ok('1c. askUser absent in ask mode', !('askUser' in ask));
  ok('1d. toolset passes the host callback through', typeof (agent.askUser as { execute?: unknown }).execute === 'function');

  // ── 2. Tool behavior ──────────────────────────────────────────────────────
  const answers: Array<{ q: string; o?: string[] }> = [];
  const tool = createAskUserTool(async (q, o) => {
    answers.push({ q, o });
    return 'Use Postgres.';
  });
  const exec = tool.execute as (input: unknown, opts: unknown) => Promise<string | { error: string }>;

  const answered = await exec({ question: 'Which database?', options: ['Postgres', 'MySQL', ' '] }, {});
  ok('2a. answer round-trips to the model', answered === 'User response: Use Postgres.', JSON.stringify(answered));

  ok('2b. callback received question + trimmed options',
    answers[0]?.q === 'Which database?' && JSON.stringify(answers[0]?.o) === JSON.stringify(['Postgres', 'MySQL']), JSON.stringify(answers[0]));

  const dismissing = createAskUserTool(async () => '');
  const dismissed = await (dismissing.execute as (i: unknown, o: unknown) => Promise<unknown>)({ question: 'Proceed?' }, {});
  ok('2c. dismissed (empty answer) yields the safe-proceed guidance',
    typeof dismissed === 'string' && dismissed.includes('Proceed with the safest'), JSON.stringify(dismissed));

  const noCallback = createAskUserTool();
  const unavailable = await (noCallback.execute as (i: unknown, o: unknown) => Promise<unknown>)({ question: 'Q?' }, {});
  ok('2d. no host callback degrades to { error }',
    typeof unavailable === 'object' && unavailable !== null && 'error' in unavailable, JSON.stringify(unavailable));

  const blank = await exec({ question: '   ' }, {});
  ok('2e. empty question returns { error }',
    typeof blank === 'object' && blank !== null && 'error' in blank, JSON.stringify(blank));

  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
  process.exit(failures ? 1 : 0);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
