

import type { ChatMessage } from '../shared/types';
import type { Router } from '../router/router';
import { SUMMARY_SYSTEM, HANDOFF_SYSTEM } from './prompts';
import { contentToString } from './content';
import { capToolOutput } from './core/tools/capOutput';
import { diagLog } from '../util/diag';

/** Number of recent messages kept verbatim (so the active thread of work stays intact). */
const KEEP_TAIL = 6;
/** Re-cap ceiling for a tool result surviving in the kept tail. Per-tool caps (capOutput.ts) run
 *  up to 15-30k chars each — fine for the model mid-task, but by compaction time the model has
 *  already acted on that result, so keeping it at full size in the "recent, verbatim" tail can
 *  dwarf the summary and make Ctx barely move even though compaction genuinely ran. Re-capping
 *  tighter here is what actually makes compaction shrink the context, not just the message count. */
const TAIL_TOOL_RESULT_CAP = 1500;
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
  const tail = recapTailToolResults(history.slice(tailStart));
  if (prefix.length < 3) return null;

  const summaryRequest = [
    { role: 'system' as const, content: SUMMARY_SYSTEM },
    ...prefix,
    { role: 'user' as const, content: 'Summarize the conversation above so it can continue with minimal context. Keep file names, decisions, and unresolved next steps.' },
  ];

  // One retry on an empty/whitespace-only summary, EXCLUDING the model that just produced it. A
  // weak/free utility model can return HTTP-200 with blank or near-blank content (not a thrown
  // error — router.ts's own empty-content check only catches a fully-falsy string, not whitespace),
  // which used to surface as "Compaction produced no summary" with no recourse but to try again by
  // hand. Mirrors the same weak-answer-retry pattern loop.ts already uses for the main turn.
  const model = await router.pickUtilityModel();
  let result = await router.route(summaryRequest, { temperature: 0.2, max_tokens: 1024, model, taskKind: 'chat' });
  let summary = contentToString(result.response.choices[0]?.message.content).trim();
  if (!summary) {
    const excludeKey = `${result.platform}::${result.model}`;
    diagLog('condense.retry', `empty summary from ${excludeKey} — retrying with a different model`);
    result = await router.route(summaryRequest, { temperature: 0.2, max_tokens: 1024, taskKind: 'chat', exclude: [excludeKey] });
    summary = contentToString(result.response.choices[0]?.message.content).trim();
  }
  if (!summary) {
    diagLog('condense.fail', `empty summary from both ${model ?? 'auto'} and its fallback — giving up`);
    return null;
  }

  const carry = previousModel ? `\n\n(Continued from a previous model: ${previousModel}.)` : '';
  const summaryMsg: ChatMessage = { role: 'user', content: `Summary of the earlier conversation:\n${summary}${carry}` };
  return { messages: [summaryMsg, ...tail], summary };
}

/** Minimum history length before a handoff note is worth an LLM call — a session that's barely
 *  started has nothing to hand off. */
const MIN_HANDOFF_HISTORY = 2;

/**
 * Produces a standalone handoff note for the *whole* history — unlike `condenseHistory`, this
 * never mutates or truncates the session; it's a read-only summary meant to be copied elsewhere
 * (a fresh session, a teammate, a written note) when the current one is ending or hitting limits.
 * Returns null when there's too little conversation yet, or the summarizer produced nothing.
 */
export async function generateHandoff(history: ChatMessage[], router: Router): Promise<string | null> {
  if (history.length < MIN_HANDOFF_HISTORY) return null;

  const request = [
    { role: 'system' as const, content: HANDOFF_SYSTEM },
    ...history,
    { role: 'user' as const, content: 'Write the handoff note for the conversation above.' },
  ];

  const model = await router.pickUtilityModel();
  let result = await router.route(request, { temperature: 0.2, max_tokens: 1024, model, taskKind: 'chat' });
  let note = contentToString(result.response.choices[0]?.message.content).trim();
  if (!note) {
    const excludeKey = `${result.platform}::${result.model}`;
    result = await router.route(request, { temperature: 0.2, max_tokens: 1024, taskKind: 'chat', exclude: [excludeKey] });
    note = contentToString(result.response.choices[0]?.message.content).trim();
  }
  return note || null;
}

/** Re-cap `tool`-role message content in the kept tail down to TAIL_TOOL_RESULT_CAP. A large
 *  grep/read/bash dump is capped at 15-30k chars at write-time (capOutput.ts) — appropriate while
 *  the model is actively using it, but by compaction time the model has already acted on it, so
 *  keeping it at full size in the verbatim tail can single-handedly dwarf the summary and make
 *  compaction look like a no-op. Only touches `content` (string content); tool_call_id / role are
 *  untouched, so the call↔result pairing the AI SDK requires stays intact. */
function recapTailToolResults(tail: ChatMessage[]): ChatMessage[] {
  return tail.map((m) => {
    if (m.role !== 'tool' || typeof m.content !== 'string' || m.content.length <= TAIL_TOOL_RESULT_CAP) return m;
    return { ...m, content: capToolOutput(m.content, TAIL_TOOL_RESULT_CAP, 'Re-run the tool if you need the full output again.') };
  });
}
