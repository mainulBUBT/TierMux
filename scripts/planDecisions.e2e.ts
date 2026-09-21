/* What the user answered during plan mode is recorded, shown on the plan card, written into the saved
 * plan file and handed to the execution turn — WITHOUT ever entering the steps text, because every
 * step parser scans the whole text and a "Q → A" bullet would become a fake step and a fake todo.
 * Run: npm run test:e2e:plan-decisions */
import { addDecisions, formatDecisionsForPrompt } from '../src/agent/planDecisions';
import { renderPlanMarkdown } from '../src/agent/planStructurer';
import { planStepsToTodos } from '../src/session/titles';
import type { PlanDecision } from '../src/shared/types';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const qs = [{ question: 'Which database?' }, { question: 'Which surfaces?', multiSelect: true }];

console.log('— recording —');
const first = addDecisions([], qs, { status: 'answered', answers: ['Postgres', 'API, CLI'] });
ok('every answered question is kept, paired by position', first.length === 2 && first[0].answer === 'Postgres' && first[1].answer === 'API, CLI', JSON.stringify(first));
ok('a skipped call adds nothing', addDecisions(first, qs, { status: 'dismissed', answers: [] }) === first);
ok('a cancelled call adds nothing', addDecisions(first, qs, { status: 'cancelled', answers: [] }) === first);
ok('a blank or "(no answer)" entry is not a decision', addDecisions([], qs, { status: 'answered', answers: ['', '(no answer)'] }).length === 0);
const changed = addDecisions(first, [{ question: 'Which database?' }], { status: 'answered', answers: ['MySQL'] });
ok('re-answering replaces the earlier answer and moves it to the end', changed.length === 2 && changed.at(-1)?.answer === 'MySQL' && changed.filter((d) => d.question === 'Which database?').length === 1, JSON.stringify(changed));
let many: PlanDecision[] = [];
for (let i = 0; i < 20; i++) many = addDecisions(many, [{ question: `Q${i}` }], { status: 'answered', answers: [`A${i}`] });
ok('only the newest twelve are kept', many.length === 12 && many[0].question === 'Q8' && many.at(-1)?.question === 'Q19', `${many.length} ${many[0]?.question}`);

console.log('\n— execution prompt —');
ok('nothing decided → no block', formatDecisionsForPrompt([]) === undefined);
const block = formatDecisionsForPrompt(first)!;
ok('lists each decision and forbids re-asking', block.includes('- Which database? → Postgres') && /do not re-ask/i.test(block), block);

console.log('\n— saved plan file —');
const steps = 'Reading: add a toggle\n\n1. Add a setting (`src/settings.ts`)\n2. Read it in the panel (`media/main.ts`)';
const md = renderPlanMarkdown(steps, { title: 'Toggle', status: 'approved', decisions: first, now: new Date('2026-09-21T10:00:00Z') });
ok('a ## Decisions section carries question and answer', /## Decisions\n\n- \*\*Which database\?\*\* — Postgres\n- \*\*Which surfaces\?\*\* — API, CLI/.test(md), md.slice(md.indexOf('## Decisions'), md.indexOf('## Decisions') + 140));
ok('the decisions come BEFORE the steps', md.indexOf('## Decisions') < md.indexOf('## Steps'));
ok('the step count is unaffected by them', /^steps: 2$/m.test(md), md.slice(0, 200));
const plain = renderPlanMarkdown(steps, { title: 'Toggle', status: 'approved', now: new Date('2026-09-21T10:00:00Z') });
ok('without decisions the file has no Decisions section', !plain.includes('## Decisions'));

console.log('\n— nothing leaks into the steps parsers —');
ok('the card text (steps) never contains a decision, so todos are exactly the steps', planStepsToTodos(steps).length === 2);

console.log(bad === 0 ? '\nPlan decisions hold.' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
