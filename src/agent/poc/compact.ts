// POC ONLY — v3 minimal context compaction (plan §5). Replaces anchors/collapseRepeat/watchdog.
//
// Deliberately minimal: when the estimated tokens cross 80% of the budget, tool-result
// messages in the OLDER half of the transcript are replaced with a one-line stub.
// User/assistant messages stay verbatim. The prepareStep `messages` override is sticky
// (carries forward to later steps — verified at ai/dist/index.d.ts:1722-1726), so one
// compaction persists for the rest of the turn.

import type { ModelMessage } from 'ai';

/** ~4 chars/token — same heuristic the old budget.ts used; only decides WHEN to compact. */
export function estimateTokens(messages: ModelMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

export function compactIfNeeded(
  messages: ModelMessage[],
  budgetTokens: number,
): { messages?: ModelMessage[] } {
  if (budgetTokens <= 0) return {};
  if (estimateTokens(messages) < budgetTokens * 0.8) return {};

  const half = messages.length / 2;
  const compacted: ModelMessage[] = messages.map((m, i) => {
    if (m.role !== 'tool' || i >= half) return m;
    return {
      role: 'tool' as const,
      content: (m.content as Array<{ toolCallId: string; toolName: string }>).map((part) => ({
        type: 'tool-result' as const,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: { type: 'text' as const, value: '(result omitted — compacted)' },
      })),
    };
  });
  return { messages: compacted };
}
