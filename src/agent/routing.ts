import type { CatalogModel, FallbackEntry, ChatContent } from '../shared/types';
import type { Catalog } from '../catalog/catalog';
import { normalizeAttachmentBlocks } from './content';

export type TaskKind = 'trivial' | 'chat' | 'agent' | 'coding' | 'debug' | 'longContext' | 'plan' | 'vision';

const GREETING = /^(hi+|hey+|hello+|yo|sup|howdy|gm|gn|good (morning|afternoon|evening|night)|thanks?|thank you|thx|ty|ok(ay)?|k|cool|nice|great|awesome|bye|goodbye|cheers|np|no problem|got it|sounds good)\b[\s!.?]*$/i;

const TASK_VERB = /\b(add|create|implement|build|write|fix|refactor|rename|move|delete|remove|update|change|modif(?:y|ies)|edit|generate|migrate|install|set ?up|wire|integrate|replace|convert|optimi[sz]e|run|test|make|put|turn|set|swap|drop|append|insert|extract|split|merge|comment|uncomment|format|bump|upgrade|downgrade|configure|enable|disable|support|handle|apply|hook|connect|expose|document|export|validate|cache|scaffold)\b/i;

const DEBUG_HINT = /\b(debug|bug|error|exception|stack ?trace|traceback|failing|fails?|failed|broken|crash(?:es|ed)?|throws?|not working|isn'?t working|won'?t (?:work|run|build|compile)|doesn'?t (?:work|run)|null pointer|segfault)\b|\bnot (?:loading|showing|rendering|displaying|working|saving|submitting|connecting|fetching|appearing|updating|redirecting|running|opening|logging in)\b|\b(?:can'?t|cannot|couldn'?t|won'?t|didn'?t|doesn'?t)\s+(?:log ?in|load|show|work|submit|run|open|save|fetch|connect|find|access|see|get|send|redirect|register|authenticate)\b|\b(?:shows?|returns?|displays?|gives?|outputs?)\s+(?:0|zero|null|undefined|nothing|empty|wrong|incorrect|the wrong)\b|\b(?:something (?:wrong|broken|off)|is (?:wrong|broken|incorrect)|looks (?:wrong|broken)|seems (?:broken|wrong)|does nothing|do nothing|nothing happens)\b/i;

const EXPLAIN_Q = /^\s*(how (?:do|to|can|could|would|does|is|are)|what(?:'?s| is| are| does| do)|why (?:do|does|is|are|would)|when (?:should|do|does|is)|which |who |whose |where (?:is|are|do|does|can)|should i|is it|are there|can i|could i|do i|does it|explain|describe|tell me|walk me|difference between)\b/i;

const FILE_REF = /(?:^|\s|[(["'`])(\.\/)?(\w[\w-./]*\.[a-zA-Z]{1,5})\b|```/;
const CODE_VERB = /\b(refactor|implement|write|generate|port|migrate|optimi[sz]e|debug|fix|extend|extract|scaffold|wire)\b/i;
const CODE_NOUN = /\b(function|method|class|component|hook|endpoint|api|route|handler|test|spec|schema|query|type|interface|module|util|service|model|directive|middleware|controller|repository|migration|contribution|submission|webhook|queue|observer|listener|factory|seeder|validation|request|resource|policy|scope|trait|enum|entity|payload|dto)\b/i;
const CODE_HINT = (t: string): boolean => FILE_REF.test(t) || (CODE_VERB.test(t) && CODE_NOUN.test(t));

/** Signals passed from the webview to classifyTask — attachment kinds drive vision routing. */
export interface ClassifySignals {
  attachments?: number;
  mentions?: number;
  /** Per-attachment kind, in send order. `image`/`pdf` force a vision route. */
  attachmentKinds?: Array<'file' | 'image' | 'pdf' | 'doc'>;
  /** True when the user forced Auto mode (lets the router pick vision naturally). */
  auto?: boolean;
}

/**
 * Derive `ClassifySignals.attachmentKinds` straight from a message's content —
 * by MIME, not by block type (`image_url` vs `file`), so adding a non-PDF document
 * kind later (.docx/.csv/...) doesn't silently mis-route as `'pdf'`. Only PDFs
 * genuinely need vision as a last resort (a scanned page with no text layer); other
 * docs always have extracted text and don't force the vision branch on their own,
 * but are still reported here for completeness/future use.
 */
export function attachmentKindsFromContent(content: ChatContent): NonNullable<ClassifySignals['attachmentKinds']> {
  return normalizeAttachmentBlocks(content).map((a): 'image' | 'pdf' | 'doc' => {
    if (a.mime.startsWith('image/')) return 'image';
    if (a.mime === 'application/pdf') return 'pdf';
    return 'doc';
  });
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

  if (words.length <= 6 && GREETING.test(t) && !TASK_VERB.test(t)) return 'trivial';

  const hasVisual = (signals?.attachmentKinds ?? []).some((k) => k === 'image' || k === 'pdf');

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

  const balanced = (a: CatalogModel, b: CatalogModel): number =>
    (a.intelligenceRank + a.speedRank) - (b.intelligenceRank + b.speedRank);

  const recency = (a: CatalogModel, b: CatalogModel): number => (b.released ?? '').localeCompare(a.released ?? '');

  const hasTag = (m: CatalogModel, tag: string): number => Number((m.tags ?? []).includes(tag));
  const codingTag = (a: CatalogModel, b: CatalogModel): number => hasTag(b, 'coding') - hasTag(a, 'coding');

  const vision = (a: CatalogModel, b: CatalogModel): number => Number(!!b.supportsVision) - Number(!!a.supportsVision);

  const cmp: Record<TaskKind, (a: CatalogModel, b: CatalogModel) => number> = {
    trivial: (a, b) => speed(a, b) || recency(a, b) || intel(a, b),                 // cheapest/fastest; smarts irrelevant
    chat: (a, b) => tools(a, b) || balanced(a, b) || recency(a, b) || intel(a, b),        // tool-capable, then fast+capable, newest among equals
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

