// Background context condensing: summarize the OLDER prefix of a conversation into one message
// while keeping a recent tail verbatim — so long tasks don't hit the context wall and recent
// detail isn't lost to the router's lossy trimming (fitMessages just drops old turns).
// Runs on the cheapest utility model with SUMMARY_SYSTEM. Pure helper — the chat handler owns
// the history array, calls this, and persists the result.
import type { ChatMessage } from '../shared/types';
import type { Router } from '../router/router';
import { SUMMARY_SYSTEM } from './prompts';
import { contentToString } from './content';

/** Number of recent messages kept verbatim (so the active thread of work stays intact). */
const KEEP_TAIL = 6;

/** True when the conversation is long enough that condensing is worthwhile. */
export function shouldCondense(history: ChatMessage[]): boolean {
  return history.length >= KEEP_TAIL + 4;
}

/**
 * Condense `history` into `[summary, ...recentTail]`. Splits on a 'user' boundary so the tail
 * never starts mid-tool-round (which would orphan a tool result / dangle a tool call). Returns
 * null when there's too little to summarize or the summarizer produced nothing.
 */
export async function condenseHistory(
  history: ChatMessage[],
  router: Router,
): Promise<{ messages: ChatMessage[]; summary: string } | null> {
  if (!shouldCondense(history)) return null;
  // Walk forward from (length - KEEP_TAIL) to the nearest 'user' turn so the tail starts clean.
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
  const summaryMsg: ChatMessage = { role: 'user', content: `Summary of the earlier conversation:\n${summary}` };
  return { messages: [summaryMsg, ...tail], summary };
}
