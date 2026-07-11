

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

const START_RE = /\*{0,2}\?{2,}\s*QUESTIONS\s*\?{2,}\*{0,2}/i;
const END_RE = /\*{0,2}\?{2,}\s*END\s*\?{2,}\*{0,2}/i;
/** Scrub any leftover sentinel tokens so `???QUESTIONS???` / `???END???` never leak into
 *  displayed text. Requires the QUESTIONS/END word, so a bare `???` in a code block is safe. */
function scrubSentinels(s: string): string {
  return s.replace(/\*{0,2}\?{2,}\s*(?:QUESTIONS|END)\s*\?{2,}\*{0,2}/gi, '');
}

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
  const sm = START_RE.exec(input);
  if (!sm) return { questions: null, text: scrubSentinels(input) };

  const start = sm.index;
  const afterStart = start + sm[0].length;
  const em = END_RE.exec(input.slice(afterStart));
  const endRel = em ? em.index : -1;
  const block = endRel === -1 ? input.slice(afterStart) : input.slice(afterStart, afterStart + endRel);

  const text = (input.slice(0, start) + (endRel === -1 ? '' : input.slice(afterStart + endRel + (em ? em[0].length : 0)))).trim();

  const questions: ClarifyingQuestion[] = [];
  let current: ClarifyingQuestion | null = null;
  for (const raw of block.split('\n')) {

    const line = raw.replace(/\*\*/g, '').replace(/^#+\s*/, '').trim();
    if (!line) continue;

    const q = line.match(/^Q(?:\s*\[([^\]]+)\])?(?:\s*[:.)]?\s*(.+))?$/i);
    if (q && (q[1] || q[2])) {
      if (current) questions.push(current); // push even with 0 options (free-form question)
      const label = q[1]?.trim() || undefined;
      const text = q[2]?.trim() || label || 'Choose an option';
      current = { text, label, options: [] };
      continue;
    }

    const opt = line.match(/^(?:[-*]\s+)?(.+)$/) ;
    if (opt && current) {
      const candidate = opt[1];

      const hasBullet = /^[-*]\s/.test(line);
      const hasSeparator = candidate.includes(' :: ');
      if (!hasBullet && !hasSeparator) continue;
      const [title, ...rest] = candidate.split(/\s+::\s+/);
      const description = rest.join(' :: ').trim();
      if (title.trim()) current.options.push({ title: title.trim(), description: description || undefined });
    }
  }
  if (current) questions.push(current);

  return { questions: questions.length ? questions : null, text: scrubSentinels(text) };
}
