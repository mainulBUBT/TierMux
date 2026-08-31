// exitPlanMode e2e — plan mode's planning→execution boundary as an explicit TOOL CALL.
//
// What this locks down (the 2026-08-31 plan-mode redesign):
//   1. Toolset wiring — the tool exists ONLY in plan mode; plan mode still has no editors.
//   2. Policy      — it is read-only, so it never puts an "Allow exitPlanMode?" prompt in
//                    front of the real approval UI; edits stay hard-denied.
//   3. Tool        — cleans/validates its input, hands the structure to the host, degrades to
//                    { error } with no host callback (sub-agent/e2e contexts).
//   4. Engine      — drives the REAL engine through the __setEngineModelForTests seam: the
//                    tool call lands in AgentResult.plan AND ENDS THE TURN (stopWhen), so no
//                    second model call re-narrates the plan under the card.
//   5. Card text   — formatPlanForCard round-trips through the webview's OWN parsers
//                    (Plan.ts parsePlanSteps + detectStepFiles), so no webview change is
//                    needed to render a structured plan.
//   6. isCleanNumberedList — the guard that skips the structurer model call for a plan that
//                    is already clean.
//
// Run: npm run test:e2e:exit-plan-mode

import { createExitPlanModeTool } from '../src/agent/core/tools/v3/exitPlanMode';
import { buildV3ToolSet } from '../src/agent/core/tools/v3/index';
import { formatPlanForCard, isCleanNumberedList, parsePlanStepLine, renderPlanMarkdown } from '../src/agent/planStructurer';
import { resolvePolicy, defaultPolicy } from '../src/permissions/policy';
import { createMockModel } from '../src/agent/poc/mockModel';
import { runPlanStream } from '../src/agent/agent';
import { __setEngineModelForTests } from '../src/agent/core/engine';
import type { AgentOpts } from '../src/agent/agent';
import type { ProposedPlan } from '../src/shared/types';

let failures = 0;
let caseNo = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  caseNo++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${caseNo}. ${name}${cond ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
};

// Mirrors media/src/ui/components/Plan.ts's own regexes — the webview bundle can't be imported
// here, so the round-trip is asserted against copies of the exact patterns it ships.
const PARSE_STEP_RE = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/;
const parsePlanSteps = (steps: string): string[] =>
  steps.split('\n').map((l) => l.match(PARSE_STEP_RE)?.[1]?.replace(/\*\*/g, '').trim()).filter((t): t is string => !!t);
