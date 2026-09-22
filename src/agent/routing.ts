import type { ChatContent } from '../shared/types';
import { normalizeAttachmentBlocks } from './content';

/** The routing buckets (2026-09-22: eight kinds collapsed to four). Five of the old kinds
 *  (chat/agent/coding/debug/plan) shared the SAME chain head — groq gpt-oss-120b led every
 *  table — so the regex tower that separated them chose between branches that routed
 *  identically: a misfire could only misroute, never route better. Only three distinctions
 *  actually change the serving model — speed (trivial), context size (longContext) and
 *  attachment capability (vision) — and those three are cheap to detect from shape, not
 *  vocabulary. Everything else is work: one table, one 'strong' head floor, one
 *  rotation/vote bucket. */
export type TaskKind = 'trivial' | 'work' | 'longContext' | 'vision';

// Greetings beyond English — a "hola" that fell through this list once led the work table,
// where a reasoning model spent ~25s thinking about it (live 2026-09-15). Banglish ones
// included: the maintainer's own chat opens with them.
const GREETING = /^(hi+|hey+|hello+|yo|sup|howdy|gm|gn|good (morning|afternoon|evening|night)|thanks?|thank you|thx|ty|ok(ay)?|k|cool|nice|great|awesome|bye|goodbye|cheers|np|no problem|got it|sounds good|hola|ol[áa]|qu[eé] tal|buen(os)?\s+(d[ií]as|tardes|noches)|ciao|bonjour|salut|hallo|namaste|as\s?salamu?\s?(al)?aikum|sala?am|marhaba|merhaba|kemon acho|ki khobor|ki obosta|bhalo achi)(?![a-z0-9_])[\s!.?]*$/i;

/** A greeting naming an action ("fix this", "file ta update koro") is work, not small talk —
 *  this is the only job a task verb has left. */
const TASK_VERB = /\b(add|create|implement|build|write|fix|refactor|rename|move|delete|remove|update|change|modif(?:y|ies)|edit|generate|migrate|install|set ?up|wire|integrate|replace|convert|optimi[sz]e|run|test|make|put|turn|set|swap|drop|append|insert|extract|split|merge|comment|uncomment|format|bump|upgrade|downgrade|configure|enable|disable|support|handle|apply|hook|connect|expose|document|export|validate|cache|scaffold)\b/i;

/** Romanized Bengali ("Banglish") task verbs — same guard for the maintainer's own phrasing
 *  ("thik koro", "update korba"). Word-bounded stems so they can't fire inside English words. */
const BN_TASK_VERB = /\b(kor(?:o|un|be|chi|te|ben|te ?hobe)?|kore ?(?:dao|den|dio)|banao|banan|banate|likh(?:o|un|te)?|lekho|thik ?kor\w*|ঠিক|muche ?(?:dao|felo)|poriborton|bodla(?:o|te)|joga(?:o|te)|add ?kor\w*|fix ?kor\w*|update ?kor\w*|delete ?kor\w*)\b/i;

/** Signals passed from the webview to classifyTask — attachment kinds drive vision routing. */
export interface ClassifySignals {
  attachments?: number;
  mentions?: number;
  /** Per-attachment kind, in send order. `image`/`pdf` force a vision route. */
  attachmentKinds?: Array<'file' | 'image' | 'pdf' | 'doc'>;
  /** True when the user forced Auto mode (lets the router pick vision naturally). */
  auto?: boolean;
}

/** `ClassifySignals.attachmentKinds` from a message's content, by MIME rather than block
 *  type. Only PDFs need vision as a last resort (a scanned page with no text layer). */
export function attachmentKindsFromContent(content: ChatContent): NonNullable<ClassifySignals['attachmentKinds']> {
  return normalizeAttachmentBlocks(content).map((a): 'image' | 'pdf' | 'doc' => {
    if (a.mime.startsWith('image/')) return 'image';
    if (a.mime === 'application/pdf') return 'pdf';
    return 'doc';
  });
}

/** Classify the latest user message: image/PDF → vision, big input → longContext, a bare
 *  greeting → trivial, everything else → work. Deliberately no code-vs-chat-vs-debug
 *  branching — see the TaskKind note above. */
export function classifyTaskCore(text: string, signals?: ClassifySignals): TaskKind {
  const t = (text || '').trim();
  if (!t) return 'work';
  const kinds = signals?.attachmentKinds ?? [];
  // The capability gate beats everything: an image turn needs a vision-capable model whatever
  // its length or phrasing.
  if (kinds.some((k) => k === 'image' || k === 'pdf')) return 'vision';
  // Big input, doc attachments and heavy @mentions all mean "the context is the payload" —
  // window room is the binding constraint before any other consideration.
  if (t.length > 6000 || (signals?.attachments ?? 0) > 0 || (signals?.mentions ?? 0) >= 3) return 'longContext';
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 6 && GREETING.test(t) && !TASK_VERB.test(t) && !BN_TASK_VERB.test(t)) return 'trivial';
  return 'work';
}

/** Regex-only classification — synchronous, zero extra latency, no model call. */
export function classifyTask(text: string, signals?: ClassifySignals): TaskKind {
  return classifyTaskCore(text, signals);
}

/** Latest turn's kind; a bare acknowledgment ("thanks", "and now?") keeps the thread's
 *  substantive kind instead of dropping a work conversation onto the fast table mid-thread. */
export function classifyConversation(userTexts: string[], signals?: ClassifySignals): TaskKind {
  const own = classifyTaskCore(userTexts[userTexts.length - 1] ?? '', signals);
  if (own !== 'trivial') return own;
  for (let i = userTexts.length - 2; i >= 0; i--) {
    const prev = classifyTaskCore(userTexts[i]);
    if (prev !== 'trivial') return prev;
  }
  return 'trivial';
}
