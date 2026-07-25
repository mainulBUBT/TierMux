

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
