import type { ChatMessage } from '../shared/types';
import { routeOnce, utilityModelPreference } from '../agent/core/routeOnce';
import { HANDOFF_SYSTEM } from './prompts';

/** Minimum history length before a handoff note is worth an LLM call. */
const MIN_HANDOFF_HISTORY = 2;
const HANDOFF_MAX_TOKENS = 2048;

/** A standalone handoff note for the whole history — read-only, never mutates the session.
 *  One retry on a different model when the first returns nothing. */
export async function generateHandoff(history: ChatMessage[]): Promise<string | null> {
  if (history.length < MIN_HANDOFF_HISTORY) return null;
  const request: ChatMessage[] = [
    { role: 'system', content: HANDOFF_SYSTEM },
    ...history,
    { role: 'user', content: 'Write the handoff note for the conversation above.' },
  ];
  const opts = { taskKind: 'work' as const, temperature: 0.2, maxTokens: HANDOFF_MAX_TOKENS, label: 'handoff' };
  const first = await routeOnce(request, { ...opts, model: utilityModelPreference() });
  if (first.text.trim()) return first.text.trim();
  const second = await routeOnce(request, { ...opts, exclude: [first.key] });
  return second.text.trim() || null;
}
