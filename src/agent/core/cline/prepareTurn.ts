// Cline's host-owned request projection (AgentRuntimeConfig.prepareTurn). Two jobs:
//
// 1. Per-request tool-output aging + compaction — the same tiers the old engine's prepareStep
//    ran (compact.ts), fed by the `tiermux.agent.toolCompaction` setting (declared and
//    documented but read by nothing on the Cline branch until now).
// 2. Overflow recovery: when a provider rejects the request as over the window, the runtime
//    re-invokes prepareTurn ONCE per run with overflowRecovery: true and demands a strictly
//    shorter projection (JSON length), else the run terminates. This is the only compaction
//    path the runtime offers, and before this hook existed the overflow path was a dead end
//    (terminal CONTEXT_WINDOW_OVERFLOW_NO_RECOVERY).
//
// Affects ONLY the provider request — the canonical transcript, workMessages and persisted
// history are never touched (the prepareTurn contract in @cline/shared's agent.d.ts).
import type { AgentMessage, AgentRuntimePrepareTurnContext, AgentRuntimePrepareTurnResult } from '@cline/shared';
import type { ModelMessage } from 'ai';
import { ageToolOutputs, compactIfNeeded, estimateTokens } from '../compact';
import { diagLog } from '../../../util/diag';

/** AgentMessage[] and the AI SDK ModelMessage[] differ only in envelope fields (id/createdAt)
 *  the compaction utilities never read — ageToolOutputs/compactIfNeeded/pruneMessages work on
 *  role/content/part shapes, which are wire-compatible. Ids are re-synthesized on the way
 *  back; a request projection is never persisted, so canonical ids are untouched. */
function asModelMessages(messages: readonly AgentMessage[]): ModelMessage[] {
  return messages as unknown as ModelMessage[];
}

/** Re-envelope a projected ModelMessage[] as AgentMessage[]. */
function toAgentMessages(messages: ModelMessage[], startN: number): AgentMessage[] {
  return messages.map((m, i) => ({
    id: `pt_${startN + i}`,
    role: m.role as AgentMessage['role'],
    content: m.content,
    createdAt: Date.now(),
  })) as unknown as AgentMessage[];
}

export interface PrepareTurnOptions {
  /** Mirrors tiermux.agent.toolCompaction: 'off' disables per-request aging/compaction. */
  level: 'off' | 'light' | 'aggressive';
  /** The serving model's context window, refined per run by onModel → findCatalogModel. */
  windowOf: () => number;
  /** Status line for the webview's step chip ("compacting…"). */
  onNotice?: (message: string) => void;
}

/** Overflow path: age hard and keep little — the alternative is losing the whole run. */
const OVERFLOW_AGE_MIN_CHARS = 500;
const OVERFLOW_KEEP_RECENT = 2;
/** Overflow path: the newest exchanges survive oldest-first eviction. */
const OVERFLOW_KEEP_EXCHANGES = 4;
/** The sub-agent's report is the delegation's whole synthesis — same exemption compact.ts uses. */
const OVERFLOW_EXEMPT_TOOLS = new Set(['delegateTask']);

function jsonLen(messages: readonly unknown[]): number {
  return JSON.stringify(messages).length;
}

/** Drop the OLDEST tool exchanges (a tool message plus its matching tool-call part in the
 *  preceding assistant message) until the projection is strictly shorter by JSON length, or
 *  nothing droppable remains. Call+result pairs go together, so the OpenAI wire's call/result
 *  pairing stays valid. delegateTask results are exempt. */
