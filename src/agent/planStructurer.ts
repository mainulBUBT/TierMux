

// Structured-output pass for Plan mode: converts an already-confirmed actionable plan's prose
// (numbered/bulleted steps) into a schema-validated string[] via the AI SDK's `output` option,
// instead of relying solely on titles.ts's regex-based `planStepsToTodos` bullet/number parser.
// Best-effort and additive only — never changes whether something IS a plan (that's still
// `looksLikeActionablePlan`'s job) and always falls back to the regex parser on any failure, so
// a model with poor structured-output support degrades to today's exact behavior, never worse.
import { generateText, Output } from 'ai';
import { z } from 'zod';
import type { Router } from '../router/router';
import { createRouterProvider } from './core/routerProvider';

const StepsSchema = z.object({
  steps: z.array(z.string().min(1)).max(20),
});

/** Discriminator schema for prose classification: does this text propose concrete changes the
 *  user could approve and run (a plan), or is it an explanation/discussion/answer? When it IS a
 *  plan, `steps` holds the action items; when it is not, the caller must render it as prose, NOT
 *  fabricate a plan card (which would wrongly gate a Q&A reply behind an "Approve & Run" button). */
const ProsePlanSchema = z.object({
  isPlan: z.boolean(),
  steps: z.array(z.string().min(1)).max(20),
});

/**
 * Re-parses a confirmed plan's prose into a clean step list via schema-validated structured
 * output. Returns null (never throws) on any failure — timeout, provider rejects `output`,
 * malformed result — so the caller falls back to `planStepsToTodos`'s regex parse.
 */
export async function structurePlanSteps(router: Router, planText: string): Promise<string[] | null> {
  if (!planText.trim()) return null;
  try {
    const model = createRouterProvider(router, { taskKind: 'plan' });
    const result = await generateText({
      model,
      system: 'Extract the concrete action steps from this plan as a clean, deduplicated list. '
        + 'One step per array entry, imperative mood, no numbering/bullets in the text itself. '
        + 'Preserve the file/symbol names the plan already names. Do not invent new steps.',
      prompt: planText,
      output: Output.object({ schema: StepsSchema }),
      abortSignal: AbortSignal.timeout(15000),
    });
    const steps = result.output?.steps?.map((s: string) => s.trim()).filter(Boolean) ?? [];
    return steps.length ? steps.slice(0, 20) : null;
  } catch {
    return null; // best-effort — the regex parser is the safe fallback
  }
}

/**
 * Plan-mode fallback for the common weak-model failure: the user asked for a plan, but the model
 * replied in flowing prose (no clean numbered list), so `looksLikeActionablePlan`'s regex gate
 * returned false and no plan card was shown. This asks the model itself — via schema-validated
 * structured output — to (a) decide whether the prose is genuinely an actionable plan vs. an
 * explanation/discussion, and (b) if so, lift its action items into a clean step list.
 *
 * Returns `{ isPlan: false, steps: [] }` (never throws) on any failure — timeout, provider
 * rejects `output`, malformed result — so the caller degrades to showing the prose as a normal
 * answer, exactly today's behavior. The `isPlan` discriminator is what prevents a Q&A reply from
 * being force-cardified: only prose the model confirms describes concrete changes becomes a plan.
 */
export async function extractPlanFromProse(router: Router, text: string): Promise<{ isPlan: boolean; steps: string[] }> {
  if (!text.trim()) return { isPlan: false, steps: [] };
  try {
    const model = createRouterProvider(router, { taskKind: 'plan' });
    const result = await generateText({
      model,
      system:
        + 'You are classifying an assistant reply given in Plan mode. '
        + 'Decide IS_PLAN: true ONLY if the reply proposes concrete changes the user could approve '
        + 'and have run (new files, edits, deletions, commands, a build/refactor) — i.e. it is a '
        + 'plan of action, not an explanation. False if it is an answer to a question, an '
        + 'explanation of how something works, discussion, a clarifying question, or small talk. '
        + 'When IS_PLAN is true, STEPS must be the concrete action items (imperative mood, no '
        + 'numbering/bullets in the text itself, preserve the file/symbol names already named, do '
        + 'not invent new steps). When IS_PLAN is false, leave STEPS empty.',
      prompt: text,
      output: Output.object({ schema: ProsePlanSchema }),
      abortSignal: AbortSignal.timeout(15000),
    });
    const isPlan = !!result.output?.isPlan;
    const steps = result.output?.steps?.map((s: string) => s.trim()).filter(Boolean) ?? [];
    return { isPlan, steps: isPlan ? steps.slice(0, 20) : [] };
  } catch {
    return { isPlan: false, steps: [] }; // best-effort — caller shows the prose as-is
  }
}

/** Re-serializes a clean step list back into the numbered-list text format the webview's
 *  Plan.ts (parsePlanSteps) and titles.ts (planStepsToTodos) both already parse — so
 *  structurePlanSteps' output can be dropped straight into the existing `planProposed.steps`
 *  string field with no changes needed on the webview side. */
export function formatStructuredSteps(steps: string[]): string {
  return steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
}
