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
const REDERIVABLE_TOOLS = ['grep', 'glob', 'listDir', 'webSearch'];

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
// that move, budget-independent: run on every step, keep the most recent few tool messages'
// results verbatim, and elide the older ones into instructive stubs.
//
// Safety: stubs name the tool + input and tell the model how to see the content again
// (re-run the tool), so elision degrades to a re-read, never to a dead reference. Error
// outputs and short outputs (messages, diff summaries, {error}) stay verbatim — errors are
// the recovery path and short ones aren't worth the churn. Idempotent: a stub is itself
// short, so later passes leave it alone.

const AGE_MIN_CHARS = 2_000;

/** How many of the most recent tool messages stay verbatim (2026-09-05: 1 → 3).
 *
 *  One was too tight for the commonest autonomous pattern there is — read A, read B, edit A.
 *  By the edit step A's content was already a stub, while `editFile.search` has to match it
 *  byte-for-byte, so aging manufactured the exact failure editMatch.ts then had to diagnose.
 *  Three covers read→read→edit and read→search→read→edit without a per-tool exemption list
 *  (which would be the start of a tower). The cost is bounded and small: three steps of
 *  output instead of one, against turns that run 15-25 steps. */
const KEEP_RECENT_TOOL_MESSAGES = 3;

/** toolCallId → the ARGUMENTS that produced the result. `ToolResultPart` carries only
 *  toolCallId/toolName/output — the args live on the ASSISTANT message's `tool-call` part
 *  (ToolCallPart.input), so a stub that wants to name what it elided has to look them up
 *  there. Reading `input` off the tool-result part instead silently yields undefined, which
 *  is what shipped 2026-09-04: every stub read "[readFile — 30,000 chars…]" with no path,
 *  so the model could not act on the "re-run the tool" hint the stub gave it. */
function toolCallInputs(messages: ModelMessage[]): Map<string, unknown> {
  const byId = new Map<string, unknown>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const part of m.content as Array<Record<string, unknown>>) {
      if (part.type === 'tool-call' && typeof part.toolCallId === 'string') {
        byId.set(part.toolCallId, part.input);
      }
    }
  }
  return byId;
}

/** One-line summary of a tool call for the stub header: "readFile src/x.ts". */
function ageInputSummary(toolName: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const val = [o.path, o.query, o.pattern, o.url, o.task, o.command]
    .map((v) => (Array.isArray(v) ? v.join(',') : typeof v === 'string' ? v : ''))
    .find(Boolean) || '';
  const clipped = val.replace(/\s+/g, ' ').slice(0, 60);
  return clipped ? `${toolName} ${clipped}` : toolName;
}

/** Text of a tool-result output when it is plain text (string return / {type:'text'}).
 *  `{type:'json'}` outputs are deliberately NOT aged: every v3 tool returns
 *  `string | { error }`, so a json output IS an error payload — the recovery path, which
 *  the module contract above keeps verbatim. */
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
  // The most recent KEEP_RECENT_TOOL_MESSAGES tool messages are the steps the model is still
  // working from — kept verbatim, parts and all. Everything before the oldest of them is fair
  // game. Walking backwards means the boundary is the OLDEST kept message's index.
  const recent: number[] = [];
  for (let i = messages.length - 1; i >= 0 && recent.length < KEEP_RECENT_TOOL_MESSAGES; i--) {
    if (messages[i].role === 'tool') recent.push(i);
  }
  const keepFrom = recent.length ? recent[recent.length - 1] : -1;
  if (keepFrom <= 0) return { stubbedChars: 0 };

  const inputById = toolCallInputs(messages);
  let stubbedChars = 0;
  let changed = false;
  const out = messages.map((m, i) => {
    if (i >= keepFrom || m.role !== 'tool' || !Array.isArray(m.content)) return m;
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
          value: `[${ageInputSummary(String(part.toolName ?? 'tool'), inputById.get(String(part.toolCallId ?? '')))} — ${(text.length).toLocaleString()} chars returned in an earlier step; output elided to keep the prompt small. Re-run the tool (narrower, if needed) to see it again.]`,
        },
      };
    });
    return touched ? ({ ...m, content } as ModelMessage) : m;
  });
  return changed ? { messages: out, stubbedChars } : { stubbedChars: 0 };
}
