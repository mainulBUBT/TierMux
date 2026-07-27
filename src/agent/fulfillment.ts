

// Non-static completion check: asks a model whether the assistant's reply actually FULFILLED the
// user's request. This is the semantic second opinion the static assessAnswerQuality heuristics
// can't provide — they catch obvious refusal/repetition/deflection, but miss a plausible-sounding
// answer that didn't really do the work (partial, off-topic, describes-intent-without-acting,
// wrong). When the first model didn't fulfill the request, loop.ts escalates to a stronger model
// to actually complete it ("continue work"), instead of accepting the non-answer.
//
// Conservative by design:
//  - Runs ONLY when static heuristics passed (otherwise they already triggered escalation) and no
//    mutating tool call happened (escalation past side effects is unsafe — see loop.ts canEscalate).
//  - Defaults to fulfilled=true on ANY failure (timeout, provider rejects `output`, malformed
//    result) so a flaky judge never causes runaway escalation — it degrades to today's behavior.
//  - The judge runs on a DIFFERENT, top-tier model than the one being judged (excludeModel +
//    maxIntelligenceRank), so a weak model is never asked to grade its own non-answer.
import { generateText, Output } from 'ai';
import { z } from 'zod';
import type { Router } from '../router/router';
import type { TaskKind } from './routing';
import { createRouterProvider } from './core/routerProvider';

const FulfillmentSchema = z.object({
  fulfilled: z.boolean(),
  reason: z.string(),
});

/** Task kinds worth judging. Skipped for trivial/chat/ask/vision: those are conversational, a
 *  follow-up question or short reply is legitimate, and judging them would waste a model call. */
export const JUDGEABLE_TASK_KINDS = new Set<TaskKind>(['agent', 'coding', 'debug', 'longContext', 'plan']);

/**
 * Ask a (different, stronger) model whether `assistantReply` actually fulfills `userRequest`.
 * Returns `{ fulfilled: true }` on any failure — never escalates on a judge error. `excludeModel`
 * is a `platform::modelId` key to keep off the model being graded.
 */
export async function judgeFulfillment(
  router: Router,
  userRequest: string,
  assistantReply: string,
  _taskKind: TaskKind,
  excludeModel?: string,
): Promise<{ fulfilled: boolean; reason: string }> {
  const fallback = { fulfilled: true, reason: '' };
  if (!userRequest.trim() || !assistantReply.trim()) return fallback;
  try {
    const model = createRouterProvider(router, {
      taskKind: 'plan', // light, reasoning-shaped routing for the judge turn
      excludeModels: excludeModel ? [excludeModel] : undefined,
      maxIntelligenceRank: 2, // a capable judge — never the weak model under review
    });
    const result = await generateText({
      model,
      system:
        + 'You are a strict completion judge for an AI coding assistant. Decide FULFILLED: true '
        + 'ONLY if the assistant reply actually addresses and COMPLETES the user\'s request — the '
        + 'real work is done (or, for a read-only/plan task, a concrete correct answer/plan is '
        + 'given that directly satisfies what was asked). FULFILLED is false if the reply: deflects '
        + 'or asks the user what they want; only describes what it would do without doing it; is '
        + 'off-topic, partial, or plainly wrong; begs clarification it wasn\'t asked for; or says '
        + 'it cannot help. A short but correct answer to a genuine question IS fulfilled. Be '
        + 'strict: a fluent non-answer is still a non-answer. '
        + 'CRITICAL for create/edit/build/write tasks: if the user asked to MAKE, CREATE, BUILD, '
        + 'WRITE, ADD, FIX, or IMPLEMENT something (a file, a feature, a change) and the assistant '
        + 'only SHOWED the code/content/HTML in its reply (in a code block or inline) without '
        + 'actually creating or editing the file via a tool, that is NOT FULFILLED — "here is the '
        + 'code" is a suggestion, not the completed work. '
        + 'REASON: one short clause saying why (e.g. "showed code but did not write the file", '
        + '"asks user what they want", "only announces intent"). When FULFILLED is true, REASON '
        + 'may be empty.',
      prompt:
        + `USER REQUEST:\n${userRequest.slice(0, 4000)}\n\n`
        + `ASSISTANT REPLY:\n${assistantReply.slice(0, 6000)}\n\n`
        + `Did the assistant reply actually fulfill the user's request?`,
      output: Output.object({ schema: FulfillmentSchema }),
      abortSignal: AbortSignal.timeout(20000),
    });
    const fulfilled = result.output?.fulfilled !== false; // treat undefined as fulfilled (safe)
    return { fulfilled, reason: (result.output?.reason ?? '').trim() };
  } catch {
    return fallback; // best-effort — never escalate on a judge failure
  }
}
