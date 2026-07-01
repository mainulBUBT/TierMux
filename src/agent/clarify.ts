// Parsing for Plan mode's optional clarifying-questions block.
//
// The planner may emit a delimited block before producing a plan when the request is
// ambiguous. We surface it as interactive multiple-choice questions in the webview,
// then re-run Plan mode with the answers (see chatViewProvider). The format is kept
// simple and the parser lenient so weaker models that ignore it just produce a normal
// plan with no regression.

/** One selectable answer: a short title plus an optional one-line description. */
interface ClarifyOption {
  title: string;
  description?: string;
}

export interface ClarifyingQuestion {
  text: string;
  /** Short 1–3 word tab label (e.g. "Interview Type"); falls back to the question number. */
  label?: string;
  options: ClarifyOption[];
}

interface ParsedClarifying {
  /** Non-null only when at least one well-formed question (>=2 options) was found. */
  questions: ClarifyingQuestion[] | null;
  /** The original text with any questions block removed, so sentinels never leak. */
  text: string;
}

const START = '???QUESTIONS???';
const END = '???END???';

/**
 * Extract an optional clarifying-questions block from Plan mode output.
 *
 * Block shape:
 *   ???QUESTIONS???
 *   Q: <question>
 *   - option a
 *   - option b
 *   Q: <another question>
 *   - option a
 *   - option b
 *   ???END???
 *
 * Lenient: a missing or malformed block yields `questions: null` and the text with any
 * partial block stripped, so the normal plan still renders cleanly.
 */
export function parseClarifying(input: string): ParsedClarifying {
  const start = input.indexOf(START);
  if (start === -1) return { questions: null, text: input };

  const end = input.indexOf(END, start + START.length);
  const block = input.slice(start + START.length, end === -1 ? input.length : end);
  // Strip the block (and its sentinels) from the text we'd show as a plan.
  const text = (input.slice(0, start) + (end === -1 ? '' : input.slice(end + END.length))).trim();

  const questions: ClarifyingQuestion[] = [];
  let current: ClarifyingQuestion | null = null;
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // `Q[Short Label]: question` — label and question text are both optional independently.
    // Lenient: `Q[Label]` alone (no text), `Q: question` (no label), or `Q[Label]: question`.
    const q = line.match(/^Q(?:\s*\[([^\]]+)\])?(?:\s*[:.)]?\s*(.+))?$/i);
    if (q && (q[1] || q[2])) {
      if (current) questions.push(current); // push even with 0 options (free-form question)
      const label = q[1]?.trim() || undefined;
      const text = q[2]?.trim() || label || 'Choose an option';
      current = { text, label, options: [] };
      continue;
    }
    // `- Title :: one-line description` — the ` :: ` and description are optional.
    // Lenient: also accept lines without a leading `-`/`*` when they contain ` :: `.
    const opt = line.match(/^(?:[-*]\s+)?(.+)$/) ;
    if (opt && current) {
      const candidate = opt[1];
      // Must be an option line: either starts with `-`/`*`, or contains ` :: ` (bare option style).
      const hasBullet = /^[-*]\s/.test(line);
      const hasSeparator = candidate.includes(' :: ');
      if (!hasBullet && !hasSeparator) continue;
      const [title, ...rest] = candidate.split(/\s+::\s+/);
      const description = rest.join(' :: ').trim();
      if (title.trim()) current.options.push({ title: title.trim(), description: description || undefined });
    }
  }
  if (current) questions.push(current);

  return { questions: questions.length ? questions : null, text };
}
