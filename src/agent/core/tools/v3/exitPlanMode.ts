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
      + 'Example input: {"title":"Add a dark mode toggle","description":"Adds a theme setting '
      + 'and reads it in the webview.","steps":[{"what":"Add a themeMode setting","files":'
      + '["src/settingsMeta.ts"],"verify":"npm run typecheck"},{"what":"Read the setting when '
      + 'rendering the panel","files":["media/src/main.ts"]}]}',
    inputSchema: z.object({
      title: z.string().min(1).describe('Short imperative title for the plan, e.g. "Add dark mode to the settings panel".'),
      description: z.string().optional().describe('One or two sentences of context: what changes and why. No preamble about being in plan mode.'),
      steps: z.array(z.object({
        what: z.string().min(1).describe('The action, imperative mood, ONE line. A before→after text change is ONE step, never two.'),
        files: z.array(z.string()).optional().describe('Workspace-relative paths this step touches.'),
        verify: z.string().optional().describe('How to confirm this step landed — a command to run, or what to re-read.'),
      })).min(1).max(20).describe('The concrete, ordered action steps.'),
    }),
    execute: async ({ title, description, steps }): Promise<string | { error: string }> => {
      try {
        const clean = steps
          .map((s) => ({
            what: (s.what || '').trim(),
            files: s.files?.map((f) => f.trim()).filter(Boolean),
            verify: s.verify?.trim() || undefined,
          }))
          .filter((s) => s.what);
        if (!clean.length) return { error: 'A plan needs at least one step with a non-empty "what".' };
        if (!onPlanProposed) {
          // e2e / sub-agent contexts have no plan card to render — degrade to an error the model
          // can read rather than silently swallowing the plan.
          return { error: 'Plan approval is not available in this environment.' };
        }
        onPlanProposed({ title: title.trim() || 'Plan', description: description?.trim() || undefined, steps: clean });
        // The engine stops the turn on this tool call, so this text is only ever seen by a model
        // that somehow kept going — keep it unambiguous that the plan is now the user's move.
        return 'Plan submitted to the user for approval. Stop here — do not implement anything and do not restate the plan.';
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
