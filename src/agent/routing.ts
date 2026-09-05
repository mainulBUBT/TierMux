import type { ChatContent } from '../shared/types';
import { normalizeAttachmentBlocks } from './content';

export type TaskKind = 'trivial' | 'chat' | 'agent' | 'coding' | 'debug' | 'longContext' | 'plan' | 'vision';

const GREETING = /^(hi+|hey+|hello+|yo|sup|howdy|gm|gn|good (morning|afternoon|evening|night)|thanks?|thank you|thx|ty|ok(ay)?|k|cool|nice|great|awesome|bye|goodbye|cheers|np|no problem|got it|sounds good)\b[\s!.?]*$/i;

const TASK_VERB = /\b(add|create|implement|build|write|fix|refactor|rename|move|delete|remove|update|change|modif(?:y|ies)|edit|generate|migrate|install|set ?up|wire|integrate|replace|convert|optimi[sz]e|run|test|make|put|turn|set|swap|drop|append|insert|extract|split|merge|comment|uncomment|format|bump|upgrade|downgrade|configure|enable|disable|support|handle|apply|hook|connect|expose|document|export|validate|cache|scaffold)\b/i;

/** `error` is excluded when it heads a UI noun — "error state(s)", "error handling/handled",
 *  "error boundary". Those name something to BUILD, not a failure being reported: "add error
 *  states to the checkout form" is a coding task, and routing it to `debug` picks a debug-tier
 *  model and the debug prompt for work that is nothing of the sort. (Found via the /design skill
 *  body, which lists "empty, loading, and error states" and was classified `debug` because of
 *  this one word.) Every other failure phrasing is untouched. */
const DEBUG_HINT = /\b(debug|bug|error(?!\s*(?:state|handling|handled|boundar))|exception|stack ?trace|traceback|failing|fails?|failed|broken|crash(?:es|ed)?|throws?|not working|isn'?t working|won'?t (?:work|run|build|compile)|doesn'?t (?:work|run)|null pointer|segfault)\b|\bnot (?:loading|showing|rendering|displaying|working|saving|submitting|connecting|fetching|appearing|updating|redirecting|running|opening|logging in)\b|\b(?:can'?t|cannot|couldn'?t|won'?t|didn'?t|doesn'?t)\s+(?:log ?in|load|show|work|submit|run|open|save|fetch|connect|find|access|see|get|send|redirect|register|authenticate)\b|\b(?:shows?|returns?|displays?|gives?|outputs?)\s+(?:0|zero|null|undefined|nothing|empty|wrong|incorrect|the wrong)\b|\b(?:something (?:wrong|broken|off)|is (?:wrong|broken|incorrect)|looks (?:wrong|broken)|seems (?:broken|wrong)|does nothing|do nothing|nothing happens)\b/i;