const detectStepFiles = (text: string): string[] =>
  (text.match(/`([^`]+)`/g) || []).map((s) => s.slice(1, -1).trim()).filter((s) => s && !/\s/.test(s));

const PLAN: ProposedPlan = {
  title: 'Add dark mode',
  description: 'Wire a theme toggle through the settings panel.',
  steps: [
    { what: 'Add a themeMode setting', files: ['src/settingsMeta.ts'], verify: 'npm run typecheck' },
    { what: 'Read the toggle in the webview', files: ['media/src/main.ts', 'media/main.css'] },
    { what: 'Document the setting' },
  ],
};

function engineOpts(over: Partial<AgentOpts> & { messages: AgentOpts['messages'] }): AgentOpts {
  return {
    mode: 'plan',
    effort: 'medium',
    onChunk: () => {},
    onTool: () => {},
    onReasoning: () => {},
    onModel: () => {},
    onFailover: () => {},
    onStep: () => {},
    onTodos: () => {},
    onAskUser: async () => 'yes',
    onError: () => {},
    ...over,
  };
}

async function main(): Promise<void> {
  // ── 1. Toolset wiring ──────────────────────────────────────────────────────
  const plan = buildV3ToolSet('plan');
  const agent = buildV3ToolSet('agent');
  const ask = buildV3ToolSet('ask');
  ok('exitPlanMode offered in plan mode', 'exitPlanMode' in plan);
  ok('exitPlanMode absent in agent mode', !('exitPlanMode' in agent), 'agent mode does the work, it does not propose');
  ok('exitPlanMode absent in ask mode', !('exitPlanMode' in ask));
  ok('plan mode still has no editors', !('editFile' in plan) && !('writeFile' in plan) && !('deleteFile' in plan));

  // ── 2. Policy ──────────────────────────────────────────────────────────────
  const planPolicy = { ...defaultPolicy, sessionMode: 'plan' as const, alwaysAllow: new Set<string>(), alwaysDeny: new Set<string>() };
  const verdict = await resolvePolicy({ toolName: 'exitPlanMode' }, planPolicy);
  ok('exitPlanMode auto-approved in plan mode', (verdict as { type: string }).type === 'approved', JSON.stringify(verdict));
  const editVerdict = await resolvePolicy({ toolName: 'editFile' }, { ...planPolicy, alwaysAllow: new Set(['editFile']) });
  ok('edits still hard-denied in plan mode', (editVerdict as { type: string }).type === 'denied', JSON.stringify(editVerdict));

  // ── 3. Tool behavior ───────────────────────────────────────────────────────
  const seen: ProposedPlan[] = [];
  const tool = createExitPlanModeTool((p) => { seen.push(p); });
  const exec = tool.execute as (i: unknown, o: unknown) => Promise<unknown>;

  const okRes = await exec({ title: '  Add dark mode  ', description: ' ctx ', steps: [
    { what: ' Add a setting ', files: [' src/settingsMeta.ts '], verify: ' npm run typecheck ' },
    { what: '   ' },
  ] }, {});
  ok('valid call hands the plan to the host', seen.length === 1 && seen[0].title === 'Add dark mode', JSON.stringify(seen[0]));
  ok('blank steps are dropped, text trimmed',
    seen[0]?.steps.length === 1 && seen[0].steps[0].what === 'Add a setting'
    && seen[0].steps[0].files?.[0] === 'src/settingsMeta.ts' && seen[0].steps[0].verify === 'npm run typecheck',
    JSON.stringify(seen[0]?.steps));
  ok('model is told to stop, not to restate the plan',
    typeof okRes === 'string' && /approval/i.test(okRes) && /stop/i.test(okRes), JSON.stringify(okRes));

  const empty = await exec({ title: 'x', steps: [{ what: '  ' }] }, {});
  ok('all-blank steps return { error }, no card posted',
    typeof empty === 'object' && empty !== null && 'error' in empty && seen.length === 1, JSON.stringify(empty));

  const headless = await (createExitPlanModeTool().execute as (i: unknown, o: unknown) => Promise<unknown>)(
    { title: 'x', steps: [{ what: 'do a thing' }] }, {});
  ok('no host callback degrades to { error }',
    typeof headless === 'object' && headless !== null && 'error' in headless, JSON.stringify(headless));

  // ── 4. Engine integration (REAL engine via the model seam) ─────────────────
  {
    const model = createMockModel([
      { toolCalls: [{ toolName: 'exitPlanMode', input: PLAN }] },
      // Scripted but must never be reached: stopWhen ends the turn on the tool call. If the
      // engine took a second step, the script would hand it this text and the assertion below
      // on calls.length would fail — script exhaustion is not what proves it.
      { text: 'So, as I said, here is the plan again...' },
    ], 'exit-plan');
    __setEngineModelForTests(model);
    let result;
    try {
      result = await runPlanStream(undefined as never, engineOpts({
        messages: [{ role: 'user', content: 'add dark mode' }],
      }));
    } finally {
      __setEngineModelForTests(undefined);
    }
    ok('engine surfaces the plan as validated structure on AgentResult.plan',
      result.plan?.title === 'Add dark mode' && result.plan?.steps.length === 3,
      JSON.stringify(result.plan));
    ok('step details survive the round trip',
      result.plan?.steps[0].files?.[0] === 'src/settingsMeta.ts' && result.plan?.steps[0].verify === 'npm run typecheck',
      JSON.stringify(result.plan?.steps[0]));
    ok('the turn ENDS on exitPlanMode — no second model call re-narrates the plan',
      model.calls.length === 1, `calls=${model.calls.length}`);
    ok('exitPlanMode was actually offered to the model',
      model.calls[0].tools.includes('exitPlanMode'), JSON.stringify(model.calls[0].tools));

    // A plan-mode turn that does NOT call the tool must leave result.plan undefined, so the
    // host renders a normal answer instead of a plan card. This is the "a finding is not a
    // plan" case the old regex+LLM classifier kept getting wrong in both directions.
    const answerModel = createMockModel([{ text: 'Stock IS checked on order edit — see src/orders.ts:412.' }], 'answer');
    __setEngineModelForTests(answerModel);
    try {
      const answer = await runPlanStream(undefined as never, engineOpts({
        messages: [{ role: 'user', content: 'is stock checked on order edit?' }],
      }));
      ok('a plan-mode ANSWER leaves result.plan undefined', answer.plan === undefined, JSON.stringify(answer.plan));
      ok('the answer text still ships', answer.text.includes('src/orders.ts:412'), answer.text);
    } finally {
      __setEngineModelForTests(undefined);
    }
  }

  // ── 4b. plan-gap continuation nudge ────────────────────────────────────────
  // Live repro (2026-08-31, Ollama/nemotron-3-ultra, "add a dark mode toggle to setting"):
  // the model read its way through the codebase and then ended the turn on "Now let me check
  // if there's any existing theme or dark mode support…" — no exitPlanMode call, so no plan
  // card and 236 output tokens of narration shipped as the answer.
  {
    const model = createMockModel([
      { toolCalls: [{ toolName: 'grep', input: { pattern: 'dark', path: '.' } }] },
      { text: 'Now let me check if there is any existing theme or dark mode support.' },
      { toolCalls: [{ toolName: 'exitPlanMode', input: PLAN }] },
    ], 'plan-gap');
    const retracted: number[] = [];
    __setEngineModelForTests(model);
    try {
      const nudged = await runPlanStream(undefined as never, engineOpts({
        messages: [{ role: 'user', content: 'add a dark mode toggle to setting' }],
        onRetractDraft: () => retracted.push(1),
      }));
      ok('narration with no exitPlanMode call is nudged into presenting the plan',
        nudged.plan?.title === 'Add dark mode', JSON.stringify(nudged.plan));
      ok('the abandoned narration draft is retracted, not stacked under the card',
        retracted.length === 1, `retracted=${retracted.length}`);
      ok('exactly ONE continuation (invariant 3: no ladder)',
        model.calls.length === 3, `calls=${model.calls.length}`);
      // The continuation does not merely ASK for the plan — its first step is sent with
      // toolChoice pinned to exitPlanMode, so a model that ignores prose instructions still
      // has to produce one. Earlier steps must stay on 'auto' or investigation is impossible.
      ok('the continuation FORCES exitPlanMode via toolChoice',
        JSON.stringify(model.calls[2].toolChoice) === '{"type":"tool","toolName":"exitPlanMode"}',
        JSON.stringify(model.calls[2].toolChoice));
      ok('investigation steps are never forced',
        model.calls.slice(0, 2).every((c) => c.toolChoice === undefined || (c.toolChoice as { type?: string })?.type === 'auto'),
        JSON.stringify(model.calls.map((c) => c.toolChoice)));
    } finally {
      __setEngineModelForTests(undefined);
    }
  }
  {
    // A real prose answer in plan mode is NOT narration — it must ship untouched. The script
    // holds only one response, so a nudge here would abort with "script exhausted".
    const model = createMockModel([
      { text: 'The settings panel already themes off VS Code tokens (media/main.css:1-40); nothing to add.' },
    ], 'plan-answer');
    __setEngineModelForTests(model);
    try {
      const out = await runPlanStream(undefined as never, engineOpts({
        messages: [{ role: 'user', content: 'add a dark mode toggle to setting' }],
      }));
      ok('a real plan-mode answer is never nudged', model.calls.length === 1, `calls=${model.calls.length}`);
      ok('and is never forced into a tool call',
        model.calls[0].toolChoice === undefined || (model.calls[0].toolChoice as { type?: string })?.type === 'auto',
        JSON.stringify(model.calls[0].toolChoice));
      ok('and it ships verbatim', out.text.includes('media/main.css:1-40'), out.text);
    } finally {
      __setEngineModelForTests(undefined);
    }
  }
  {
    // Narration in reply to a QUESTION stays unnudged — plan mode answers questions in prose,
    // and forcing a plan onto one is the exact failure the old regex+classifier kept making.
    const model = createMockModel([
      { text: 'Let me look at how the theme is currently wired.' },
    ], 'plan-question');
    __setEngineModelForTests(model);
    try {
      await runPlanStream(undefined as never, engineOpts({
        messages: [{ role: 'user', content: 'how does the settings panel pick its theme?' }],
      }));
      ok('a QUESTION is not nudged toward a plan', model.calls.length === 1, `calls=${model.calls.length}`);
    } finally {
      __setEngineModelForTests(undefined);
    }
  }

  // ── 5. Card text round-trip (webview's own parsers) ────────────────────────
  const card = formatPlanForCard(PLAN);
  const parsed = parsePlanSteps(card);
  ok('every step becomes exactly one card bullet', parsed.length === 3, `${parsed.length}: ${JSON.stringify(parsed)}`);
  ok('description lands ABOVE the first bullet (where Plan.ts looks for it)',
    card.indexOf('Wire a theme toggle') < card.indexOf('1. '), card.slice(0, 80));
  ok('declared files are backticked so the card\'s "N files" summary counts them',
    JSON.stringify(new Set(parsed.flatMap(detectStepFiles)).size) === '3',
    JSON.stringify(parsed.flatMap(detectStepFiles)));
  ok('verify text rides along on the step line', parsed[0].includes('npm run typecheck'), parsed[0]);
  ok('a step with no files/verify stays a bare action', parsed[2] === 'Document the setting', parsed[2]);

  // ── 6. isCleanNumberedList (skips the structurer model call) ───────────────
  ok('tool-declared plan text is recognized as already clean', isCleanNumberedList(card));
  ok('the card\'s own re-serialization is clean too', isCleanNumberedList('1. Do a thing\n2. Do another'));
  ok('ragged prose is NOT clean (structurer still runs)',
    !isCleanNumberedList('First I would change the header.\nThen the footer.'));
  ok('mixed bullets are NOT clean', !isCleanNumberedList('- one\n1. two'));
  ok('empty text is NOT clean', !isCleanNumberedList('   '));

  // ── 7. The saved plan.md document ─────────────────────────────────────────
  {
    const md = renderPlanMarkdown(card, {
      title: 'Add dark mode',
      request: 'add a dark mode toggle to setting',
      status: 'executing',
      model: 'Ollama/nemotron-3-ultra',
      sessionId: 'sess-8f21',
      now: new Date('2026-08-31T15:06:12'),
    });
    ok('opens with YAML frontmatter', md.startsWith('---\n'), md.slice(0, 40));
    ok('created is a sortable ISO timestamp with offset, not a locale string',
      /^created: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/m.test(md),
      md.split('\n').find((l) => l.startsWith('created:')));
    ok('status distinguishes Execute from Save', /^status: executing$/m.test(md));
    ok('the frontmatter lists every touched file once',
      /^files:\n {2}- "src\/settingsMeta\.ts"\n {2}- "media\/src\/main\.ts"\n {2}- "media\/main\.css"$/m.test(md), md);
    ok('the original request is preserved — a saved plan can explain itself',
      md.includes('> **Request** — add a dark mode toggle to setting'));
    ok('the plan description survives as prose', md.includes('Wire a theme toggle through the settings panel.'));
    ok('steps stay checkboxes so the file works as a live checklist',
      (md.match(/^- \[ \] /gm) ?? []).length === 3, md);
    ok('files and verify are sub-bullets, not crammed into the checkbox line',
      md.includes('- [ ] Add a themeMode setting\n  - Files: `src/settingsMeta.ts`\n  - Verify: npm run typecheck'), md);
    ok('a step with no files/verify gets no empty sub-bullets',
      md.includes('- [ ] Document the setting\n'), md);
    ok('quotes in a title cannot break the YAML',
      renderPlanMarkdown('1. x', { title: 'Add "dark" mode', status: 'approved' }).includes('title: "Add \\"dark\\" mode"'));
    ok('a plan with no parsable steps still renders a valid document',
      renderPlanMarkdown('', { title: 'Empty', status: 'approved' }).includes('_No steps._'));
  }
  {
    const a = parsePlanStepLine('Add a themeMode setting (`src/settingsMeta.ts`, `a/b.ts`) — verify: npm run typecheck');
    ok('a card line round-trips back into what/files/verify',
      a.what === 'Add a themeMode setting' && a.files.length === 2 && a.verify === 'npm run typecheck',
      JSON.stringify(a));
    const b = parsePlanStepLine('Just do the thing');
    ok('a hand-typed step with no decoration parses as plain text',
      b.what === 'Just do the thing' && b.files.length === 0 && b.verify === undefined, JSON.stringify(b));
    const c = parsePlanStepLine('Rename `foo` to `bar` in the docs');
    ok('mid-sentence backticks are not mistaken for a file list',
      c.what === 'Rename `foo` to `bar` in the docs' && c.files.length === 0, JSON.stringify(c));
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures ? 1 : 0);
}

main().catch((e: unknown) => { console.error('FATAL', e); process.exit(1); });
