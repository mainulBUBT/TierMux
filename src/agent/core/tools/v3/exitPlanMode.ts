// exitPlanMode — plan mode's planning→execution boundary as an explicit TOOL CALL, the way
// Claude Code's ExitPlanMode and opencode's plan→build draw it: the model DECLARES the plan;
// the host never classifies prose (docs/PLAN_MODE_TOOL_BOUNDARY_2026-08-31.md). Mutates
// nothing; hands the structured plan to the host and ends the turn. Approval happens on the
// plan card afterwards.

import { tool } from 'ai';
import { z } from 'zod';
import type { ProposedPlan } from '../../../../shared/types';

export function createExitPlanModeTool(onPlanProposed?: (plan: ProposedPlan) => void) {
  return tool({
    description:
      'Present your finished implementation plan to the user for approval, and END your turn. '
      + 'Call this ONLY after you have investigated the codebase with the read tools and the user '
      + 'asked for a CHANGE (build / add / refactor / fix). Do NOT call it to answer a question, '
      + 'to report research findings, or to ask something — answer questions in prose and use '
      + 'askUser for clarification. The plan must be FINISHED: every premise settled by the '
      + 'conversation or by askUser BEFORE you call this. If you had to guess anything, call '
      + 'askUser first and wait for the answer — a plan carries no open questions. You cannot '
      + 'edit files in this mode; this tool IS the request for permission to implement, so do '
      + 'not also ask for approval in prose.\n'
      // A worked example IN the description (routerProvider would drop the SDK's `inputExamples`
      // field): weak models copy a concrete shape far more reliably than they infer one.
      + 'Example input: {"outcome":"plan","title":"Add a dark mode toggle","interpretation":"the '
      + 'settings panel should offer a light/dark choice that the webview honours",'
      + '"description":"Adds a '
      + 'theme setting and reads it in the webview.","steps":[{"what":"Add a themeMode setting",'
      + '"files":["src/settingsMeta.ts"],"evidence":"src/settingsMeta.ts:40 has no theme entry",'
      + '"verify":"npm run typecheck"},{"what":"Read the setting when rendering the panel",'
      + '"files":["media/src/main.ts"],"evidence":"media/src/main.ts:210 hardcodes the light palette"}]}',
    inputSchema: z.object({
      // Flat enum, deliberately NOT z.discriminatedUnion: TierMux routes many free/local tiers
      // and routerProvider maps tools to the router's wire shape — `anyOf` schemas are handled
      // badly across that fleet, while a string enum is universal.
      outcome: z.enum(['plan', 'no-change', 'needs-decision']).describe(
        'plan = the request needs code changes, give the steps. '
        + 'no-change = you investigated and nothing needs changing; give `finding` and NO steps. '
        + 'needs-decision = the request is ambiguous or you are unsure which of two fixes is wanted — '
        + 'do NOT use this tool, call askUser instead.',
      ),
      title: z.string().min(1).describe('Short imperative title for the plan, e.g. "Add dark mode to the settings panel".'),
      description: z.string().optional().describe('One or two sentences of context: what changes and why. No preamble about being in plan mode.'),
      finding: z.string().optional().describe('Required when outcome is "no-change": what you checked and why no change is needed, with path:line.'),
      // The stated premise. A 2026-09-01 plan implemented the OPPOSITE of the request with every
      // step individually defensible — the inversion lived in an unstated premise. Optional in
      // the schema, required in execute() for outcome 'plan' only: schema-required broke the
      // step-less outcomes before execute() could explain.
      interpretation: z.string().optional().describe('Required for outcome "plan": the READING of the request this plan implements, in the user\'s own terms and one sentence — e.g. "in edit mode, products whose category or status is off should be HIDDEN from the grid". Not a summary of your steps.'),
      steps: z.array(z.object({
        what: z.string().min(1).describe('The action, imperative mood, ONE line. A before→after text change is ONE step, never two. NOT a verification-only step ("confirm X is fine") — that is outcome "no-change", not a step.'),
        files: z.array(z.string()).min(1).describe('Workspace-relative paths this step CHANGES. Required — a step that changes no file is not a step.'),
        evidence: z.string().min(1).describe('The path:line you actually READ that proves this step is needed, e.g. "app/Models/Item.php:120 checks the parent status only". Not a restatement of `what`.'),
        verify: z.string().optional().describe('How to confirm this step landed — a command to run, or what to re-read.'),
      })).max(20).optional().describe('The concrete, ordered action steps. Required when outcome is "plan".'),
      // `.passthrough()` so a model that still sends the RETIRED `questions`/`approach` fields
      // keeps them visible for execute() to reject with a message routing the doubt to askUser;
      // strip would swallow the doubt, strict would fail before execute could explain.
    }).passthrough(),
    execute: async ({ outcome, title, description, finding, interpretation, steps, ...rest }): Promise<string | { error: string }> => {
      try {
        // Every rejection below is RECOVERABLE: engine.ts stops the turn on an accepted RESULT
        // (planAccepted), not on the call, so an { error } goes back to the model as the next
        // step's input and it re-submits. That is what makes these requirements safe to enforce
        // on the weak tiers TierMux routes.
        if (!onPlanProposed) {
          // e2e / sub-agent contexts have no plan card to render — degrade to an error the model
          // can read rather than silently swallowing the plan. Terminal, not recoverable: no
          // re-submission can conjure a host, so say so and let the step budget end the turn.
          return { error: 'Plan approval is not available in this environment. Do not call this tool again; answer in prose instead.' };
        }
        // Questions are asked BEFORE the plan via askUser, never carried inside it (2026-09-01).
        const retired = rest as { questions?: unknown; approach?: unknown };
        const retiredQuestions = Array.isArray(retired.questions) ? retired.questions.length > 0 : !!retired.questions;
        if (retiredQuestions || retired.approach) {
          return { error: 'A plan carries no open questions and no `approach` field — those were retired. Resolve every guess FIRST with askUser (one question at a time, with options), then call exitPlanMode with the final plan.' };
        }
        // Hesitation has a NAME now. The 2026-09-01 repro's model re-read the user's wording,
        // could not decide between a local and a global fix, and shipped a plan built on the
        // guess. Naming the state routes it to askUser instead of to a fabricated plan.
        if (outcome === 'needs-decision') {
          return { error: 'You are unsure what the user wants, so this is not a plan yet. Call askUser with the competing readings as options, then call exitPlanMode once you have the answer.' };
        }
        if (outcome === 'no-change') {
          if (!finding?.trim()) return { error: 'outcome "no-change" needs a `finding`: what you checked and why nothing needs changing, with path:line.' };
          onPlanProposed({ outcome: 'no-change', title: title.trim() || 'No change needed', description: description?.trim() || undefined, finding: finding.trim(), steps: [] });
          return 'Finding reported to the user. Stop here — there is nothing to implement.';
        }
        const clean = (steps ?? [])
          .map((s) => ({
            what: (s.what || '').trim(),
            files: s.files?.map((f) => f.trim()).filter(Boolean),
            evidence: s.evidence?.trim() || undefined,
            verify: s.verify?.trim() || undefined,
          }))
          .filter((s) => s.what);
        if (!clean.length) return { error: 'A plan needs at least one step with a non-empty "what". If nothing needs changing, call again with outcome "no-change" and a `finding`.' };
        if (!interpretation?.trim()) {
          return { error: 'A plan needs an `interpretation`: one sentence stating the reading of the request these steps implement. If you cannot state it without guessing, call askUser and settle the guess first.' };
        }
        const bare = clean.filter((s) => !s.files?.length || !s.evidence);
        if (bare.length) {
          return { error: `Every step needs \`files\` (the paths it CHANGES) and \`evidence\` (the path:line you read that proves it is needed). Missing on: ${bare.map((s) => `"${s.what}"`).join(', ')}. A step you cannot ground in a file you read is not a step — if the answer is that nothing needs changing, use outcome "no-change".` };
        }
        onPlanProposed({
          outcome: 'plan',
          title: title.trim() || 'Plan',
          description: description?.trim() || undefined,
          interpretation: interpretation.trim(),
          steps: clean,
        });
        // The engine stops the turn on this tool call, so this text is only ever seen by a model
        // that somehow kept going — keep it unambiguous that the plan is now the user's move.
        return 'Plan submitted to the user for approval. Stop here — do not implement anything and do not restate the plan.';
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
