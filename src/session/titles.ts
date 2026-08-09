import type { TodoItem } from '../shared/types';
import { splitReasoning } from '../agent/content';

/**
 * Reduce a model's reply to a clean short title, or '' if it doesn't look like one.
 * Reasoning models often leak chain-of-thought (sometimes truncated mid-thought with
 * no <think> tags) — reject anything that reads like an explanation rather than a title.
 */
export function sanitizeTitle(raw: string): string {
  let s = (splitReasoning(raw || '').content || '')
    .split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  s = s.replace(/^["'`]+|["'`.]+$/g, '').trim();
  if (!s) return '';
  const words = s.split(/\s+/).filter(Boolean);

  const cot = /\b(the user|user'?s message|this is|let me|we need|i'?ll|i will|i should|first,?|okay,?|because|according|greeting|not a|the message|so the title|title for)\b/i;
  if (words.length > 8 || s.length > 64 || cot.test(s)) return '';
  return s;
}

const CODE_LINE = /^\s*(?:```|curl\b|git\b|npm\b|yarn\b|pnpm\b|docker\b|kubectl\b|ssh\b|python[23]?\b|node\b|go\b|cargo\b|make\b|sudo\b|\$\s|#\s|--\S|https?:\/\/|[{[])/i;

/** First line of prose in a message — skips code fences, shell commands, URLs and JSON
 *  so a pasted curl/log/snippet doesn't become the title basis. Falls back to the raw
 *  text if every line looks code-like (nothing prose to pick from). */
function firstProseLine(text: string): string {
  const lines = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const prose = lines.find((l) => !CODE_LINE.test(l) && l.split(/\s+/).length >= 2);
  return prose ?? lines[0] ?? '';
}

/** A plain readable title from a message when the LLM title is unusable (first ~6 words
 *  of the first prose line, so a pasted command/log doesn't swamp the placeholder). */
export function deriveTitleFrom(text: string): string {
  const line = firstProseLine(text);
  const s = line.trim().replace(/\s+/g, ' ').replace(/[?.!,;:]+$/, '');
  if (!s) return 'New chat';
  const words = s.split(' ').slice(0, 6).join(' ').slice(0, 60);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const PLAN_EDIT_VERB = /^(add|create|implement|build|writ|fix|refactor|rename|move|delete|remove|updat|chang|modif|edit|replac|wir|integrat|convert|migrat|install|configur|extract|split|merg|append|insert|expos|export|hook|connect|introduc|switch|drop|bump|upgrad|enabl|disabl|set ?up|scaffold|register|inject|guard|validat|sync|audit|document|correct|review|ensur|verify|test|apply|enforce|generat|wir)\w*\b/i;
const PLAN_PATHISH = /[\w./-]+\.[a-z]{1,6}\b|\b[\w-]+\/[\w-]+/;

/** Turn an approved plan's text into an initial all-pending todo list. Accepts four step
 *  shapes so the plan card opens regardless of which model produced it: bulleted/numbered
 *  list items (`-`/`*`/`1.`), markdown headings (`## …`), bold-only heading lines
 *  (`**…**`), and — the case free models hit most — bare imperative PARAGRAPH lines that
 *  name a file ("Create resources/views/landing.blade.php …", "Update routes/web.php:").
 *  Without that fourth shape a plan written as paragraphs (no list markers) parsed to zero
 *  steps and the plan card never opened. */
export function planStepsToTodos(steps: string): TodoItem[] {
  return (steps || '')
    .split('\n')
    .map((line) => {
      // Numbered or bulleted list item.
      let m = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
      if (m) return m[1];
      // Markdown heading: "## Step", "### Step".
      m = line.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/);
      if (m) return m[1];
      // Bold-only heading line: "**Step**".
      m = line.match(/^\s*\*\*(.+?)\*\*\s*$/);
      if (m) return m[1];
      // Imperative paragraph line with no list marker but a clear edit verb AND a file/path
      // reference — the "Create/Add/Update <file>" plan format weak models emit as prose.
      const trimmed = line.trim();
      if (trimmed && PLAN_EDIT_VERB.test(trimmed) && PLAN_PATHISH.test(trimmed)) return trimmed;
      return null;
    })
    .filter((c): c is string => c !== null)
    .map((c) => ({ content: c.replace(/\*\*/g, '').trim(), status: 'pending' as const }))
    .filter((t) => t.content.length > 0)
    .slice(0, 20);
}

/**
 * True when plan text reads like ACTIONABLE changes (imperative steps and/or file references)
 * rather than a descriptive answer. Gates the "Approve & Run" UI: a reply to "give me 6 changes"
 * or "how does this work?" is a discussion answer (no run button), not a plan to execute.
 *
 * Counts concrete actionable steps: bulleted/heading steps that look like edits, PLUS imperative
 * paragraph lines naming a file (the no-list-marker plan format). Returns true at ≥2 such steps —
 * a real plan touches more than one thing, while a prose Q&A answer rarely leads with edit verbs
 * aimed at files.
 */
export function looksLikeActionablePlan(text: string): boolean {
  const t = text || '';
  const actionables = new Set<string>();
  for (const step of planStepsToTodos(t).map((s) => s.content)) {
    if (PLAN_EDIT_VERB.test(step) || PLAN_PATHISH.test(step)) actionables.add(step);
  }
  // Also scan raw lines for imperative+path paragraphs (covers the case where planStepsToTodos'
  // 20-item cap or formatting kept them out, and keeps this independent of the todo builder).
  for (const line of t.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && PLAN_EDIT_VERB.test(trimmed) && PLAN_PATHISH.test(trimmed)) actionables.add(trimmed);
  }
  return actionables.size >= 2;
}

const SUBJECT_STOPWORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'how', 'can', 'could', 'would', 'should', 'will', 'shall', 'do', 'does', 'did', 'done',
  'we', 'you', 'i', 'it', 'they', 'he', 'she', 'them', 'us', 'my', 'your', 'our', 'their',
  'to', 'of', 'for', 'in', 'on', 'at', 'with', 'by', 'from', 'into', 'onto', 'about', 'as', 'and', 'or', 'but', 'not',
  'more', 'most', 'some', 'any', 'all', 'no', 'none', 'etc', 'stuff', 'things', 'thing',
  'upgrade', 'upgraded', 'upgrading', 'optimize', 'optimized', 'optimizing', 'optimise', 'optimising',
  'improve', 'improved', 'improving', 'fix', 'fixed', 'fixing', 'add', 'added', 'adding', 'update', 'updated', 'updating',
  'change', 'changed', 'changing', 'make', 'made', 'making', 'build', 'built', 'building', 'create', 'created', 'creating',
  'help', 'please', 'need', 'want', 'give', 'tell', 'explain', 'show', 'let', 'get', 'got',
  'project', 'codebase', 'code', 'app', 'application', 'system', 'repo', 'repository', 'file', 'files',
  'what', 'why', 'when', 'where', 'which', 'who', 'whom',
  'good', 'better', 'best', 'well', 'also', 'just', 'really', 'very', 'so', 'then', 'now', 'more', 'multiple',
  // Romanized Bengali ("Banglish") filler — question words, verbs and particles. Without these
  // the list is English-only, and "router ta kivabe kaj kore?" yields the subject terms
  // ["router", "kivabe", "kore"]. Not cosmetic: looksLikeGroundedAnswer then requires the reply
  // to contain "kivabe", and offTopicCorrection tells the model to "grep the codebase for:
  // router, kivabe, kore" — sending it to search for a Bengali grammar word. Only filler is
  // listed; real nouns a user might name stay eligible as subjects.
  'kivabe', 'kemne', 'kemon', 'keno', 'kothay', 'kobe', 'kono',
  'kichu', 'kore', 'korche', 'korte', 'kora', 'korbo', 'korbe', 'koro', 'korlam', 'korchi',
  'korechi', 'korecho', 'kortese', 'kaj', 'hoy', 'hoye', 'hocche', 'holo', 'hobe', 'ache',
  'achhe', 'ase', 'chilo', 'bolchi', 'bolchilam', 'bolche', 'bole', 'bolo', 'dao', 'dile',
  'diye', 'theke', 'jonno', 'kotha', 'ekta', 'ekhon', 'ekhane', 'oita', 'oigula', 'egula',
  'eta', 'eita', 'sathe', 'moto', 'valo', 'bhalo', 'kharap', 'amar', 'amader', 'tomar',
  'tumi', 'ami', 'apni', 'aro', 'aar', 'abar', 'onek', 'khub', 'jodi', 'tahole',
  'kintu', 'jonno', 'nai', 'nei', 'hoyeche', 'lagbe', 'lage', 'jane', 'jani', 'bujhe',
  'bujhte', 'bujhi', 'dekho', 'dekhi', 'dekha', 'pare', 'parbe', 'parina', 'thik', 'seta',
  'sob',
]);

