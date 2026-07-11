

import type { ChatMessage } from '../shared/types';
import { contentToString } from './content';

export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(contentToString(m.content)) + 4;
    for (const tc of m.tool_calls ?? []) total += estimateTokens(tc.function.name + tc.function.arguments) + 4;
  }
  return total;
}

/**
 * Trim a message list to fit `maxInputTokens`. Keeps a leading system message
 * and the most recent turns; drops older ones. The kept window is started at a
 * `user`/`system` boundary so we never leave an orphaned `tool` result or a
 * dangling assistant tool-call. As a last resort the final message is truncated.
 */
export function fitMessages(messages: ChatMessage[], maxInputTokens: number): { messages: ChatMessage[]; trimmed: boolean } {
  if (estimateMessagesTokens(messages) <= maxInputTokens) return { messages, trimmed: false };

  const system = messages[0]?.role === 'system' ? [messages[0]] : [];
  const rest = messages.slice(system.length);

  const kept: ChatMessage[] = [];
  let used = estimateMessagesTokens(system);
  for (let i = rest.length - 1; i >= 0; i--) {
    const t = estimateMessagesTokens([rest[i]]);
    if (used + t > maxInputTokens && kept.length > 0) break;
    kept.unshift(rest[i]);
    used += t;
  }

  while (kept.length && kept[0].role !== 'user') kept.shift();

  let out = [...system, ...kept];

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
