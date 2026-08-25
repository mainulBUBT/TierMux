

import type { ChatMessage } from '../shared/types';
import { contentToString } from './content';

/** Chars-per-token estimate. Plain English runs closer to 4, but this codebase's history is
 *  dominated by code/JSON/paths, which tokenize denser (~3-3.5 chars/token). Using 4 here
 *  under-estimated real usage on small-context (32k) models enough that a "fitted" prefix could
 *  still overflow the provider's true window — it would silently truncate or return an empty
 *  200 instead of erroring, which compaction then misread as "summarizer produced nothing". */
export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 3.3);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(contentToString(m.content)) + 4;
    for (const tc of m.tool_calls ?? []) total += estimateTokens(tc.function.name + tc.function.arguments) + 4;
  }
  return total;
}

/** Strip leading `tool` results (and assistant turns that only carry tool_calls) whose partner
 *  message was trimmed away — providers reject an orphan on either side. Never returns empty
 *  when given a non-empty list: the newest message is kept as a floor, since a request with no
 *  messages at all is strictly worse than one with a slightly odd shape. */
function dropLeadingOrphans(msgs: ChatMessage[]): ChatMessage[] {
  let i = 0;
  while (i < msgs.length - 1 && (msgs[i].role === 'tool' || (msgs[i].role === 'assistant' && msgs[i].tool_calls?.length))) i++;
  return msgs.slice(i);
}

/**
 * Trim a message list to fit `maxInputTokens`. Keeps a leading system message
 * and the most recent turns; drops older ones. The kept window is started at a
 * `user`/`system` boundary so we never leave an orphaned `tool` result or a
 * dangling assistant tool-call. As a last resort the final message is truncated.
 *
 * The LATEST user message — the task actually being worked on — is reserved before
 * anything else and can never be dropped. A plain newest-first fill puts it last in
 * line: an agent turn is `[system, user(task), assistant(tool_calls), tool, …]`, so
 * walking backward spends the whole budget on recent tool output (a single capped
 * readFile result is ~7.5k tokens) and evicts the task itself. The old
 * `while (kept[0].role !== 'user') kept.shift()` then emptied whatever remained,
 * producing a system-prompt-only request: the provider 400s, or the model answers a
 * question it was never shown. Measured on a realistic turn at a 2.5k budget, the
 * result was literally `["system"]` with the task gone.
 *
 * The FIRST user message is likewise reserved as the conversation's anchor — the
 * original task on a young session, or the rolling summary once compaction has run
 * (condense.ts emits it as a leading user message). Without it, newest-first filling
 * across a tool-heavy earlier turn evicts the anchor entirely and the next model call
 * sees only the previous turn's tool tail; a short follow-up ("in short bangla") is
 * then read as one more query against that tail instead of an instruction about the
 * original task (2026-08-25 live repro). The anchor is capped at a fraction of the
 * budget so a context-enriched first message can't eat the window it protects.
 */
export function fitMessages(messages: ChatMessage[], maxInputTokens: number): { messages: ChatMessage[]; trimmed: boolean } {
  if (estimateMessagesTokens(messages) <= maxInputTokens) return { messages, trimmed: false };

  const system = messages[0]?.role === 'system' ? [messages[0]] : [];
  const rest = messages.slice(system.length);

  let taskIdx = -1;
  for (let i = rest.length - 1; i >= 0; i--) if (rest[i].role === 'user') { taskIdx = i; break; }

  let used = estimateMessagesTokens(system);
  // Reserved unconditionally, even when it alone busts the budget — the last-resort
  // truncation below then shrinks it, which still beats dropping it entirely.
  if (taskIdx >= 0) used += estimateMessagesTokens([rest[taskIdx]]);

  // The conversation anchor (first user message), reserved after the task. Skipped when it
  // IS the task (single-user-message turn — mid-turn fitting) so normal turns are unaffected.
  let anchorIdx = -1;
  let anchor: ChatMessage | undefined;
  if (taskIdx > 0) {
    anchorIdx = rest.findIndex((m) => m.role === 'user');
    if (anchorIdx >= 0 && anchorIdx < taskIdx) {
      anchor = rest[anchorIdx];
      const anchorTokens = estimateMessagesTokens([anchor]);
      const anchorCap = Math.max(200, Math.floor(maxInputTokens * 0.25));
      if (anchorTokens > anchorCap) {
        anchor = { ...anchor, content: contentToString(anchor.content).slice(0, Math.floor(anchorCap * 3.3)) + '\n…[original task message truncated to fit]' };
        used += anchorCap;
      } else {
        used += anchorTokens;
      }
    } else {
      anchorIdx = -1;
    }
  }

  // This turn's own tool loop (everything after the task) is the most valuable remaining
  // context, so it fills before older history.
  const after: ChatMessage[] = [];
  for (let i = rest.length - 1; i > taskIdx; i--) {
    const t = estimateMessagesTokens([rest[i]]);
    if (used + t > maxInputTokens) break;
    after.unshift(rest[i]);
    used += t;
  }

  const before: ChatMessage[] = [];
  // Fill down to (but not past) the anchor's index — the anchor itself is already reserved.
  for (let i = taskIdx - 1; i > anchorIdx; i--) {
    const t = estimateMessagesTokens([rest[i]]);
    if (used + t > maxInputTokens) break;
    before.unshift(rest[i]);
    used += t;
  }
  // The anchor leads the older-history window: it is chronologically first, and its user
  // role satisfies the user-boundary invariant below on its own.
  if (anchor) before.unshift(anchor);

  // Start the older-history window on a user boundary so a `tool` result or an assistant
  // tool-call whose partner was trimmed can't lead the list. Safe to empty: the reserved
  // task still follows it.
  while (before.length && before[0].role !== 'user') before.shift();

  // No user message anywhere (unusual — e.g. a synthesis-only call) and nothing fit: keep the
  // newest message regardless, matching the old `kept.length > 0` floor. A request carrying only
  // a system prompt is never valid.
  if (taskIdx < 0 && after.length === 0 && rest.length) after.push(rest[rest.length - 1]);

  let out = taskIdx >= 0
    ? [...system, ...before, rest[taskIdx], ...after]
    : [...system, ...dropLeadingOrphans(after)];

  if (estimateMessagesTokens(out) > maxInputTokens && out.length) {
    const last = out[out.length - 1];
    const budgetChars = Math.max(2000, maxInputTokens) * 4;
    const text = contentToString(last.content);
    if (text.length > budgetChars) {
      out = out.slice(0, -1).concat({ ...last, content: text.slice(0, budgetChars) + '\n…[truncated to fit context]' });
    }
  }
  return { messages: out, trimmed: true };
}

/**
 * Input-token budget for a model, reserving room for the response and for any
 * out-of-band payload (e.g. the tool manifest, which is appended to every
 * request but isn't part of the trimmed message list).
 */
export function inputBudget(
  contextWindow: number | null | undefined,
  maxOutputTokens: number,
  reservedTokens = 0,
): number {
  const window = contextWindow && contextWindow > 0 ? contextWindow : 32768;
  return Math.max(2048, window - maxOutputTokens - 1024 - Math.max(0, reservedTokens));
}
