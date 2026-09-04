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
import { estimateTokens as estimateTextTokens } from '../budget';

/** Message-level estimate — same 3.3 chars/token heuristic as budget.ts (code/JSON heavy),
 *  plus per-message framing overhead. Single estimator everywhere so step-level aging,
 *  prepareStep compaction, and between-turn condense all trigger off the same numbers. */
export function estimateTokens(messages: ModelMessage[]): number {
  const text = JSON.stringify(messages);
  return estimateTextTokens(text) + messages.length * 4;
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

// ── Tool-output aging (2026-09-04) ──────────────────────────────────────────────────────
// compactIfNeeded only fires at 80% of the model's window, so a big-window model carries
// EVERY tool result in full through every remaining step of the turn: one readFile returns
// up to 30k chars, and an agent turn runs 15–25 round trips, each re-prefilling the whole
// accumulated history (free gateways don't prompt-cache — full price every time; the same
// TTFT repros that motivated the picker's TTFT EWMA: 10–17s to first byte). OpenCode/Kilo
// feel fast on the SAME models because they prune consumed outputs between steps; this is
// that move, budget-independent: run on every step, keep only the most recent tool
// message's results verbatim, and elide the older ones into instructive stubs.
//
// Safety: stubs name the tool + input and tell the model how to see the content again
// (re-run the tool), so elision degrades to a re-read, never to a dead reference. Error
// outputs and short outputs (messages, diff summaries, {error}) stay verbatim — errors are
// the recovery path and short ones aren't worth the churn. Idempotent: a stub is itself
// short, so later passes leave it alone.

const AGE_MIN_CHARS = 2_000;

/** One-line summary of a tool call for the stub header: "readFile src/x.ts". */
function ageInputSummary(toolName: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const val = [o.path, o.query, o.pattern, o.url, o.task, o.command]
    .map((v) => (Array.isArray(v) ? v.join(',') : typeof v === 'string' ? v : ''))
    .find(Boolean) || '';
  const clipped = val.replace(/\s+/g, ' ').slice(0, 60);
  return clipped ? `${toolName} ${clipped}` : toolName;
}

/** Text of a tool-result output when it is plain text (string return / {type:'text'}). */
function ageOutputText(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object'
    && (output as { type?: unknown }).type === 'text'
    && typeof (output as { value?: unknown }).value === 'string') {
    return (output as { value: string }).value;
  }
  return undefined;
}

export interface AgeToolOutputsResult {
  messages?: ModelMessage[];
  /** Chars of earlier tool output elided this pass — diag-visible so the saving is measurable. */
  stubbedChars: number;
}

export function ageToolOutputs(messages: ModelMessage[], minChars = AGE_MIN_CHARS): AgeToolOutputsResult {
  // The LAST message carrying tool results is the step the model is currently acting on —
  // kept verbatim, parts and all. Everything before it is fair game.
  let lastToolIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool') { lastToolIdx = i; break; }
  }
  if (lastToolIdx <= 0) return { stubbedChars: 0 };

  let stubbedChars = 0;
  let changed = false;
  const out = messages.map((m, i) => {
    if (i >= lastToolIdx || m.role !== 'tool' || !Array.isArray(m.content)) return m;
    let touched = false;
    const content = (m.content as Array<Record<string, unknown>>).map((part) => {
      if (part.type !== 'tool-result') return part;
      const text = ageOutputText(part.output);
      if (text == null || text.length < minChars) return part;
      changed = true;
      stubbedChars += text.length;
      touched = true;
      return {
        ...part,
        output: {
          type: 'text',
          value: `[${ageInputSummary(String(part.toolName ?? 'tool'), part.input)} — ${(text.length).toLocaleString()} chars returned in an earlier step; output elided to keep the prompt small. Re-run the tool (narrower, if needed) to see it again.]`,
        },
      };
    });
    return touched ? ({ ...m, content } as ModelMessage) : m;
  });
  return changed ? { messages: out, stubbedChars } : { stubbedChars: 0 };
}
