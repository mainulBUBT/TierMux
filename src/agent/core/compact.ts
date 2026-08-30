// v3 context compaction — the SDK's pruneMessages behind a TierMux budget decision.
//
// The budget (WHEN to compact) stays TierMux's: it comes from the served model's
// ExecutionProfile, resolved by the caller. The transcript surgery (WHAT to drop) is the
// SDK's `pruneMessages` — adopting it deleted a hand-rolled pass that stubbed EVERY tool
// result in the older half of the transcript with "(result omitted — compacted)", which is
// both blunter and more expensive than dropping the parts outright.
//
// Two tiers, because evidence and overflow pull in opposite directions. The
// SIMPLE_CORE_RESET note that early blanking "was destroying tool evidence the model still
// needed" is the reason tier 1 only drops the re-derivable searches; the flat 32K budget it
// replaced is the reason a tier 2 exists at all (a small-window model has to shed file reads
// too or the provider call overflows regardless).

import { pruneMessages, type ModelMessage } from 'ai';

/** ~4 chars/token — same heuristic the old budget.ts used; only decides WHEN to compact. */
export function estimateTokens(messages: ModelMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/** Searches: large, noisy, and cheap for the model to re-run if it truly needs them again.
 *  These go first and are the only thing tier 1 touches. */
const REDERIVABLE_TOOLS = ['grep', 'glob', 'listDir', 'webSearch', 'deepSearch'];

/** Tier 1 — drop stale reasoning plus re-derivable search output, keeping file reads and
 *  edits (the evidence a later step actually reasons over) intact. */
function pruneGentle(messages: ModelMessage[]): ModelMessage[] {
  return pruneMessages({
    messages,
    reasoning: 'before-last-message',
    toolCalls: [{ type: 'before-last-6-messages', tools: REDERIVABLE_TOOLS }],
    emptyMessages: 'remove',
  });
}

/** Tier 2 — every tool result outside the last few messages goes, file reads included. Only
 *  reached when tier 1 left the transcript still over budget, where the alternative is not
 *  "keep the evidence" but "overflow the provider and lose the whole turn". */
function pruneAggressive(messages: ModelMessage[]): ModelMessage[] {
  return pruneMessages({
    messages,
    reasoning: 'all',
    toolCalls: [{ type: 'before-last-4-messages' }],
    emptyMessages: 'remove',
  });
}

/** Returns a `prepareStep` override — `{}` leaves the step untouched. The `messages` override
 *  is sticky (carries forward to later steps — verified at ai/dist/index.d.ts:1722-1726), so
 *  one compaction persists for the rest of the turn. */
export function compactIfNeeded(
  messages: ModelMessage[],
  budgetTokens: number,
): { messages?: ModelMessage[] } {
  if (budgetTokens <= 0) return {};
  if (estimateTokens(messages) < budgetTokens * 0.8) return {};

  const gentle = pruneGentle(messages);
  if (estimateTokens(gentle) < budgetTokens * 0.8) return { messages: gentle };

  return { messages: pruneAggressive(gentle) };
}