// `what (kind|sort|type) of …` is listed explicitly: TASK_VERB contains nouns that double as verbs
// (`cache`, `test`, `format`, `support`), so "what kind of cache is this?" fell through to `agent`
// — a read-only question handed an edit-capable tool set.
const EXPLAIN_Q = /^\s*(how (?:do|to|can|could|would|does|is|are)|what (?:kind|sort|type)s? of|what(?:'?s| is| are| does| do)|why (?:do|does|is|are|would)|when (?:should|do|does|is)|which |who |whose |where (?:is|are|do|does|can)|should i|is it|are there|can i|could i|do i|does it|explain|describe|tell me|walk me|difference between)\b/i


/** The explanation verbs again, WITHOUT the `^` anchor. EXPLAIN_Q only matches at the start of a
 *  message, so "ok so explain how routing works" — or any language that puts the verb last, e.g.
 *  romanized Bengali "ei file ta explain koro" — fell through to TASK_VERB/`agent` and got an
 *  edit-capable tool set for what was a read-only question. Kept separate (and checked after the
 *  anchored form) so the leading-question fast path keeps its precedence. */
const EXPLAIN_VERB = /\b(explain|describe|walk me through|tell me about|bujhiye|bujhao|bojhao|bujhai)\b/i

/**
 * Romanized Bengali ("Banglish") signals. This user writes nearly every message this way, and the
 * English-only regexes above classified 6 of 11 real messages as low-confidence `agent` — the
 * ambiguous default, which hands a plain remark a mutating tool set AND pays for an extra LLM
 * classify call. GitHub's own Copilot docs state routing should be language-invariant: "Routing
 * decisions depend on what you are trying to do, not what language you're asking in."
 *
 * Written with word boundaries and multi-character stems so they can't fire inside English words
 * (`\bkor\b` cannot match "korean"; `\bki\b` cannot match "kind").
 */
const BN_TASK_VERB = /\b(kor(?:o|un|be|chi|te|ben|te ?hobe)?|kore ?(?:dao|den|dio)|banao|banan|banate|likh(?:o|un|te)?|lekho|thik ?kor\w*|ঠিক|muche ?(?:dao|felo)|poriborton|bodla(?:o|te)|joga(?:o|te)|add ?kor\w*|fix ?kor\w*|update ?kor\w*|delete ?kor\w*)\b/i
const BN_EXPLAIN_Q = /\b(ki+\b|kiser|kivabe|ki ?vabe|kemne|kemon|keno|kothay|kon\b|kobe|kar\b|kaj ?ki|kaj ?kore|bujhi?ye|bujhte|mane ?ki)\b/i
const BN_DEBUG_HINT = /\b(kaj ?kor(?:e|che) ?na|hocche ?na|hoy ?na|hoche ?na|dekha(?:y|cche) ?na|ashe ?na|ase ?na|somossa|shomosha|problem ?hocche|vul|bhul|error ?dicche|bhang\w*|nosto)\b/i

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
/** Same classification as `classifyTask`, but also reports whether a regex actually matched
 *  (`confident`) vs. we fell through to a best-guess default. */
export function classifyTaskCore(text: string, signals?: ClassifySignals): { kind: TaskKind; confident: boolean } {
  const t = (text || '').trim();
  if (!t) return { kind: 'chat', confident: true };
  const words = t.split(/\s+/).filter(Boolean);

  const hasVisual = (signals?.attachmentKinds ?? []).some((k) => k === 'image' || k === 'pdf');

  if (!hasVisual && words.length <= 6 && GREETING.test(t) && !TASK_VERB.test(t)) return { kind: 'trivial', confident: true };

  if (t.length > 6000 || (signals?.attachments ?? 0) > 0 || (signals?.mentions ?? 0) >= 3) {
    return { kind: hasVisual ? 'vision' : 'longContext', confident: true };
  }
  if (hasVisual) {
    if (DEBUG_HINT.test(t)) return { kind: 'vision', confident: true };  // debug a screenshot/log → vision tool-capable
    if (EXPLAIN_Q.test(t)) return { kind: 'vision', confident: true };   // "what's in this image" → read-only vision
    if (TASK_VERB.test(t)) return { kind: 'vision', confident: true };   // "translate this screenshot" → vision tools ok
    if (t.endsWith('?')) return { kind: 'vision', confident: true };
    return { kind: 'vision', confident: false };
  }

  if (DEBUG_HINT.test(t) || BN_DEBUG_HINT.test(t)) return { kind: 'debug', confident: true };   // a bug to chase (debug can investigate AND fix)
  if (EXPLAIN_Q.test(t)) return { kind: 'chat', confident: true };     // explanation-seeking → read-only answer
  if (CODE_HINT(t)) return { kind: 'coding', confident: true };        // genuine code-edit intent → coder-preferred tool loop
  // An explanation request beats a BARE auxiliary verb: "ei file ta explain koro" is "please
  // explain", not an edit — `koro`/`kore dao` carry no intent of their own. A concrete English
  // task verb still wins, which is why TASK_VERB is the exception rather than BN_TASK_VERB.
  if ((EXPLAIN_VERB.test(t) || BN_EXPLAIN_Q.test(t)) && !TASK_VERB.test(t)) return { kind: 'chat', confident: true };
  if (TASK_VERB.test(t) || BN_TASK_VERB.test(t)) return { kind: 'agent', confident: true };    // explicit action → tool loop (can edit)
  if (t.endsWith('?')) return { kind: 'chat', confident: true };       // a bare question → read-only
  // A referenced @mention already resolved its content into the context block (see
  // mentions.ts) — with no code-edit/debug/question signal, this is a "work from what I gave
  // you" turn, not a codebase investigation. Route to chat so a weak model uses the supplied
  // content instead of searching for it.
  if ((signals?.mentions ?? 0) >= 1) return { kind: 'chat', confident: false };
  return { kind: 'agent', confident: false };         // ambiguous: assume an action so edits aren't dropped
}

/** Regex-only classification — synchronous, zero extra latency. This is the FIRST word only:
 *  `classifyTaskSmart` (loop.ts) re-decides non-trivial turns with a cheap LLM and falls back
 *  to this result when no classifier model is available or the call fails. Kept for call sites
 *  that need a sync, no-I/O answer (e.g. filtering trivial messages while picking a session title). */
export function classifyTask(text: string, signals?: ClassifySignals): TaskKind {
  return classifyTaskCore(text, signals).kind;
}

/** True for a turn whose ONLY ask is "describe/explain the attached image itself" — an
 *  explanation request (English or Banglish) with no task/debug intent and no workspace
 *  reference. These turns run WITHOUT workspace tools and WITHOUT the auto-detected project
 *  profile: a weak model handed repo facts/tools alongside an app screenshot will fuse the two
 *  and present repo guesses as facts about the image (observed 2026-08-24/25: a trip-screen
 *  screenshot "explained" via Laravel file paths, and a repo file walkthrough instead of the
 *  image). Debug-screenshot turns ("fix this error") deliberately do NOT match — there the
 *  repo context is exactly what helps. */
export function isPureVisualDescribe(text: string, hasVisual: boolean): boolean {
  if (!hasVisual) return false;
  const t = (text || '').trim();
  if (!t) return true; // attachment with no caption — describe is the only possible intent
  if (TASK_VERB.test(t) || DEBUG_HINT.test(t) || BN_TASK_VERB.test(t) || BN_DEBUG_HINT.test(t)) return false;
  // A workspace reference in the text ("explain src/auth.ts", "@notes.md") means the repo IS
  // part of the subject — tools must stay so the model can actually read it.
  if (/@[\w.-]/.test(t) || /(?:^|[\s("'`])((?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,5})\b/.test(t)) return false;
  return EXPLAIN_Q.test(t) || EXPLAIN_VERB.test(t) || BN_EXPLAIN_Q.test(t);
}

