

import type { ChatMessage } from '../shared/types';
import { contentToString } from './content';

/** Chars-per-token estimate. History here is code/JSON/paths (~3-3.5 chars/token, not English's
 *  4); 4 under-estimated enough that a "fitted" prefix still overflowed 32k models, which return
 *  an empty 200 instead of erroring. */
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

/** Trim a message list to fit `maxInputTokens`: keep a leading system message and the most
 *  recent turns, starting the window at a user/system boundary so nothing is orphaned; truncate
 *  the final message as a last resort. Reserved before the newest-first fill and never dropped:
 *  the LATEST user message (the task — a plain backward walk once shipped a system-only request)
 *  and the FIRST user message (the original task, or the rolling summary after compaction —
 *  without it a short follow-up was read against the previous turn's tool tail, 2026-08-25).
 *  The anchor is capped at a fraction of the budget. */
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

/** Input-token budget for a model, reserving room for the response and out-of-band payload such
 *  as the tool manifest. */
export function inputBudget(
  contextWindow: number | null | undefined,
  maxOutputTokens: number,
  reservedTokens = 0,
): number {
  const window = contextWindow && contextWindow > 0 ? contextWindow : 32768;
  return Math.max(2048, window - maxOutputTokens - 1024 - Math.max(0, reservedTokens));
}
