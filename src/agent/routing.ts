// Task-aware routing. Classifies a request from cheap signals (no extra LLM call,
// no latency) and orders candidate models by what the task actually needs — so a
// "hello" uses a fast tiny model with no tools, and a refactor uses a smart
// tool-capable one. This is what makes "Auto" feel smart instead of one-size-fits-all.
import type { CatalogModel, FallbackEntry } from '../shared/types';
import type { Catalog } from '../catalog/catalog';
import { classifyInformationRoute } from '../router/informationRouter';

export type TaskKind = 'trivial' | 'chat' | 'agent' | 'coding' | 'debug' | 'longContext' | 'plan' | 'vision';

// Greeting / acknowledgement that is the WHOLE message (anchored) — safe to treat as trivial.
const GREETING = /^(hi+|hey+|hello+|yo|sup|howdy|gm|gn|good (morning|afternoon|evening|night)|thanks?|thank you|thx|ty|ok(ay)?|k|cool|nice|great|awesome|bye|goodbye|cheers|np|no problem|got it|sounds good)\b[\s!.?]*$/i;
// Action/edit verbs — broad on purpose so natural phrasings ("make X", "put Y") still trigger edits.
const TASK_VERB = /\b(add|create|implement|build|write|fix|refactor|rename|move|delete|remove|update|change|modif(?:y|ies)|edit|generate|migrate|install|set ?up|wire|integrate|replace|convert|optimi[sz]e|run|test|make|put|turn|set|swap|drop|append|insert|extract|split|merge|comment|uncomment|format|bump|upgrade|downgrade|configure|enable|disable|support|handle|apply|hook|connect|expose|document|export|validate|cache|scaffold)\b/i;
// Real bug/diagnosis language — broad enough to catch natural phrasings, narrow enough
// not to hijack every "why" question. Groups:
//   1. Explicit bug words: debug, bug, error, exception, crash, …
//   2. "not <symptom-verb>": not loading, not showing, not rendering, …
//   3. Inability: can't/cannot/won't/doesn't + action verb
//   4. Wrong-value symptoms: shows 0, returns null, displays wrong, …
//   5. State descriptions: "something wrong with", "is broken", "does nothing"
const DEBUG_HINT = /\b(debug|bug|error|exception|stack ?trace|traceback|failing|fails?|failed|broken|crash(?:es|ed)?|throws?|not working|isn'?t working|won'?t (?:work|run|build|compile)|doesn'?t (?:work|run)|null pointer|segfault)\b|\bnot (?:loading|showing|rendering|displaying|working|saving|submitting|connecting|fetching|appearing|updating|redirecting|running|opening|logging in)\b|\b(?:can'?t|cannot|couldn'?t|won'?t|didn'?t|doesn'?t)\s+(?:log ?in|load|show|work|submit|run|open|save|fetch|connect|find|access|see|get|send|redirect|register|authenticate)\b|\b(?:shows?|returns?|displays?|gives?|outputs?)\s+(?:0|zero|null|undefined|nothing|empty|wrong|incorrect|the wrong)\b|\b(?:something (?:wrong|broken|off)|is (?:wrong|broken|incorrect)|looks (?:wrong|broken)|seems (?:broken|wrong)|does nothing|do nothing|nothing happens)\b/i;
// Explanation-seeking phrasing — answer, don't act (read-only chat).
const EXPLAIN_Q = /^\s*(how (?:do|to|can|could|would|does|is|are)|what(?:'?s| is| are| does| do)|why (?:do|does|is|are|would)|when (?:should|do|does|is)|which |who |whose |where (?:is|are|do|does|can)|should i|is it|are there|can i|could i|do i|does it|explain|describe|tell me|walk me|difference between)\b/i;
// Code-editing intent: a referenced file path, a fenced code block, or a code-edit verb paired
// with a code noun. Narrow so a generic "add a button" still routes as `agent` — only genuine
// code work pulls into `coding` (which then prefers coder-tagged models).
const FILE_REF = /(?:^|\s|[(["'`])(\.\/)?(\w[\w-./]*\.[a-zA-Z]{1,5})\b|```/;
const CODE_VERB = /\b(refactor|implement|write|generate|port|migrate|optimi[sz]e|debug|fix|extend|extract|scaffold|wire)\b/i;
const CODE_NOUN = /\b(function|method|class|component|hook|endpoint|api|route|handler|test|spec|schema|query|type|interface|module|util|service|model|directive|middleware)\b/i;
const CODE_HINT = (t: string): boolean => FILE_REF.test(t) || (CODE_VERB.test(t) && CODE_NOUN.test(t));
// Words indicating the user means THEIR codebase (not general knowledge).
const REPO_WORD = /\b(repo|repository|codebase|code base|this file|these files|this project|the project|our code|the code|this code|in here|this codebase)\b/i;
// UNAMBIGUOUS reference to the user's own project — scope is explicit, so always investigate
// locally and never web-search, regardless of how the request is phrased.
const STRONG_REPO = /\b(this (?:project|codebase|repo(?:sitory)?|code|file|app|application|system|feature|module)|these files|in this (?:repo(?:sitory)?|code)|in here|our (?:code\s?base|repo)|the codebase)\b/i;
// A question shape that asks about code/location/behavior (broader than EXPLAIN_Q — covers
// "where is X defined", "how does X work", "what does X do", "show me / find X").
const CODE_Q = /\b(where (is|are|can i find|defined)|how (does|do|is|are) .* (work|implemented|defined|used)|what (does|is) .* do|show me|find me|point me to|which file)\b/i;
// Investigative INTENT phrased as an imperative rather than a question — "search the code",
// "find/locate X", "look into", "check if", "give me an idea", "see if", "investigate". Users
// ask about their own codebase this way constantly, with no textbook question verb.
const RESEARCH_INTENT = /\b(search|find|locate|look (?:up|into|for|at)|check|investigat\w*|give me (?:an? )?idea|show me|tell me about|see (?:if|how|where|whether)|trace|grep|explore|understand|figure out|analyz\w*|review)\b/i;
// Unambiguous web-only triggers — time-sensitive or external data that can't live in the repo.
const WEB_ONLY = /\b(latest|today'?s?|current(?:ly)? (?:price|version|release|news)|news|released?|changelog|price|cost|weather|score|ranking|standings?|stock|20(?:2[4-9]|3\d)|this (?:week|month|year)|right now|recent(?:ly)? released?)\b/i;

/**
 * True when a question is really about the user's codebase — so Auto should investigate with
 * read-only tools (read/grep/graph) instead of answering blind.
 *
 * Three ways to qualify:
 *  1. An explicit project reference ("in this project", "this codebase", "this feature") — the user
 *     scoped it themselves, so investigate locally no matter the phrasing.
 *  2. An investigative shape paired with a codebase signal (repo word, code noun, or file path).
 *  3. An investigative shape with NO web-only signal — in a coding tool, ambiguous questions
 *     ("how does routing work?", "what is tiermux?") almost always mean the local project.
 *     Project search first; if nothing relevant is found, the model falls back to web.
 */
export function isCodebaseQuestion(t: string): boolean {
  if (STRONG_REPO.test(t)) return true;
  const investigative = EXPLAIN_Q.test(t) || CODE_Q.test(t) || RESEARCH_INTENT.test(t);
  if (!investigative) return false;
  if (REPO_WORD.test(t) || CODE_NOUN.test(t) || FILE_REF.test(t)) return true;
  // No explicit codebase signal, but also no clear web-only trigger → default to project search.
  return !WEB_ONLY.test(t);
}

/** What information sources a request needs — biases tool choice (workspace vs web). */
export interface InformationNeed {
  /** 0–1: how likely the answer lives in the user's workspace/code. */
  workspace: number;
  /** 0–1: how likely the answer needs current/external (web) information. */
  web: number;
}

// Upgrade/compat triggers → need BOTH (inspect code + check external versions/notes).
const HYBRID_TRIGGERS = /\b(upgrade|migrat\w*|compare|compatib\w*|integrat\w*|support\w*|bump|update\b[^.?!]*\bto\b)\b/i;

/**
 * Score how much a request needs the WORKSPACE vs the WEB, from cheap keyword signals (no LLM call).
 * Independent 0–1 scores — NOT a split — so a hybrid ("upgrade Laravel to the latest version") can
 * score HIGH on both. Feeds informationSourceHint(), which biases the unified tool loop rather than
 * locking the model into a code-only or web-only path.
 *
 * Delegates to classifyInformationRoute for the richer signal set, then maps to the existing
 * InformationNeed shape so callers remain unchanged.
 */
export function classifyInformationNeed(text: string): InformationNeed {
  const t = text || '';
  // Use the richer router for the codeSearch/webSearch flags, then apply legacy adjustments.
  const route = classifyInformationRoute(t, 'agent');
  let workspace = route.codeSearch ? 0.7 : 0;
  let web = route.webSearch ? 0.7 : 0;
  if (FILE_REF.test(t)) workspace = Math.min(1, workspace + 0.3);
  if (HYBRID_TRIGGERS.test(t)) { workspace = Math.min(1, workspace + 0.5); web = Math.min(1, web + 0.5); }
  // A bare question with no strong signal: in a coding tool, default to checking the workspace.
  if (workspace === 0 && web === 0) workspace = 0.4;
  return { workspace: Math.min(1, workspace), web: Math.min(1, web) };
}

const relevanceLevel = (n: number): 'HIGH' | 'MODERATE' | 'LOW' => (n >= 0.6 ? 'HIGH' : n >= 0.3 ? 'MODERATE' : 'LOW');

/**
 * Render an InformationNeed as a prompt block telling the model which source to reach for first.
 * The model still picks the actual tools (and can change its mind on feedback) — this just steers
 * the default, the way Claude Code / Cursor bias "local repo first" without a hard pre-route.
 */
export function informationSourceHint(need: InformationNeed): string {
  const ws = relevanceLevel(need.workspace);
  const web = relevanceLevel(need.web);
  let guidance: string;
  if (need.web >= 0.6 && need.workspace >= 0.6) {
    guidance = 'This needs BOTH: search the workspace (grep/codebaseSearch/readFile) for the project specifics AND webSearch for the current/external facts, then combine them.';
  } else if (need.web > need.workspace && need.workspace < 0.3) {
    guidance = 'Use webSearch first for the current/external information, then answer.';
  } else {
    guidance = 'Search the workspace first (grep/codebaseSearch/readFile); use web tools only for genuinely external or current facts this repo cannot answer.';
  }
  return `\n\n# Information sources\nWorkspace relevance: ${ws}\nWeb relevance: ${web}\n${guidance}`;
}

/**
 * Signals threaded through the webview → extension → router. The same shape
 * classifyTask accepts (kept for backward compat) plus vision hints.
 */
export interface ClassifySignals {
  attachments?: number;
  mentions?: number;
  /** Per-attachment kind, in send order. `image`/`pdf` force a vision route. */
  attachmentKinds?: Array<'file' | 'image' | 'pdf' | 'doc'>;
  /** True when the user forced Auto mode (lets the router pick vision naturally). */
  auto?: boolean;
}

/**
 * Classify the latest user message into a task kind from cheap heuristics.
 * Bias: anything that isn't clearly a greeting or a question defaults to `agent`,
 * so an edit request phrased without a textbook verb ("the navbar should be dark")
 * still gets the tool loop instead of a read-only answer.
 *
 * Vision override: any image or PDF attachment upgrades the request to `vision`
 * (or `agent` if tools are likely) so the router prefers a model with
 * `supportsVision: true`. If no vision model is enabled, falls back to text only.
 */
export function classifyTask(text: string, signals?: ClassifySignals): TaskKind {
  const t = (text || '').trim();
  if (!t) return 'chat';
  const words = t.split(/\s+/).filter(Boolean);

  // Trivial: a short greeting/acknowledgement and nothing else.
  if (words.length <= 6 && GREETING.test(t) && !TASK_VERB.test(t)) return 'trivial';

  // Vision: a visual attachment changes the kind so the router prioritizes a
  // vision-capable model. We still let "explain this image" land on chat/agent
  // (the image block is in the user message); the kind just steers the model
  // pick so a vision model wins over a tiny text-only default.
  const hasVisual = (signals?.attachmentKinds ?? []).some((k) => k === 'image' || k === 'pdf');

  // Large inputs need a big context window regardless of intent.
  if (t.length > 6000 || (signals?.attachments ?? 0) > 0 || (signals?.mentions ?? 0) >= 3) {
    return hasVisual ? 'vision' : 'longContext';
  }

  if (hasVisual) {
    if (DEBUG_HINT.test(t)) return 'vision';            // debug a screenshot/log → vision tool-capable
    if (EXPLAIN_Q.test(t)) return 'vision';             // "what's in this image" → read-only vision
    if (TASK_VERB.test(t)) return 'vision';             // "translate this screenshot" → vision tools ok
    if (t.endsWith('?')) return 'vision';
    return 'vision';
  }

  if (DEBUG_HINT.test(t)) return 'debug';            // a bug to chase (debug can investigate AND fix)
  if (EXPLAIN_Q.test(t)) return 'chat';              // explanation-seeking → read-only answer
  if (CODE_HINT(t)) return 'coding';                 // genuine code-edit intent → coder-preferred tool loop
  if (TASK_VERB.test(t)) return 'agent';             // explicit action → tool loop (can edit)
  if (t.endsWith('?')) return 'chat';                // a bare question → read-only
  return 'agent';                                    // ambiguous: assume an action so edits aren't dropped
}

/** Map an explicit mode to the task kind that best routes its model choice. */
export function modeToKind(mode: string): TaskKind {
  switch (mode) {
    case 'agent': return 'agent';
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
  // Balanced "fast AND capable" score: lower = better. Summing intelligence +
  // speed means a fast smart model (intel 2, speed 1 → 3) leads a slow frontier
  // one (intel 1, speed 5 → 6), so the first response is quick. Escalation still
  // reaches the smartest models — the maxIntelligenceRank floor includes rank 1.
  const balanced = (a: CatalogModel, b: CatalogModel): number =>
    (a.intelligenceRank + a.speedRank) - (b.intelligenceRank + b.speedRank);
  // Newer first. Only ever a tiebreaker — so when two models rate equally on what
  // the task needs, the more recent one wins instead of the older equal always
  // taking the slot. Missing `released` sorts as oldest.
  const recency = (a: CatalogModel, b: CatalogModel): number => (b.released ?? '').localeCompare(a.released ?? '');
  // Prefer models tagged for the task (e.g. ["coding"]) — the tag is the clearest signal
  // that a model was built for this kind of work, so it leads before generic fitness.
  const hasTag = (m: CatalogModel, tag: string): number => Number((m.tags ?? []).includes(tag));
  const codingTag = (a: CatalogModel, b: CatalogModel): number => hasTag(b, 'coding') - hasTag(a, 'coding');

  // Vision-capable comparator: prefer a model that can actually see the image
  // (supportsVision=true), then prefer tools+balanced+recency like agent mode.
  // A non-vision model still ranks, just below every vision-capable one — so
  // when nothing vision-capable is enabled, the user gets a sensible text fallback.
  const vision = (a: CatalogModel, b: CatalogModel): number => Number(!!b.supportsVision) - Number(!!a.supportsVision);

  const cmp: Record<TaskKind, (a: CatalogModel, b: CatalogModel) => number> = {
    trivial: (a, b) => speed(a, b) || recency(a, b) || intel(a, b),                 // cheapest/fastest; smarts irrelevant
    chat: (a, b) => speed(a, b) || recency(a, b) || intel(a, b),                    // snappy but capable, newest among equals
    coding: (a, b) => codingTag(a, b) || tools(a, b) || balanced(a, b) || recency(a, b), // coder-tagged, then tools, fast+capable
    agent: (a, b) => tools(a, b) || codingTag(a, b) || balanced(a, b) || recency(a, b),  // tools, then coder-tagged, fast+capable
    debug: (a, b) => tools(a, b) || codingTag(a, b) || balanced(a, b) || reason(a, b) || recency(a, b),
    plan: (a, b) => balanced(a, b) || reason(a, b) || tools(a, b) || recency(a, b), // fast+capable first, reasoning breaks ties
    longContext: (a, b) => ctx(a, b) || balanced(a, b) || recency(a, b),            // biggest window, then fast+capable, then newest
    vision: (a, b) => vision(a, b) || tools(a, b) || balanced(a, b) || recency(a, b), // must-see models first, then like agent
  };

  const sc = score ?? ((): number => 0);
  const sorted = [...withModel].sort(
    (a, b) =>
      sc(b.e.platform, b.e.modelId) - sc(a.e.platform, a.e.modelId) || // user feedback first (0 when none)
      cmp[kind](a.m, b.m),                                              // then task fitness
  );
  return [...sorted.map((x) => x.e), ...unknown];
}

/**
 * A cheap pre-task sizing of the work, derived from code-graph impact breadth and
 * embeddings-index novelty. Drives the intelligence floor (rankFloor) and the step
 * budget Auto grants a run. `null` signals mean "unknown" → fall back to moderate.
 */
export interface TaskProfile {
  complexity: 'light' | 'moderate' | 'heavy';
  /** Max intelligence rank allowed (lower = smarter). Heavy work gets a stricter floor. */
  rankFloor: number;
  impactFiles: number | null;
  topSimilarity: number | null;
}

export function deriveTaskProfile(impactFiles: number | null, topSimilarity: number | null): TaskProfile {
  const heavy = (impactFiles != null && impactFiles > 8) || (topSimilarity != null && topSimilarity < 0.3);
  const light = (impactFiles == null || impactFiles <= 2) && (topSimilarity == null || topSimilarity > 0.5);
  const complexity: TaskProfile['complexity'] = heavy ? 'heavy' : light ? 'light' : 'moderate';
  const rankFloor = complexity === 'heavy' ? 2 : complexity === 'moderate' ? 3 : 5;
  return { complexity, rankFloor, impactFiles, topSimilarity };
}

/**
 * The task kind to route at a given iteration of the agent loop. Auto runs move through
 * phases: the first hop reasons/plans (a reasoning model decomposes the task), then the
 * classified execute kind takes over (coder for code, agent/debug otherwise). Non-agent
 * bases (e.g. plan) are returned unchanged so read-only research routing stays stable.
 */
export function phaseRouteKind(base: TaskKind, iteration: number): TaskKind {
  // Vision/plan/chat/trivial/longContext have their own model ordering that shouldn't be
  // phase-rewritten — only agent/coding/debug tasks move through a plan→execute progression.
  if (base !== 'agent' && base !== 'coding' && base !== 'debug') return base;
  return iteration === 0 ? 'plan' : base;
}
