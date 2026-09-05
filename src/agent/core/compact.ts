// In-turn context control: the SDK's pruneMessages behind TierMux's budget (the served model's
// ExecutionProfile), plus tool-output aging that runs every step.
//
// Two prune tiers: tier 1 drops only re-derivable searches (early blanking "was destroying
// tool evidence the model still needed" — SIMPLE_CORE_RESET); tier 2 sheds file reads too,
// because a small-window model overflows the provider call otherwise.

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

// ── Tool-output aging — runs every step, budget-independent. compactIfNeeded only fires at
// 80% of the window, so a big-window model otherwise re-sends every 30k readFile result on
// each of 15–25 round trips (free gateways don't prompt-cache; 10–17s TTFT repros). This is
// what makes OpenCode/Kilo feel fast on the same models. Stubs name the tool + input and say
// to re-run it, so elision degrades to a re-read. Errors and short outputs stay verbatim.

const AGE_MIN_CHARS = 2_000;

/** Most recent tool messages kept verbatim. 1 → 3 (2026-09-05): with one, "read A, read B,
 *  edit A" had already stubbed A's content by the edit step while editFile.search must match it
 *  byte-for-byte. Three covers read→search→read→edit without a per-tool exemption list. */
const KEEP_RECENT_TOOL_MESSAGES = 3;

/** toolCallId → the ARGUMENTS that produced the result. The args live on the assistant
 *  message's `tool-call` part, not on the tool-result part (reading them there yielded stubs
 *  with no path, 2026-09-04). */
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
