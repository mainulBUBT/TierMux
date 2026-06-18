// Task-aware routing. Classifies a request from cheap signals (no extra LLM call,
// no latency) and orders candidate models by what the task actually needs — so a
// "hello" uses a fast tiny model with no tools, and a refactor uses a smart
// tool-capable one. This is what makes "Auto" feel smart instead of one-size-fits-all.
import type { CatalogModel, FallbackEntry } from '../shared/types';
import type { Catalog } from '../catalog/catalog';

export type TaskKind = 'trivial' | 'chat' | 'agent' | 'debug' | 'longContext' | 'plan';

// Greeting / acknowledgement that is the WHOLE message (anchored) — safe to treat as trivial.
const GREETING = /^(hi+|hey+|hello+|yo|sup|howdy|gm|gn|good (morning|afternoon|evening|night)|thanks?|thank you|thx|ty|ok(ay)?|k|cool|nice|great|awesome|bye|goodbye|cheers|np|no problem|got it|sounds good)\b[\s!.?]*$/i;
// Action/edit verbs — broad on purpose so natural phrasings ("make X", "put Y") still trigger edits.
const TASK_VERB = /\b(add|create|implement|build|write|fix|refactor|rename|move|delete|remove|update|change|modif(?:y|ies)|edit|generate|migrate|install|set ?up|wire|integrate|replace|convert|optimi[sz]e|run|test|make|put|turn|set|swap|drop|append|insert|extract|split|merge|comment|uncomment|format|bump|upgrade|downgrade|configure|enable|disable|support|handle|apply|hook|connect|expose|document|export|validate|cache|scaffold)\b/i;
// Real bug/diagnosis language (kept narrow so it doesn't hijack every "why" question).
const DEBUG_HINT = /\b(debug|bug|error|exception|stack ?trace|traceback|failing|fails?|failed|broken|crash(?:es|ed)?|throws?|not working|isn'?t working|won'?t (?:work|run|build|compile)|doesn'?t (?:work|run)|null pointer|segfault)\b/i;
// Explanation-seeking phrasing — answer, don't act (read-only chat).
const EXPLAIN_Q = /^\s*(how (?:do|to|can|could|would|does|is|are)|what(?:'?s| is| are| does| do)|why (?:do|does|is|are|would)|when (?:should|do|does|is)|which |who |whose |where (?:is|are|do|does|can)|should i|is it|are there|can i|could i|do i|does it|explain|describe|tell me|walk me|difference between)\b/i;

/**
 * Classify the latest user message into a task kind from cheap heuristics.
 * Bias: anything that isn't clearly a greeting or a question defaults to `agent`,
 * so an edit request phrased without a textbook verb ("the navbar should be dark")
 * still gets the tool loop instead of a read-only answer.
 */
export function classifyTask(text: string, signals?: { attachments?: number; mentions?: number }): TaskKind {
  const t = (text || '').trim();
  if (!t) return 'chat';
  const words = t.split(/\s+/).filter(Boolean);

  // Trivial: a short greeting/acknowledgement and nothing else.
  if (words.length <= 6 && GREETING.test(t) && !TASK_VERB.test(t)) return 'trivial';

  // Large inputs need a big context window regardless of intent.
  if (t.length > 6000 || (signals?.attachments ?? 0) > 0 || (signals?.mentions ?? 0) >= 3) return 'longContext';

  if (DEBUG_HINT.test(t)) return 'debug';            // a bug to chase (debug can investigate AND fix)
  if (EXPLAIN_Q.test(t)) return 'chat';              // explanation-seeking → read-only answer
  if (TASK_VERB.test(t)) return 'agent';             // explicit action → tool loop (can edit)
  if (t.endsWith('?')) return 'chat';                // a bare question → read-only
  return 'agent';                                    // ambiguous: assume an action so edits aren't dropped
}

/** Map an explicit mode to the task kind that best routes its model choice. */
export function modeToKind(mode: string): TaskKind {
  switch (mode) {
    case 'agent': return 'agent';
    case 'debug': return 'debug';
    case 'orchestrator': return 'agent';
    case 'plan': return 'plan';
    default: return 'chat';
  }
}

/**
 * Reorder enabled candidates to favor the model class this task needs. When a
 * `score` fn is given (user 👍/👎 feedback), it is the PRIMARY key — a model the
 * user rated well for this task floats above raw catalog fitness. Unknown models trail.
 */
export function orderForTask(
  kind: TaskKind,
  entries: FallbackEntry[],
  catalog: Catalog,
  score?: (platform: string, modelId: string) => number,
): FallbackEntry[] {
  const withModel = entries
    .map((e) => ({ e, m: catalog.find(e.platform, e.modelId) }))
    .filter((x): x is { e: FallbackEntry; m: CatalogModel } => !!x.m);
  const unknown = entries.filter((e) => !catalog.find(e.platform, e.modelId));

  const intel = (a: CatalogModel, b: CatalogModel): number => a.intelligenceRank - b.intelligenceRank;
  const speed = (a: CatalogModel, b: CatalogModel): number => a.speedRank - b.speedRank;
  const ctx = (a: CatalogModel, b: CatalogModel): number => (b.contextWindow ?? 0) - (a.contextWindow ?? 0);
  const tools = (a: CatalogModel, b: CatalogModel): number => Number(b.supportsTools) - Number(a.supportsTools);
  const reason = (a: CatalogModel, b: CatalogModel): number => Number(b.supportsReasoning) - Number(a.supportsReasoning);
  // Newer first. Only ever a tiebreaker — so when two models rate equally on what
  // the task needs, the more recent one wins instead of the older equal always
  // taking the slot. Missing `released` sorts as oldest.
  const recency = (a: CatalogModel, b: CatalogModel): number => (b.released ?? '').localeCompare(a.released ?? '');

  const cmp: Record<TaskKind, (a: CatalogModel, b: CatalogModel) => number> = {
    trivial: (a, b) => speed(a, b) || recency(a, b) || intel(a, b),                 // cheapest/fastest; smarts irrelevant
    chat: (a, b) => speed(a, b) || recency(a, b) || intel(a, b),                    // snappy but capable, newest among equals
    agent: (a, b) => tools(a, b) || intel(a, b) || recency(a, b) || speed(a, b),    // tools, then smart, then newest
    debug: (a, b) => reason(a, b) || tools(a, b) || intel(a, b) || recency(a, b),   // reasoning + tools + smart + newest
    plan: (a, b) => intel(a, b) || reason(a, b) || tools(a, b) || recency(a, b),    // smartest reasoner; it reads code, speed irrelevant
    longContext: (a, b) => ctx(a, b) || intel(a, b) || recency(a, b),               // biggest window, then newest
  };

  const sc = score ?? ((): number => 0);
  const sorted = [...withModel].sort(
    (a, b) =>
      sc(b.e.platform, b.e.modelId) - sc(a.e.platform, a.e.modelId) || // user feedback first (0 when none)
      cmp[kind](a.m, b.m),                                              // then task fitness
  );
  return [...sorted.map((x) => x.e), ...unknown];
}
