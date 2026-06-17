// Parsing for Plan mode's optional clarifying-questions block.
//
// The planner may emit a delimited block before producing a plan when the request is
// ambiguous. We surface it as interactive multiple-choice questions in the webview,
// then re-run Plan mode with the answers (see chatViewProvider). The format is kept
// simple and the parser lenient so weaker models that ignore it just produce a normal
// plan with no regression.

export interface ClarifyingQuestion {
  text: string;
  options: string[];
}

export interface ParsedClarifying {
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
    const q = line.match(/^Q[:.)]?\s+(.+)$/i);
    if (q) {
      if (current && current.options.length >= 2) questions.push(current); // drop 1-option duds
      current = { text: q[1].trim(), options: [] };
      continue;
    }
    const opt = line.match(/^[-*]\s+(.+)$/);
    if (opt && current) current.options.push(opt[1].trim());
  }
  if (current && current.options.length >= 2) questions.push(current);

  return { questions: questions.length ? questions : null, text };
}
