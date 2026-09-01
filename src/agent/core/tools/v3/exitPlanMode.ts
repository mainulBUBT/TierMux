// v3 exitPlanMode — plan mode's planning→execution boundary, as an explicit TOOL CALL.
//
// Why a tool and not prose parsing: before this, plan mode inferred whether a reply "was a
// plan" AFTER the fact — a regex gate (titles.ts looksLikeActionablePlan), then an LLM
// classifier (planStructurer.extractPlanFromProse), then a THIRD model call to re-structure
// the prose into steps. Three judgments, up to two extra model round-trips per turn, and the
// user turn had to be popped off the transcript and re-pushed on approval.
//
// Every comparable agent draws this line with an explicit signal instead: Claude Code's
// ExitPlanMode, opencode's plan agent handing off to build, Copilot's "Start Implementation",
// Zed's proposed plan-update primitive. The model DECLARES the plan; the host never guesses.
//
// The tool mutates nothing (READ_ONLY_TOOLS lists it, so the policy auto-approves) — it only
// hands the structured plan to the host and ENDS the turn (engine.ts: stopWhen +
// hasToolCall('exitPlanMode')). Approval happens afterwards on the plan card, through the
// existing approvePlan / executePlan / deferPlan handlers — unchanged.

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
      + 'askUser for clarification. You cannot edit files in this mode; this tool IS the request '
      + 'for permission to implement, so do not also ask for approval in prose.\n'
      // A worked example in the description, not the AI SDK's `inputExamples` property: TierMux's
      // own LanguageModelV4 adapter (core/routerProvider.ts) maps tools to the router's wire
      // shape and would drop that field, and adopting addToolInputExamplesMiddleware would add
      // a parallel path rather than replace one (docs/sdk-adoption-policy.md, rule 3). Weak
      // models copy a concrete shape far more reliably than they infer one from a schema — the
      // 2026-08-31 nemotron repro narrated instead of calling this tool at all.
      + 'Example input: {"outcome":"plan","title":"Add a dark mode toggle","interpretation":"the '
      + 'settings panel should offer a light/dark choice that the webview honours","approach":'
      + '"store it as a normal setting so the webview reads it the same way it reads the others",'
      + '"questions":[{"question":"Follow the VS Code theme automatically, or an independent setting?",'
      + '"options":["Follow VS Code","Independent setting"]}],"description":"Adds a '
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
      // The reading, written down. Required for a plan: the 2026-09-01 vendor-order repro shipped
      // a plan that implemented the OPPOSITE of the request (show ALL products, when the user
      // wanted inactive ones hidden). Every step was individually defensible and carried real
      // evidence — the inversion lived in an unstated premise, so the card had nowhere to show
      // it. Stating the premise costs one line and puts the error where one glance catches it.
      // Optional in the SCHEMA, required in execute() for outcome 'plan' only. Making it
      // schema-required broke the other two outcomes: a 'no-change' finding or a
      // 'needs-decision' bail has no steps and therefore no reading to state, but a required
      // field fails validation before execute() ever runs — so the call was rejected by the SDK
      // with no readable reason and the loop just kept going (caught by the plan-answer e2e,
      // calls=4). Conditional requirements belong in execute(), where the error text can say
      // which outcome needs what.
      interpretation: z.string().optional().describe('Required for outcome "plan": the READING of the request this plan implements, in the user\'s own terms and one sentence — e.g. "in edit mode, products whose category or status is off should be HIDDEN from the grid". Not a summary of your steps.'),
      approach: z.string().optional().describe('Why this way: the design choice and what it affects beyond the changed lines (e.g. "the fix goes in the shared scope, so it tightens item visibility app-wide").'),
      // Open questions live INSIDE the plan (the `## Confirmation Items` shape from the Claude
      // Code plan-mode reimplementation at yag.xyz, and opencode's "don't make large assumptions
      // about user intent"). Before this, the model had to CHOOSE between asking and planning —
      // and a model confident enough to draft steps always chose planning, burying its doubt in
      // the reasoning trace. Carrying both means doubt no longer has to lose.
      questions: z.array(z.object({
        question: z.string().min(1).describe('One specific thing you could not determine from the code. Not a status update.'),
        background: z.string().optional().describe('Why it matters / what you found that raised it, with path:line.'),
        options: z.array(z.string()).max(5).optional().describe('2-5 concrete answers, when the choice is between known alternatives.'),
      })).max(5).optional().describe('Anything you had to GUESS to write these steps. A plan with open questions is still worth submitting — the user answers them on the card — but it cannot be executed until they are answered. Leave empty only when nothing was guessed.'),
      steps: z.array(z.object({
        what: z.string().min(1).describe('The action, imperative mood, ONE line. A before→after text change is ONE step, never two. NOT a verification-only step ("confirm X is fine") — that is outcome "no-change", not a step.'),
        files: z.array(z.string()).min(1).describe('Workspace-relative paths this step CHANGES. Required — a step that changes no file is not a step.'),
        evidence: z.string().min(1).describe('The path:line you actually READ that proves this step is needed, e.g. "app/Models/Item.php:120 checks the parent status only". Not a restatement of `what`.'),
        verify: z.string().optional().describe('How to confirm this step landed — a command to run, or what to re-read.'),
      })).max(20).optional().describe('The concrete, ordered action steps. Required when outcome is "plan".'),
    }),
    execute: async ({ outcome, title, description, finding, interpretation, approach, questions, steps }): Promise<string | { error: string }> => {
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
          return { error: 'A plan needs an `interpretation`: one sentence stating the reading of the request these steps implement. If you cannot state it without guessing, put the guess in `questions` instead.' };
        }
        const bare = clean.filter((s) => !s.files?.length || !s.evidence);
        if (bare.length) {
          return { error: `Every step needs \`files\` (the paths it CHANGES) and \`evidence\` (the path:line you read that proves it is needed). Missing on: ${bare.map((s) => `"${s.what}"`).join(', ')}. A step you cannot ground in a file you read is not a step — if the answer is that nothing needs changing, use outcome "no-change".` };
        }
        const openQuestions = (questions ?? [])
          .map((q) => ({
            question: (q.question || '').trim(),
            background: q.background?.trim() || undefined,
            options: q.options?.map((o) => o.trim()).filter(Boolean),
          }))
          .filter((q) => q.question);
        onPlanProposed({
          outcome: 'plan',
          title: title.trim() || 'Plan',
          description: description?.trim() || undefined,
          interpretation: interpretation.trim(),
          approach: approach?.trim() || undefined,
          questions: openQuestions.length ? openQuestions : undefined,
          steps: clean,
        });
        if (openQuestions.length) {
          return `Plan submitted with ${openQuestions.length} open question(s). Stop here — the user answers them on the card before anything is executed. Do not implement, do not restate the plan, and do not answer the questions yourself.`;
        }
        // The engine stops the turn on this tool call, so this text is only ever seen by a model
        // that somehow kept going — keep it unambiguous that the plan is now the user's move.
        return 'Plan submitted to the user for approval. Stop here — do not implement anything and do not restate the plan.';
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
