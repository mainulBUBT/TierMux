// Deterministic router — NO confidence scores, NO AI, NO weighted signals.
// Rules only: web | code | debug | chat, then extract search terms.

export type RouteIntent = 'web' | 'code' | 'debug' | 'chat';

export interface InformationRoute {
  intent: RouteIntent;
  /** Needs workspace tool calls (grep/glob/readFile). */
  codeSearch: boolean;
  /** Needs external/current information (webSearch/webFetch). */
  webSearch: boolean;
  /** Key terms extracted from the request — seed grep/symbolIndex. */
  searchTerms: string[];
  /** Explicitly mentioned file paths — read directly. */
  directFiles: string[];
  /** Always 1 — confidence concept removed. */
  confidence: 1;
  needsPlan: false;
  needsDebug: boolean;
}

// ---- Route rules (order matters — first match wins) ----
const WEB = /\b(today|latest|news|price|weather|score|ranking|standings?|stock|released?|changelog|right now|this week|this month|this year|current version|20(?:2[4-9]|3\d))\b/i;
const DEBUG = /\b(bug|error|exception|stacktrace|stack trace|traceback|failing|fails?|failed|broken|crash|throws?|not working|null pointer|segfault)\b|\bnot (?:loading|showing|rendering|working|saving|connecting|fetching)\b|\b(?:can'?t|cannot|won'?t|doesn'?t)\s+(?:load|show|work|run|save|fetch|connect|find)\b|\b(?:shows?|returns?)\s+(?:null|undefined|nothing|wrong|0)\b/i;
const CODE = /(?:^|\s)(\.\/)?[\w-./]+\.[a-zA-Z]{1,5}\b|```|\b(function|method|class|component|hook|endpoint|api|route|handler|service|model|controller|repository|middleware)\b|\b(refactor|implement|fix|debug|add|create|update|delete|rename|move|write|generate)\b/i;

export function route(query: string): RouteIntent {
  const t = query || '';
  if (WEB.test(t)) return 'web';
  if (DEBUG.test(t)) return 'debug';
  if (CODE.test(t)) return 'code';
  return 'chat';
}

// Common stop words — poor grep signal.
const STOP = new Set([
  'about','after','also','back','been','both','call','code','come','does','done','down',
  'each','even','file','files','find','from','give','goes','good','have','help','here',
  'into','just','keep','know','last','like','list','look','made','make','many','more',
  'most','move','much','must','name','need','next','only','open','over','page','part',
  'read','repo','rest','same','send','show','side','some','sure','take','tell','than',
  'that','them','then','they','this','time','true','used','uses','very','want','well',
  'went','were','what','when','will','with','word','work','your','gets','where','which',
  'there','these','those','their','codebase','project','function','user','users','data',
  'info','item','items','list','result','results','value','values','type','types',
]);

function extractTerms(text: string): { terms: string[]; directFiles: string[] } {
  const seen = new Set<string>();
  const terms: string[] = [];
  const directFiles: string[] = [];
  const add = (t: string): void => { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); terms.push(t); } };

  // Quoted strings — user named it exactly.
  for (const m of text.matchAll(/"([^"]{2,40})"|'([^']{2,40})'/g)) {
    const t = (m[1] ?? m[2]).trim(); if (t) add(t);
  }
  // PascalCase: CheckoutService, OrderController.
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)) add(m[1]);
  // camelCase: calculateDeliveryFee, getUserById.
  for (const m of text.matchAll(/\b([a-z][a-z]+[A-Z][a-zA-Z]+)\b/g)) add(m[1]);
  // File paths → direct read + stem as term.
  const textForFiles = text.replace(/@([\w-./]+\.[a-zA-Z]{1,5})/g, (_, p) => { directFiles.push(p); return ` ${p}`; });
  for (const m of textForFiles.matchAll(/(?:^|\s)([\w-./]+\.[a-zA-Z]{1,5})\b/g)) {
    const fp = m[1];
    if (fp.includes('/') && !directFiles.includes(fp)) directFiles.push(fp);
    const stem = fp.replace(/.*\//, '').replace(/\.[^.]+$/, '');
    if (stem.length >= 3 && !STOP.has(stem.toLowerCase())) add(stem);
  }
  // Plain words (4+ chars, not stop words).
  const stripped = text.replace(/@?[\w-./]+\.[a-zA-Z]{1,5}/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  for (const m of stripped.matchAll(/\b([a-z]{4,})\b/gi)) {
    if (terms.length >= 5) break;
    const w = m[1].toLowerCase();
    if (!STOP.has(w) && !seen.has(w)) { seen.add(w); terms.push(w); }
  }
  return { terms: terms.slice(0, 6), directFiles };
}

/** Classify a user request into a structured routing decision. Pure rules, no LLM. */
export function classifyInformationRoute(text: string): InformationRoute {
  const intent = route(text);
  const codeSearch = intent === 'code' || intent === 'debug';
  const webSearch = intent === 'web';
  const { terms, directFiles } = codeSearch ? extractTerms(text) : { terms: [], directFiles: [] };
  return {
    intent,
    codeSearch,
    webSearch,
    searchTerms: terms,
    directFiles,
    confidence: 1,
    needsPlan: false,
    needsDebug: intent === 'debug',
  };
}
