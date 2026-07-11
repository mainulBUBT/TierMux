

import type { ChatMessage } from '../shared/types';
import type { Router } from '../router/router';
import { SUMMARY_SYSTEM } from './prompts';
import { contentToString } from './content';

/** Number of recent messages kept verbatim (so the active thread of work stays intact). */
const KEEP_TAIL = 6;
/** Minimum history length before condensing is worth an LLM call. Sessions with several
 *  tool-heavy turns balloon fast (large grep/read results), so compact a little sooner than the
 *  raw message count suggests — but not so soon that short chats pay for a needless summary. */
const MIN_PREFIX = 6;

/** True when the conversation is long enough that condensing is worthwhile. */
export function shouldCondense(history: ChatMessage[]): boolean {
  return history.length >= KEEP_TAIL + MIN_PREFIX;
}

/**
 * Condense `history` into `[summary, ...recentTail]`. Splits on a 'user' boundary so the tail
 * never starts mid-tool-round (which would orphan a tool result / dangle a tool call). Returns
 * null when there's too little to summarize or the summarizer produced nothing.
 *
 * `previousModel` (optional) names the model that produced the prefix. We prepend a short line
 * to the summary so a *different* model picking up the compacted history knows there was a
 * prior model — cheap cross-model context continuity on free tiers where failover / auto-route
 * can swap models mid-task.
 */
export async function condenseHistory(
  history: ChatMessage[],
  router: Router,
  previousModel?: string,
): Promise<{ messages: ChatMessage[]; summary: string } | null> {
  if (!shouldCondense(history)) return null;

  let tailStart = history.length - KEEP_TAIL;
  while (tailStart < history.length && history[tailStart].role !== 'user') tailStart++;
  if (tailStart >= history.length) return null;
  const prefix = history.slice(0, tailStart);
  const tail = history.slice(tailStart);
  if (prefix.length < 3) return null;

  const model = await router.pickUtilityModel();
  const result = await router.route(
    [
      { role: 'system', content: SUMMARY_SYSTEM },
      ...prefix,
      { role: 'user', content: 'Summarize the conversation above so it can continue with minimal context. Keep file names, decisions, and unresolved next steps.' },
    ],
    { temperature: 0.2, max_tokens: 1024, model, taskKind: 'chat' },
  );
  const summary = contentToString(result.response.choices[0]?.message.content).trim();
  if (!summary) return null;

  const carry = previousModel ? `\n\n(Continued from a previous model: ${previousModel}.)` : '';
  const summaryMsg: ChatMessage = { role: 'user', content: `Summary of the earlier conversation:\n${summary}${carry}` };
  return { messages: [summaryMsg, ...tail], summary };
}
