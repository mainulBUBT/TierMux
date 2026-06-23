// Richer intent classification: produces a structured routing decision that drives the
// pre-agent research pipeline and tool-loop steering. Runs from cheap regex signals only —
// no LLM call, no latency. Extends the existing InformationNeed from routing.ts with
// additional flags and extracted search terms.
import type { TaskKind } from '../agent/routing';

export interface InformationRoute {
  /** Needs workspace tool calls (grep/glob/readFile/codebaseSearch). */
  codeSearch: boolean;
  /** Needs external/current information (webSearch/webFetch). */
  webSearch: boolean;
  /** Multi-step task — should route as 'plan' on first iteration. */
  needsPlan: boolean;
  /** Bug/error task — should pre-fetch diagnostics. */
  needsDebug: boolean;
  /** Key terms extracted from the request — used to seed pre-research grep/search. */
  searchTerms: string[];
  /**
   * Explicitly mentioned file paths (from @path syntax or bare paths in the message).
   * The research pipeline reads these directly — skipping the grep→model→readFile cycle.
   */
  directFiles: string[];
  /**
   * 0–1 confidence. High = one signal dominates (safe to use it exclusively).
   * Low = signals are mixed — run broader research rather than betting on one path.
   */
  confidence: number;
}

// ---- Reused patterns (kept in sync with routing.ts) ----
const FILE_REF = /(?:^|\s|[(["'`])(\.\/)?(\w[\w-./]*\.[a-zA-Z]{1,5})\b|```/;
const CODE_VERB = /\b(refactor|implement|write|generate|port|migrat\w*|optimi[sz]e|debug|fix|extend|extract|scaffold|wire|create|add|edit|update|change|delete|remove|rename|move)\b/i;
const CODE_NOUN = /\b(function|method|class|component|hook|endpoint|api|route|handler|test|spec|schema|query|type|interface|module|util|service|model|directive|middleware|controller|repository|store|action|reducer|selector|helper|provider|config|constant)\b/i;
const STRONG_REPO = /\b(this (?:project|codebase|repo(?:sitory)?|code|file|app|application|system|feature|module)|these files|in this (?:repo(?:sitory)?|code)|in here|our (?:code\s?base|repo)|the codebase)\b/i;
const REPO_WORD = /\b(repo|repository|codebase|code base|this file|these files|this project|the project|our code|the code|this code|in here|this codebase)\b/i;
const WEB_TRIGGERS = /\b(latest|today'?s?|current(?:ly)?|news|releases?d?|changelog|deprecat\w*|price|cost|weather|scores?|ranking|standings?|stock|20(?:2[4-9]|3\d)|this (?:week|month|year)|right now|recent(?:ly)?)\b/i;
const HYBRID_TRIGGERS = /\b(upgrade|migrat\w*|compare|compatib\w*|integrat\w*|support\w*|bump|update\b[^.?!]*\bto\b)\b/i;
const DEBUG_HINT = /\b(debug|bug|error|exception|stack ?trace|traceback|failing|fails?|failed|broken|crash(?:es|ed)?|throws?|not working|isn'?t working|won'?t (?:work|run|build|compile)|doesn'?t (?:work|run)|null pointer|segfault)\b|\bnot (?:loading|showing|rendering|displaying|working|saving|submitting|connecting|fetching|appearing|updating|redirecting|running|opening|logging in)\b|\b(?:can'?t|cannot|couldn'?t|won'?t|didn'?t|doesn'?t)\s+(?:log ?in|load|show|work|submit|run|open|save|fetch|connect|find|access|see|get|send|redirect|register|authenticate)\b|\b(?:shows?|returns?|displays?|gives?|outputs?)\s+(?:0|zero|null|undefined|nothing|empty|wrong|incorrect|the wrong)\b|\b(?:something (?:wrong|broken|off)|is (?:wrong|broken|incorrect)|looks (?:wrong|broken)|seems (?:broken|wrong)|does nothing|do nothing|nothing happens)\b/i;
const TASK_VERB_COMPLEX = /\b(add|create|implement|build|refactor|migrate|integrate|scaffold|redesign|extract|convert|split|merge)\b/i;
const RESEARCH_INTENT = /\b(search|find|locate|look (?:up|into|for|at)|check|investigat\w*|give me (?:an? )?idea|show me|tell me about|see (?:if|how|where|whether)|trace|grep|explore|understand|figure out|analyz\w*|review|where is|where are|how does|what is|explain)\b/i;

// Common English words that aren't useful as code search terms.
const SEARCH_STOP = new Set([
  'about', 'above', 'after', 'also', 'back', 'been', 'both', 'call', 'code', 'come',
  'does', 'done', 'down', 'each', 'even', 'file', 'files', 'find', 'from', 'give',
  'goes', 'good', 'have', 'help', 'here', 'high', 'home', 'into', 'just', 'keep',
  'kind', 'know', 'last', 'like', 'list', 'long', 'look', 'made', 'make', 'many',
  'more', 'most', 'move', 'much', 'must', 'name', 'need', 'next', 'only', 'open',
  'over', 'page', 'part', 'read', 'repo', 'rest', 'same', 'seen', 'send', 'show',
  'side', 'some', 'such', 'sure', 'take', 'tell', 'than', 'that', 'them', 'then',
  'they', 'this', 'time', 'told', 'true', 'used', 'uses', 'very', 'want', 'well',
  'went', 'were', 'what', 'when', 'will', 'with', 'word', 'work', 'your', 'thus',
  'gets', 'been', 'being', 'where', 'which', 'there', 'these', 'those', 'their',
  'codebase', 'project', 'workflow', 'feature', 'function',
  // Generic domain words that appear in almost every file — poor grep signal
  'user', 'users', 'earn', 'earned', 'point', 'points', 'data', 'info', 'item',
  'items', 'list', 'result', 'results', 'value', 'values', 'type', 'types',
  // Generic path components (from URLs / file paths) — poor grep signal in Laravel/MVC projects
  'resources', 'views', 'admin', 'blade', 'public', 'assets', 'storage', 'modules',
  'controllers', 'providers', 'requests', 'models', 'routes', 'config', 'lang',
]);

/**
 * Domain-concept expansions: when a user writes a generic term, also search related
 * technical terms that are more likely to appear as identifiers in the codebase.
 * Example: "earn point" → also search "reputation", "score", "statistic"
 */
const CONCEPT_EXPANSIONS: Record<string, string[]> = {
  point: ['reputation', 'score'],
  earn: ['reputation', 'reward', 'statistic'],
  points: ['reputation', 'score'],
  login: ['authenticate', 'session'],
  signup: ['register', 'registration'],
  register: ['signup', 'registration'],
  payment: ['transaction', 'invoice', 'charge'],
  permission: ['authorize', 'policy', 'gate'],
  role: ['permission', 'authorize', 'policy'],
  cache: ['cacheKey', 'remember'],
  notify: ['notification', 'email', 'queue'],
  notification: ['notify', 'queue', 'broadcast'],
  upload: ['storage', 'disk', 'multipart'],
  search: ['index', 'filter', 'query'],
  order: ['booking', 'reservation', 'checkout'],
  cart: ['basket', 'checkout'],
  shipping: ['delivery', 'logistics'],
  delivery: ['shipping', 'dispatch'],
  report: ['statistic', 'analytics', 'export'],
  export: ['download', 'csv', 'xlsx'],
  import: ['upload', 'csv', 'parse'],
};

interface ExtractResult {
  terms: string[];
  directFiles: string[];
}

/** Extract candidate search terms and explicit file paths from the user's request. */
function extractSearchTerms(text: string): ExtractResult {
  const seen = new Set<string>();
  const terms: string[] = [];
  const directFiles: string[] = [];
  const add = (t: string): void => {
    const k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); terms.push(t); }
  };

  // 1. Quoted strings — user named it exactly.
  for (const m of text.matchAll(/"([^"]{2,40})"|'([^']{2,40})'/g)) {
    const t = (m[1] ?? m[2]).trim();
    if (t) add(t);
  }

  // 2. PascalCase identifiers: CheckoutService, OrderController.
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)) add(m[1]);

  // 3. camelCase identifiers: calculateDeliveryFee, getUserById.
  for (const m of text.matchAll(/\b([a-z][a-z]+[A-Z][a-zA-Z]+)\b/g)) add(m[1]);

  // 4. File references: src/services/payment.ts → collect as direct read + add stem as term.
  // Strip leading @ (Blade/framework path syntax like @resources/views/...) before matching.
  const textForFileRefs = text.replace(/@([\w-./]+\.[a-zA-Z]{1,5})/g, (_, p) => { directFiles.push(p); return ` ${p}`; });
  for (const m of textForFileRefs.matchAll(/(?:^|\s)([\w-./]+\.[a-zA-Z]{1,5})\b/g)) {
    const fullPath = m[1];
    // Collect bare paths (e.g. "app/Models/Order.php") as direct reads too.
    if (fullPath.includes('/') && !directFiles.includes(fullPath)) directFiles.push(fullPath);
    // Use only the meaningful part of the filename stem as a search term.
    const stem = fullPath.replace(/.*\//, '').replace(/\.[^.]+$/, '');
    // For hyphenated names (order-view), add camelCase variant (orderView) — better grep signal.
    const camel = stem.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (stem.length >= 3 && !SEARCH_STOP.has(stem.toLowerCase())) add(stem);
    if (camel !== stem && camel.length >= 3) add(camel);
  }

  // 5. Strip path/file noise from text before extracting plain content words, so "order-view.blade.php"
  // doesn't let "blade" or "views" sneak in before meaningful domain words like "driver" or "showing".
  const stripped = text
    .replace(/@?[\w-./]+\.[a-zA-Z]{1,5}/g, ' ')  // remove file paths
    .replace(/https?:\/\/\S+/g, ' ');              // remove URLs

  for (const m of stripped.matchAll(/\b([a-z]{4,})\b/gi)) {
    if (terms.length >= 4) break;
    const w = m[1].toLowerCase();
    if (!SEARCH_STOP.has(w) && !seen.has(w)) { seen.add(w); terms.push(w); }
  }

  // 6. Concept expansion — at most ONE expansion per base term to avoid polluting the search.
  //    "earn point" → "reputation" (first match only), not the whole array.
  const expanded = [...terms];
  for (const term of [...terms]) {
    if (expanded.length >= 6) break;
    const extras = CONCEPT_EXPANSIONS[term.toLowerCase()];
    if (extras) {
      const e = extras[0];
      const k = e.toLowerCase();
      if (!seen.has(k)) { seen.add(k); expanded.push(e); }
    }
  }

  return { terms: expanded.slice(0, 6), directFiles };
}

/**
 * Classify a user request into a structured routing decision from cheap signals.
 * Drives both the pre-agent research pipeline and the tool-loop information-source hint.
 */
export function classifyInformationRoute(text: string, taskKind: TaskKind): InformationRoute {
  const t = text || '';

  // ---- code search signals ----
  const hasFileRef = FILE_REF.test(t);
  const hasCodeVerb = CODE_VERB.test(t);
  const hasCodeNoun = CODE_NOUN.test(t);
  const hasRepoWord = REPO_WORD.test(t) || STRONG_REPO.test(t);
  const hasResearchIntent = RESEARCH_INTENT.test(t);
  let codeScore = 0;
  if (hasFileRef) codeScore += 0.4;
  if (hasCodeVerb && hasCodeNoun) codeScore += 0.4;
  if (hasRepoWord) codeScore += 0.5;
  if (hasResearchIntent && (hasCodeNoun || hasFileRef)) codeScore += 0.3;
  if (taskKind === 'coding' || taskKind === 'agent' || taskKind === 'debug') codeScore += 0.3;

  // ---- web search signals ----
  const hasWebTrigger = WEB_TRIGGERS.test(t);
  const hasHybrid = HYBRID_TRIGGERS.test(t);
  let webScore = 0;
  if (hasWebTrigger) webScore += 0.7;
  if (hasHybrid) { webScore += 0.4; codeScore += 0.3; }

  // ---- plan signal: multi-step action task ----
  const wordCount = t.split(/\s+/).filter(Boolean).length;
  const needsPlan = wordCount >= 12 && TASK_VERB_COMPLEX.test(t) && (hasCodeNoun || hasFileRef || hasRepoWord);

  // ---- debug signal ----
  const needsDebug = DEBUG_HINT.test(t) || taskKind === 'debug';

  // Lower threshold for agent/coding/debug tasks — isCodebaseQuestion already confirmed
  // the query is about the project, so a weaker signal (0.3 from taskKind alone) is enough
  // to warrant grep/semantic pre-research rather than going empty into the first model call.
  const codeSearchThreshold = (taskKind === 'agent' || taskKind === 'coding' || taskKind === 'debug') ? 0.3 : 0.4;
  const codeSearch = Math.min(1, codeScore) >= codeSearchThreshold;
  const webSearch = Math.min(1, webScore) >= 0.5;

  // Confidence: 1.0 when exactly one signal dominates; lower when both or neither fire.
  const dominated = (codeSearch && !webSearch) || (webSearch && !codeSearch);
  const confidence = dominated ? 0.9 : codeSearch || webSearch ? 0.5 : 0.3;

  const extracted = codeSearch ? extractSearchTerms(t) : { terms: [], directFiles: [] };

  return { codeSearch, webSearch, needsPlan, needsDebug, searchTerms: extracted.terms, directFiles: extracted.directFiles, confidence };
}
