// Conservative "the weak model can't handle this" detection for quality-based escalation.
// Pure helpers — the retry loop lives in agent.ts. Signals kept narrow on purpose so we
// don't burn tokens retrying good answers: a refusal/empty reply, a tool-call loop (the
// model repeating the exact same call), or a batch of tool calls whose args are all
// unparseable garbage (even after the toolArgs rescue).
import type { ChatToolCall } from '../shared/types';

/** Max stronger-model retries on an unhandled response before giving up. */
export const ESCALATION_CAP = 2;

// Short, clearly-refusal phrasing. Only treated as a refusal when the whole reply is short
// — a long answer that happens to contain "I can't" somewhere is almost always legitimate.
const REFUSAL = /\b(i('m| am) (sorry|unable|not able to|afraid)|i can(?:'|no)t|cannot (?:help|assist|do that|provide|fulfill|complete)|as an ai|i'?m unable)\b/i;

/** Empty, or a short refusal-like answer that suggests the model gave up instead of acting. */
export function isRefusalOrEmpty(content: string): boolean {
  const t = (content || '').trim();
  if (!t) return true;
  return t.length <= 240 && REFUSAL.test(t);
}

/** A stable signature of a tool-call batch, to detect the model repeating itself verbatim. */
export function toolSignature(calls: ChatToolCall[] | undefined): string {
  if (!calls || !calls.length) return '';
  return calls
    .map((c) => `${c.function?.name ?? ''}:${(c.function?.arguments ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)}`)
    .join('|');
}

/** True when NONE of the tool calls have parseable JSON arguments (post-rescue garbage). */
export function allUnparseable(calls: ChatToolCall[] | undefined): boolean {
  if (!calls || !calls.length) return false;
  return calls.every((c) => {
    const a = (c.function?.arguments ?? '').trim();
    if (!a) return true;
    try { JSON.parse(a); return false; } catch { return true; }
  });
}