function dropOldestExchanges(messages: readonly AgentMessage[], keepRecent: number): AgentMessage[] {
  const toolIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') toolIdx.push(i);
  }
  const droppable = toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent));
  const out = [...messages] as AgentMessage[];
  let shrunk = false;
  for (const ti of droppable) {
    const tm = out[ti];
    if (!tm || tm.role !== 'tool') continue; // already removed via an earlier assistant collapse
    const parts = Array.isArray(tm.content) ? tm.content : [];
    const exempt = parts.some((p) => p.type === 'tool-result' && OVERFLOW_EXEMPT_TOOLS.has(String(p.toolName)));
    if (exempt) continue;
    out[ti] = undefined as unknown as AgentMessage;
    // Remove the matching tool-call part(s) from the assistant message that issued them.
    for (let j = ti - 1; j >= 0; j--) {
      const am = out[j];
      if (!am || am.role !== 'assistant') continue;
      if (!Array.isArray(am.content)) continue;
      const filtered = am.content.filter((p) => !(p.type === 'tool-call'
        && parts.some((rp) => rp.type === 'tool-result' && rp.toolCallId === p.toolCallId)));
      if (filtered.length !== am.content.length) {
        out[j] = filtered.length
          ? ({ ...am, content: filtered } as AgentMessage)
          : (undefined as unknown as AgentMessage);
      }
      break;
    }
    shrunk = true;
  }
  if (!shrunk) return messages as AgentMessage[];
  return out.filter(Boolean);
}

export function makePrepareTurn(opts: PrepareTurnOptions) {
  return async (ctx: AgentRuntimePrepareTurnContext): Promise<AgentRuntimePrepareTurnResult | undefined> => {
    const messages = ctx.messages;
    if (!messages.length) return undefined;
    const notice = (m: string) => {
      ctx.emitStatusNotice?.(m);
      opts.onNotice?.(m);
      diagLog('cline.prepareTurn', m);
    };

    // ── Overflow recovery: guarantee a strictly shorter projection or return undefined (the
    // runtime then raises its terminal NOTHING_TO_COMPACT — the correct, visible outcome).
    if (ctx.overflowRecovery) {
      notice('Context window exceeded — compacting the request…');
      // 1. Age every eligible tool output, hard.
      const aged = ageToolOutputs(asModelMessages(messages), OVERFLOW_AGE_MIN_CHARS, OVERFLOW_KEEP_RECENT);
      let out = toAgentMessages(aged.messages ?? asModelMessages(messages), messages.length);
      if (jsonLen(out) < jsonLen(messages)) return { messages: out };
      // 2. The two prune tiers (re-derivable searches, then reads/shell outside the last few).
      const pruned = compactIfNeeded(asModelMessages(messages), opts.windowOf());
      if (pruned.messages) {
        out = toAgentMessages(pruned.messages, messages.length);
        if (jsonLen(out) < jsonLen(messages)) return { messages: out };
      }
      // 3. Evict whole exchanges, oldest first, newest kept.
      const evicted = dropOldestExchanges(messages, OVERFLOW_KEEP_EXCHANGES);
      if (evicted !== messages && jsonLen(evicted) < jsonLen(messages)) return { messages: evicted };
      // Nothing compactable — return undefined so the runtime raises its terminal.
      diagLog('cline.prepareTurn', 'overflow recovery found nothing to compact');
      return undefined;
    }

    // ── Normal per-request projection. 'off' skips everything — the runtime passes the
    // canonical transcript through untouched.
    if (opts.level === 'off') return undefined;
    const mm = asModelMessages(messages);
    // The provider's real count from the previous request (when the model reports usage) is a
    // floor on the char-based estimate, which under-counts dense content.
    const est = Math.max(estimateTokens(mm), ctx.previousRequestInputTokens ?? 0);
    const window = opts.windowOf();

    const aged = ageToolOutputs(mm, opts.level === 'aggressive' ? 500 : undefined, opts.level === 'aggressive' ? 1 : undefined);
    const agedMsgs = aged.messages ?? mm;

    // Compact at 80% of the window — the same trigger compactIfNeeded uses internally, made
    // explicit here so the estimate can include previousRequestInputTokens.
    if (est >= window * 0.8) {
      notice('Context is crowded — compacting the request…');
      const compacted = compactIfNeeded(agedMsgs, window);
      if (compacted.messages) return { messages: toAgentMessages(compacted.messages, messages.length) };
    }
    if (aged.messages && agedMsgs !== mm) return { messages: toAgentMessages(agedMsgs, messages.length) };
    return undefined;
  };
}