/**
 * Extract the meaningful "subject" words from a user message — what it's actually ABOUT,
 * stripped of request-shaped filler ("how can we", "and etc", "upgrade", "optimize"). Used
 * to check whether a reply actually engaged with what was asked instead of drifting into an
 * unrelated generic answer (e.g. a whole-project overview when a specific feature was named).
 */
export function extractSubjectTerms(message: string): string[] {
  const raw = message || '';
  // Acronyms/identifiers (2-6 consecutive capitals — "API", "DB", "UI", "PDF") are always a
  // meaningful subject regardless of length; the >=4 filter below would otherwise drop them
  // and silently defeat the relevance check for exactly this class of short-named question
  // ("how can we improve the API?" would yield zero subject terms without this).
  const acronyms = (raw.match(/\b[A-Z]{2,6}\b/g) || []).map((w) => w.toLowerCase());
  const words = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const terms = words.filter((w) => w.length >= 4 && !SUBJECT_STOPWORDS.has(w));
  return Array.from(new Set([...acronyms, ...terms]));
}

/**
 * True if `text` engages with at least one subject term (loose substring match, so
 * "prize"/"prizes" or "role"/"roles" count). Empty `terms` — a genuinely subject-less
 * message like "give an overview" — always passes; there's nothing to have missed.
 */
