// exitPlanMode e2e — the planning→execution boundary as an explicit TOOL CALL (2026-08-31).
// Locks down: the tool exists only in plan mode (no editors there); it is read-only so it never
// prompts; it validates input and degrades to { error } without a host; through the real engine
// the call lands in AgentResult.plan AND ends the turn; formatPlanForCard round-trips through
// the webview's own parsers; isCleanNumberedList skips the structurer for a clean plan.
// Run: npm run test:e2e:exit-plan-mode

import { createExitPlanModeTool } from '../src/agent/core/tools/v3/exitPlanMode';
import { buildV3ToolSet } from '../src/agent/core/tools/v3/index';
import { formatPlanForCard, isCleanNumberedList, parsePlanStepLine, renderPlanMarkdown } from '../src/agent/planStructurer';
import { resolvePolicy, defaultPolicy } from '../src/permissions/policy';
import { createMockModel } from './mockModel';
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
  outcome: 'plan',
  title: 'Add dark mode',
  interpretation: 'the settings panel should offer a light/dark choice the webview honours',
  description: 'Wire a theme toggle through the settings panel.',
  steps: [
    { what: 'Add a themeMode setting', files: ['src/settingsMeta.ts'], evidence: 'src/settingsMeta.ts:40 has no theme entry', verify: 'npm run typecheck' },
    { what: 'Read the toggle in the webview', files: ['media/src/main.ts', 'media/main.css'], evidence: 'media/src/main.ts:210 hardcodes the light palette' },
    { what: 'Document the setting', files: ['README.md'], evidence: 'README.md:60 lists every setting but this one' },
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

  const okRes = await exec({ outcome: 'plan', title: '  Add dark mode  ', description: ' ctx ', interpretation: ' the panel should offer a light/dark choice ', steps: [
    { what: ' Add a setting ', files: [' src/settingsMeta.ts '], evidence: ' src/settingsMeta.ts:40 has no theme entry ', verify: ' npm run typecheck ' },
    { what: '   ' },
  ] }, {});
  ok('valid call hands the plan to the host', seen.length === 1 && seen[0].title === 'Add dark mode', JSON.stringify(seen[0]));
  ok('blank steps are dropped, text trimmed',
    seen[0]?.steps.length === 1 && seen[0].steps[0].what === 'Add a setting'
    && seen[0].steps[0].files?.[0] === 'src/settingsMeta.ts' && seen[0].steps[0].verify === 'npm run typecheck',
    JSON.stringify(seen[0]?.steps));
  ok('evidence survives to the card', seen[0]?.steps[0].evidence === 'src/settingsMeta.ts:40 has no theme entry', JSON.stringify(seen[0]?.steps[0]));
  ok('model is told to stop, not to restate the plan',
    typeof okRes === 'string' && /approval/i.test(okRes) && /stop/i.test(okRes), JSON.stringify(okRes));

  const empty = await exec({ outcome: 'plan', title: 'x', interpretation: 'r', steps: [{ what: '  ' }] }, {});
  ok('all-blank steps return { error }, no card posted',
    typeof empty === 'object' && empty !== null && 'error' in empty && seen.length === 1, JSON.stringify(empty));

  // The 2026-09-01 repro's shape: a step that changes nothing and rests on nothing. It used to
  // be a VALID plan (files/evidence were optional), which is how a two-step no-op plan shipped
  // to the card as if it fixed the reported bug.
  const ungrounded = await exec({ outcome: 'plan', title: 'x', interpretation: 'r', steps: [
    { what: 'Confirm no view-side change is needed', files: ['resources/views/order-view.blade.php'] },
  ] }, {});
  ok('a step with no evidence is rejected',
    typeof ungrounded === 'object' && ungrounded !== null && 'error' in ungrounded
    && /evidence/i.test((ungrounded as { error: string }).error) && seen.length === 1,
    JSON.stringify(ungrounded));
  const fileless = await exec({ outcome: 'plan', title: 'x', interpretation: 'r', steps: [
    { what: 'Re-read the controller and confirm it is fine', evidence: 'OrderController.php:250' },
  ] }, {});
  ok('a step that changes no file is rejected',
    typeof fileless === 'object' && fileless !== null && 'error' in fileless && seen.length === 1,
    JSON.stringify(fileless));

  // "Nothing needs changing" is now its OWN outcome instead of a fake verification step.
  const noChange = await exec({ outcome: 'no-change', title: 'Filtering is already correct',
    finding: 'Item::scopeActive (app/Models/Item.php:100) already excludes status=0 items.' }, {});
  ok('outcome "no-change" posts a finding, not steps',
    seen.length === 2 && seen[1].outcome === 'no-change' && !!seen[1].finding && seen[1].steps.length === 0,
    JSON.stringify(seen[1]));
  ok('"no-change" tells the model there is nothing to implement',
    typeof noChange === 'string' && /nothing to implement/i.test(noChange), JSON.stringify(noChange));
  const noFinding = await exec({ outcome: 'no-change', title: 'x' }, {});
  ok('"no-change" without a finding is rejected',
    typeof noFinding === 'object' && noFinding !== null && 'error' in noFinding && seen.length === 2,
    JSON.stringify(noFinding));

  // The premise, stated. A plan can be right in every step and still implement the wrong
  // request — the 2026-09-01 vendor-order repro inverted the requirement while every step
  // carried genuine evidence. Nothing here judges whether the reading is CORRECT; it only
  // refuses a plan that never states one.
  const noReading = await exec({ outcome: 'plan', title: 'x', steps: [
    { what: 'Change a thing', files: ['a.ts'], evidence: 'a.ts:1' },
  ] }, {});
  ok('a plan with no interpretation is rejected',
    typeof noReading === 'object' && noReading !== null && 'error' in noReading
    && /interpretation/i.test((noReading as { error: string }).error), JSON.stringify(noReading));

  // Questions belong BEFORE the plan (2026-09-01): they go out one at a time on askUser's
  // question card, and the plan card carries nothing but the settled premise + steps. The tool
  // itself documented a `questions` field until that day, so a model shaped on TierMux's own
  // schema still sends it — the schema is passthrough (not strip) precisely so the doubt stays
  // visible here and is REJECTED with a route to askUser, instead of being silently swallowed
  // into an approvable plan. Same for the retired `approach` field.
  const beforeQ = seen.length;
  const withQ = await exec({ outcome: 'plan', title: 'Hide off-category items',
    interpretation: 'items under an off category should be hidden in edit mode',
    questions: [{ question: 'Fix the shared scope or only the vendor view?', background: 'Item.php:120 checks the parent only', options: ['Shared scope', 'Vendor view only'] }],
    steps: [{ what: 'Add a sub-category status check', files: ['app/Models/Item.php'], evidence: 'app/Models/Item.php:120' }] }, {});
  ok('a plan stuffed with questions is rejected, not silently swallowed',
    typeof withQ === 'object' && withQ !== null && 'error' in withQ
    && /askUser/i.test((withQ as { error: string }).error) && seen.length === beforeQ,
    JSON.stringify(withQ));
  const withApproach = await exec({ outcome: 'plan', title: 'x', interpretation: 'r',
    approach: 'fix it in the shared scope',
    steps: [{ what: 'Add the check', files: ['a.ts'], evidence: 'a.ts:1' }] }, {});
  ok('the retired `approach` field is rejected the same way',
    typeof withApproach === 'object' && withApproach !== null && 'error' in withApproach
    && /approach/i.test((withApproach as { error: string }).error) && seen.length === beforeQ,
    JSON.stringify(withApproach));
  ok('interpretation reaches the host',
    seen[0].interpretation === 'the panel should offer a light/dark choice', JSON.stringify(seen[0].interpretation));

  // Hesitation now has a name, and it routes to askUser instead of to a guessed plan.
  const beforeUnsure = seen.length;
  const unsure = await exec({ outcome: 'needs-decision', title: 'Fix globally or locally?' }, {});
  ok('outcome "needs-decision" is refused and points at askUser',
    typeof unsure === 'object' && unsure !== null && 'error' in unsure
    && /askUser/i.test((unsure as { error: string }).error) && seen.length === beforeUnsure,
    JSON.stringify(unsure));

  const headless = await (createExitPlanModeTool().execute as (i: unknown, o: unknown) => Promise<unknown>)(
    { outcome: 'plan', title: 'x', interpretation: 'r', steps: [{ what: 'do a thing', files: ['a.ts'], evidence: 'a.ts:1' }] }, {});
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
      result = await runPlanStream(engineOpts({
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
  }

  // ── 4b. A REJECTED plan does not end the turn: stopWhen used to fire on the CALL, so a plan
  // the tool refused ended the turn with no card. `planAccepted` stops on the accepted RESULT,
  // keeping the SDK's tool-error path open so the model re-submits — every schema rejection
  // reason is only safe because of this.
  {
    const model = createMockModel([
      { toolCalls: [{ toolName: 'exitPlanMode', input: { outcome: 'plan', title: 'x', interpretation: 'r', steps: [{ what: '   ' }] } }] },
      { toolCalls: [{ toolName: 'exitPlanMode', input: PLAN }] },
    ], 'exit-plan-retry');
    __setEngineModelForTests(model);
    let retried;
    try {
      retried = await runPlanStream(engineOpts({
        messages: [{ role: 'user', content: 'add dark mode' }],
      }));
    } finally {
      __setEngineModelForTests(undefined);
    }
    ok('a rejected plan does NOT end the turn — the model gets the error and re-submits',
      model.calls.length === 2, `calls=${model.calls.length}`);
    ok('the re-submitted plan is the one that reaches the host',
      retried.plan?.title === 'Add dark mode' && retried.plan?.steps.length === 3,
      JSON.stringify(retried.plan));

    // A plan-mode turn that does NOT call the tool must leave result.plan undefined, so the
    // host renders a normal answer instead of a plan card. This is the "a finding is not a
    // plan" case the old regex+LLM classifier kept getting wrong in both directions.
    const answerModel = createMockModel([{ text: 'Stock IS checked on order edit — see src/orders.ts:412.' }], 'answer');
    __setEngineModelForTests(answerModel);
    try {
      const answer = await runPlanStream(engineOpts({
        messages: [{ role: 'user', content: 'is stock checked on order edit?' }],
      }));
      ok('a plan-mode ANSWER leaves result.plan undefined', answer.plan === undefined, JSON.stringify(answer.plan));
      ok('the answer text still ships', answer.text.includes('src/orders.ts:412'), answer.text);
    } finally {
      __setEngineModelForTests(undefined);
    }
  }

  // ── 4b. plan-gap continuation nudge — 2026-08-31, nemotron-3-ultra ended the turn on "Now let
  // me check if there's any existing theme…": no exitPlanMode call, 236 tokens of narration
  // shipped as the answer.
  // ── 4c. The nudge accepts a QUESTION as a valid close — 2026-09-01: the model narrated a
  // hesitation instead of asking, and the old toolChoice pin compelled a plan that changed
  // nothing. Asking must be a way to finish the nudged step.
  {
    const model = createMockModel([
      { toolCalls: [{ toolName: 'grep', input: { pattern: 'scopeActive', path: '.' } }] },
      { text: 'Let me re-read the user\'s actual words carefully before presenting the plan.' },
      { toolCalls: [{ toolName: 'askUser', input: {
        question: 'Fix it globally in scopeActive(), or only in the vendor order view?',
        options: ['Globally in scopeActive()', 'Only the vendor order view'],
      } }] },
      { text: 'Understood — scoping it to the vendor order view.' },
    ], 'plan-gap-ask');
    const asked: string[] = [];
    __setEngineModelForTests(model);
    try {
      const out = await runPlanStream(engineOpts({
        messages: [{ role: 'user', content: 'make the edit-mode grid filter like the admin one' }],
        onAskUser: async (q) => { asked.push(q); return 'Only the vendor order view'; },
      }));
      ok('a hesitating model may close the nudged step by ASKING, not by inventing a plan',
        asked.length === 1 && /globally|vendor order view/i.test(asked[0]), JSON.stringify(asked));
      ok('asking does not fabricate a plan card', out.plan === undefined, JSON.stringify(out.plan));
      ok('askUser does not end the turn — the answer comes back and the loop continues',
        model.calls.length === 4, `calls=${model.calls.length}`);
    } finally {
      __setEngineModelForTests(undefined);
    }
  }

  {
    const model = createMockModel([
      { toolCalls: [{ toolName: 'grep', input: { pattern: 'dark', path: '.' } }] },
      { text: 'Now let me check if there is any existing theme or dark mode support.' },
      { toolCalls: [{ toolName: 'exitPlanMode', input: PLAN }] },
    ], 'plan-gap');
    const retracted: number[] = [];
    __setEngineModelForTests(model);
    try {
      const nudged = await runPlanStream(engineOpts({
        messages: [{ role: 'user', content: 'add a dark mode toggle to setting' }],
        onRetractDraft: () => retracted.push(1),
      }));
      ok('narration with no exitPlanMode call is nudged into presenting the plan',
        nudged.plan?.title === 'Add dark mode', JSON.stringify(nudged.plan));
      ok('the abandoned narration draft is retracted, not stacked under the card',
        retracted.length === 1, `retracted=${retracted.length}`);
      ok('exactly ONE continuation (invariant 3: no ladder)',
        model.calls.length === 3, `calls=${model.calls.length}`);
      // The continuation does not merely ASK the model to finish — its first step is sent with
      // toolChoice 'required', so a model that ignores prose instructions still cannot narrate
      // a third time. Earlier steps must stay on 'auto' or investigation is impossible.
      ok('the continuation FORCES a closing tool call',
        JSON.stringify(model.calls[2].toolChoice) === '{"type":"required"}',
        JSON.stringify(model.calls[2].toolChoice));
      // …but it does NOT dictate WHICH close. Pinning exitPlanMode (the pre-2026-09-01 shape)
      // compelled a guess out of a model that had hesitated, since looksLikeQuestion only
      // catches hesitation phrased as a question. Both closers are offered; nothing else is.
      ok('the forced step offers exitPlanMode AND askUser, and nothing else',
        JSON.stringify([...model.calls[2].tools].sort()) === JSON.stringify(['askUser', 'exitPlanMode']),
        JSON.stringify(model.calls[2].tools));
      ok('investigation steps are never forced',
        model.calls.slice(0, 2).every((c) => c.toolChoice === undefined || (c.toolChoice as { type?: string })?.type === 'auto'),
        JSON.stringify(model.calls.map((c) => c.toolChoice)));
    } finally {
      __setEngineModelForTests(undefined);
    }
  }
  {
    // CONTRACT CHANGE (2026-09-01): a prose "nothing to add" reply to a CHANGE request is a
    // finding delivered the wrong way, and it is now nudged into declaring itself — exactly as
    // agent mode nudges "I would edit X" into editing. The tool-boundary doctrine is that the
    // model DECLARES the outcome and the host never classifies prose; before outcome
    // 'no-change' existed there was no tool to declare this with, so the reply had to be let
    // through. There is one now, and the nudge's forced step offers it.
    const model = createMockModel([
      { text: 'The settings panel already themes off VS Code tokens (media/main.css:1-40); nothing to add.' },
      { toolCalls: [{ toolName: 'exitPlanMode', input: {
        outcome: 'no-change', title: 'Already themed',
        finding: 'media/main.css:1-40 already themes off VS Code tokens.',
      } }] },
    ], 'plan-answer');
    __setEngineModelForTests(model);
    try {
      const out = await runPlanStream(engineOpts({
        messages: [{ role: 'user', content: 'add a dark mode toggle to setting' }],
      }));
      ok('a prose "nothing to change" answer is nudged into declaring outcome no-change',
        model.calls.length === 2 && out.plan?.outcome === 'no-change', `calls=${model.calls.length} outcome=${out.plan?.outcome}`);
      ok('and is never forced into a tool call',
        model.calls[0].toolChoice === undefined || (model.calls[0].toolChoice as { type?: string })?.type === 'auto',
        JSON.stringify(model.calls[0].toolChoice));
      ok('and it ships verbatim', out.text.includes('media/main.css:1-40'), out.text);
    } finally {
      __setEngineModelForTests(undefined);
    }
  }
  // ── 4d. Unclosed WITHOUT the narration shape ──────────────────────────────
  // Live repro 2026-09-01 4:33 PM (Kilo/stepfun/step-3.7-flash:free): "I found the key line.
  // Let me look at OrderController.php:250 where the products are being loaded…" — no plan, no
  // card, and NARRATION_RE does not match it (the stem regex is start-anchored; this opens with
  // "I found"). planGap no longer asks what the prose looks like: no plan tool call on a
  // non-question request IS the gap.
  {
    const model = createMockModel([
      { toolCalls: [{ toolName: 'grep', input: { pattern: 'products', path: '.' } }] },
      { text: 'I found the key line. Let me look at app/Http/Controllers/Vendor/OrderController.php:250 where the products are being loaded for the order view edit mode.' },
      { toolCalls: [{ toolName: 'exitPlanMode', input: PLAN }] },
    ], 'plan-gap-unnarrated');
    __setEngineModelForTests(model);
    try {
      const out = await runPlanStream(engineOpts({
        messages: [{ role: 'user', content: 'check the edit-mode product filtering and make a plan first.' }],
      }));
      ok('an unclosed turn is nudged even when the reply is not narration-shaped',
        model.calls.length === 3, `calls=${model.calls.length}`);
      ok('the nudged turn still lands a plan', out.plan?.title === 'Add dark mode', JSON.stringify(out.plan));
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
      await runPlanStream(engineOpts({
        messages: [{ role: 'user', content: 'how does the settings panel pick its theme?' }],
      }));
      ok('a QUESTION is not nudged toward a plan', model.calls.length === 1, `calls=${model.calls.length}`);
    } finally {
      __setEngineModelForTests(undefined);
    }
  }
  {
    // Live case 2026-09-01 5:09 PM: "give me an example of plan mode" in plan mode. It is
    // plainly an information request, but it leads with an imperative and ends with no "?", so
    // the interrogative-only carve-out missed it — and since planGap stopped testing the reply's
    // shape, missing it means forcing a fabricated plan onto a question.
    const model = createMockModel([
      { text: 'Plan mode answers by calling exitPlanMode with {interpretation, questions, steps}.' },
    ], 'plan-meta-question');
    __setEngineModelForTests(model);
    try {
      const out = await runPlanStream(engineOpts({
        messages: [{ role: 'user', content: 'give me an example of plan mode' }],
      }));
      ok('an imperative INFORMATION request is not nudged into a plan',
        model.calls.length === 1, `calls=${model.calls.length}`);
      ok('and its prose answer ships', out.plan === undefined && out.text.includes('exitPlanMode'), out.text);
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
    JSON.stringify(new Set(parsed.flatMap(detectStepFiles)).size) === '4',
    JSON.stringify(parsed.flatMap(detectStepFiles)));
  ok('verify text rides along on the step line', parsed[0].includes('npm run typecheck'), parsed[0]);
  // `files` is mandatory on the TOOL path now, so a file-less step can only arrive from the
  // prose fallback (planStructurer) — the renderer must still handle it, hence a local fixture
  // rather than a PLAN step that the schema would no longer accept.
  const bareCard = parsePlanSteps(formatPlanForCard({ title: 'x', steps: [{ what: 'Document the setting' }] }));
  ok('a step with no files/verify stays a bare action', bareCard[0] === 'Document the setting', bareCard[0]);

  // Evidence has to reach the CARD, not just the tool call: the whole point is that the user
  // can check a step's premise before approving it. The 2026-09-01 repro's step rested on a
  // claim one file read disproved, and the card showed no way to notice.
  ok('evidence is rendered on the card line', parsed[0].includes('evidence: src/settingsMeta.ts:40'), parsed[0]);
  const back = parsePlanStepLine(parsed[0]);
  ok('the card line parses back into what/files/evidence/verify',
    back.what === 'Add a themeMode setting' && back.files[0] === 'src/settingsMeta.ts'
    && back.evidence === 'src/settingsMeta.ts:40 has no theme entry' && back.verify === 'npm run typecheck',
    JSON.stringify(back));
  ok('a saved plan document carries the evidence line',
    renderPlanMarkdown(card, { title: 'Add dark mode', status: 'approved', now: new Date(0) })
      .includes('  - Evidence: src/settingsMeta.ts:40 has no theme entry'));

  // The header block: the reading rides on the card text, ABOVE the steps, and must not be
  // mistaken for steps by the bullet parser. Questions and approach are NOT on the card
  // (2026-09-01) — questions are asked before the plan via askUser, so nothing else may leak in.
  ok('the reading is on the card, above the first step',
    card.includes('Reading: the settings panel should offer a light/dark choice the webview honours')
    && card.indexOf('Reading:') < card.indexOf('1. '), card.slice(0, 120));
  ok('no Approach line and no Q:/A: lines on the card',
    !/^Approach:/m.test(card) && !/^(?:Q|A): /m.test(card), card.slice(0, 200));
  ok('header lines are not parsed as steps', parsePlanSteps(card).length === 3, JSON.stringify(parsePlanSteps(card)));

  // A card persisted before 2026-09-01 can still replay with retired header lines; the markdown
  // renderer must skip them rather than grow them back into the description paragraph.
  const legacyMd = renderPlanMarkdown(
    'Reading: hide off-category items in edit mode\nApproach: fix it in the shared scope\nQ: Shared scope or vendor view only?\nA: Vendor view only\n\n1. Add the check (`app/Models/Item.php`)',
    { title: 'x', status: 'approved', now: new Date(0) });
  ok('retired header lines are skipped, not re-rendered',
    legacyMd.includes('## Reading') && !legacyMd.includes('## Approach') && !legacyMd.includes('Open questions')
    && !legacyMd.includes('Approach: fix it') && !legacyMd.includes('Shared scope or vendor view only?'),
    legacyMd.slice(0, 400));

  // A 'no-change' outcome formats to its finding, never to an empty step list.
  const ncCard = formatPlanForCard({ outcome: 'no-change', title: 'Already filtered',
    steps: [], finding: 'Item::scopeActive (app/Models/Item.php:100) already excludes status=0 items.' });
  ok('"no-change" formats to the finding, with no numbered steps',
    ncCard.includes('app/Models/Item.php:100') && parsePlanSteps(ncCard).length === 0, JSON.stringify(ncCard));

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
    ok('files, evidence and verify are sub-bullets, not crammed into the checkbox line',
      md.includes('- [ ] Add a themeMode setting\n  - Files: `src/settingsMeta.ts`\n  - Evidence: src/settingsMeta.ts:40 has no theme entry\n  - Verify: npm run typecheck'), md);
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
