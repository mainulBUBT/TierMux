

import type { ChatMessage } from '../shared/types';
import { contentToString } from './content';

interface OcMessageInfo { id: string; role: string }
interface OcMessage { info: OcMessageInfo; parts?: unknown[] }

/**
 * Finds the OC message id to fork at, so the new session inherits every FULLY SETTLED
 * prior turn and excludes the turn currently being (re)attempted.
 *
 * Verified empirically against the real OC binary (v1.17.11): forking at a USER
 * message's id returns everything STRICTLY BEFORE it. Forking at an ASSISTANT id
 * instead — DO NOT do this — leaves that turn's user message dangling in the new
 * session: resending it duplicates the question, and targeting it via the prompt's
 * own `messageID` field silently keeps the OLD model instead of switching.
 *
 * `priorUserTurnCount` is TierMux's own ground truth (derived from `opts.messages`,
 * which is always accurate) for how many turns were already fully settled before the
 * one currently in flight. We only need OC's own message list to locate that boundary
 * in the OLD session, and — for Hot Standby's prewarm, which forks while the current
 * turn may still be mid-flight — to detect whether that turn's user message has
 * already landed there. If it has, we exclude it explicitly; if not, "no messageID"
 * already yields exactly the prior turns. Either way the result is deterministic.
 */
export function findReplayBoundary(oldMessages: OcMessage[], priorUserTurnCount: number): string | undefined {
  if (priorUserTurnCount <= 0) return undefined; // nothing prior to replay
  const userIds = oldMessages.filter((m) => m.info.role === 'user').map((m) => m.info.id);
  return userIds[priorUserTurnCount]; // the current turn's own user id, if already present — else undefined
}

/**
 * Fallback replay when `fork` is unavailable or fails: flattens the conversation into
 * a single role-labeled prompt, ending with the current turn's question. Lossier than
 * a native fork (tool calls collapse to text), but only ever used once per recreated
 * session, on the very first prompt sent to it.
 */
export function formatTranscriptForReplay(messages: ChatMessage[]): string {

  const contentOf = (m: ChatMessage): string => contentToString(m.content);
  const prior = messages.slice(0, -1);
  const current = messages[messages.length - 1];
  const label = (role: string): string => {
    switch (role) {
      case 'system': return 'System';
      case 'assistant': return 'Assistant';
      case 'tool': return 'Tool result';
      default: return 'User';
    }
  };
  const blocks = prior.map((m) => `${label(m.role)}:\n${contentOf(m)}`);
  blocks.push(`Current User:\n${current ? contentOf(current) : ''}`);
  return blocks.join('\n\n');
}