export function mentionsSubject(text: string, terms: string[]): boolean {
  if (!terms.length) return true;
  const lower = (text || '').toLowerCase();
  return terms.some((t) => lower.includes(t));
}

// Markers of a WHOLE-PROJECT overview response: broad stack/tooling enumeration and
// overview-shaped section headers. A genuine answer to a specific question ("optimize the
// role system") would never enumerate the entire tech stack — it stays on its subject. A
// weak model that ignores the question and dumps a project summary hits many of these at once.
const OVERVIEW_MARKERS = [
  'tech stack', 'architecture', 'key features', 'core features', 'project overview', 'what is this',
  'request flow', 'business logic lives', 'primary keys', 'front door', 'both front',
  'laravel', 'sanctum', 'eloquent', 'composer.json', 'tailwind', 'vite', 'bootstrap', 'socialite',
  'sqlite', 'mysql', 'php 8', 'spatie', 'maatwebsite', 'blade',
];
// Subject terms that ARE overview-ish — if the user genuinely asked about the architecture/
// stack/structure, an overview-shaped answer is correct and must not be flagged.
const OVERVIEWISH_TERMS = new Set(['architecture', 'stack', 'structure', 'overview', 'layout', 'setup']);

/** True when `text` reads like a broad whole-project overview (>=5 distinct overview markers) —
 *  a tech-stack enumeration + overview section headers, regardless of what was asked. */
export function looksLikeGenericOverview(text: string): boolean {
  const lower = (text || '').toLowerCase();
  let hits = 0;
  for (const m of OVERVIEW_MARKERS) if (lower.includes(m)) hits++;
  return hits >= 5;
}

/**
 * True if `text` looks like a genuinely investigated answer to a SPECIFIC named subject, rather
 * than a generic whole-project overview that merely name-drops the subject once. The strong
 * tell is not "did it cite a file" (a generic overview cites project-structure files too) but
 * "does it read like a project overview" — enumerating the whole stack while a specific subject
 * was named. Empty `terms` (a genuinely subject-less question like "give an overview") always
 * passes; so does the case where the subject itself is overview-ish (architecture/stack/…).
 */
export function looksLikeGroundedAnswer(text: string, terms: string[]): boolean {
  if (!terms.length) return true;
  if (!mentionsSubject(text, terms)) return false;
  if (terms.some((t) => OVERVIEWISH_TERMS.has(t))) return true; // an overview WAS what was asked
  return !looksLikeGenericOverview(text);
}

/** The corrective instruction pushed for the one bounded relevance-check retry (see
 *  handleSend/handleAnswerClarifying in chatViewProvider.ts) — kept in one place so the two
 *  call sites can't drift apart. */
export function offTopicCorrection(subjectTerms: string[]): string {
  return `Your last reply was a generic whole-project overview — it did NOT actually answer about "${subjectTerms.slice(0, 5).join(', ')}". Do not summarize the project or its tech stack again. Instead: grep the codebase for those terms, read the specific files that implement them, and answer ONLY about "${subjectTerms.slice(0, 5).join(', ')}", citing the real files/lines you find.`;
}
