/* Plan mode's card, first pass AND after a Continue. The card is built from a plan-mode result; the
 * turn is NOT committed to history (approve/defer re-add it), so proposePlanCard pops the last entry
 * — the user's message on a first pass, the Continue nudge on a resume — and holds the exploration.
 * On a resume the original request and the first pass's work are ALREADY in history, so only this
 * pass's work is held (re-adding the request on approval would duplicate it).
 * Run: npm run test:e2e:plan-resume */
import { ChatViewProvider } from '../src/chatViewProvider';
import type { AgentResult } from '../src/agent/agent';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

type Session = { history: Array<{ role: string; content: unknown }>; planDecisions: Array<{ question: string; answer: string }>; pendingPlanUser?: unknown; pendingPlanWork?: unknown[]; id: string; resumeMode?: string };
interface Probe {
  proposePlanCard(s: Session, requestId: string, r: AgentResult, replyText: string, ctx: { request: string; requestContent?: unknown }): { posted: boolean; replyText: string };
  lastRequestText(s: Session): string;
}

function provider() {
  const posted: Array<Record<string, unknown>> = [];
  const files: string[] = [];
  const upgraded: string[] = [];
  const p = Object.create(ChatViewProvider.prototype) as Probe & Record<string, unknown>;
  p.postCard = (_s: unknown, card: Record<string, unknown>) => { posted.push(card); };
  p.preparePlanFile = (_s: unknown, title: string, request: string) => { files.push(`${title}|${request}`); };
  p.upgradePlanSteps = (_s: unknown, _r: string, raw: string) => { upgraded.push(raw); };
  return { p, posted, files, upgraded };
}

const work = [{ role: 'assistant', content: 'read files', tool_calls: [] }, { role: 'tool', content: 'file body' }];
const PLAN = { outcome: 'plan' as const, title: 'Add dark mode', interpretation: 'a theme toggle', steps: [{ what: 'Add setting', files: ['src/a.ts'], evidence: 'src/a.ts:1' }] };
const res = (over: Partial<AgentResult>): AgentResult => ({ text: '', workMessages: work, ...over }) as unknown as AgentResult;
const session = (history: Session['history'], decisions: Session['planDecisions'] = []): Session => ({ history, planDecisions: decisions, id: 's1' });

console.log('— first pass: the user message is popped and held —');
{
  const { p, posted, files } = provider();
  const s = session([{ role: 'user', content: 'add dark mode' }], [{ question: 'Where?', answer: 'Settings panel' }]);
  const out = p.proposePlanCard(s, 'r1', res({ plan: PLAN as never }), '', { request: 'add dark mode', requestContent: 'add dark mode' });
  ok('a tool-declared plan posts a card', out.posted && posted.length === 1 && posted[0].type === 'planProposed');
  ok('the user message left history (committed on approval)', s.history.length === 0);
  ok('and is held with the exploration', s.pendingPlanUser === 'add dark mode' && (s.pendingPlanWork as unknown[]).length === 2);
  ok('the card carries the decisions', JSON.stringify(posted[0].decisions) === JSON.stringify([{ question: 'Where?', answer: 'Settings panel' }]));
  ok('the plan file is prepared with the request', files[0] === 'Add dark mode|add dark mode', files[0]);
}

console.log('\n— a Continue that finishes the plan —');
{
  const { p, posted } = provider();
  const s = session([
    { role: 'user', content: 'add dark mode' }, { role: 'assistant', content: 'read files' }, { role: 'tool', content: 'file body' },
    { role: 'user', content: 'Continue from where you left off. Finish investigating' },
  ]);
  ok('the request behind the Continue is found', p.lastRequestText(s) === 'add dark mode', p.lastRequestText(s));
  const out = p.proposePlanCard(s, 'r2', res({ plan: PLAN as never }), '', { request: p.lastRequestText(s) });
  ok('the card is posted', out.posted && posted.length === 1);
  ok('only the Continue nudge was popped — the first pass stays in history', s.history.length === 3 && s.history[0].content === 'add dark mode');
  ok('the original request is NOT held again (it would duplicate on approval)', s.pendingPlanUser === undefined);
  ok('this pass\'s exploration is held', (s.pendingPlanWork as unknown[]).length === 2);
}

console.log('\n— what must NOT become a card —');
{
  const { p, posted } = provider();
  const prose = '1. Edit `src/a.ts` to add the setting\n2. Edit `src/b.ts` to read it';
  const paused = p.proposePlanCard(session([{ role: 'user', content: 'x' }]), 'r3', res({ paused: true }), prose, { request: 'x', requestContent: 'x' });
  ok('a PAUSED turn\'s cut-off prose is not promoted to a plan card', !paused.posted && posted.length === 0);
  const s2 = session([{ role: 'user', content: 'x' }]);
  const settled = p.proposePlanCard(s2, 'r4', res({}), prose, { request: 'x', requestContent: 'x' });
  ok('a finished turn\'s plan-shaped prose still is (weak-model fallback)', settled.posted && posted.length === 1);
  const noChange = provider();
  const s3 = session([{ role: 'user', content: 'x' }]);
  const nc = noChange.p.proposePlanCard(s3, 'r5', res({ plan: { outcome: 'no-change', title: 't', finding: 'src/a.ts:9 already does it', steps: [] } as never }), '', { request: 'x', requestContent: 'x' });
  ok('a no-change finding is an answer, not a card', !nc.posted && nc.replyText === 'src/a.ts:9 already does it' && s3.history.length === 1, JSON.stringify(nc));
}

console.log(bad === 0 ? '\nPlan card and Continue hold.' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
