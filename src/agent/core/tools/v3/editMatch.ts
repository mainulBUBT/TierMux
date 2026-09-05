// Search/replace matcher for editFile. Pure text, no vscode. Matching tiers:
//   1. exact indexOf, required UNIQUE
//   2. whitespace-tolerant line-based fallback (CRLF/indent drift), still unique-only
//   3. re-indent of the replacement to the matched text's real indentation
//
// Failure diagnostics are derived deterministically from the two strings in hand — no fuzzy
// scoring, no model call: WHERE the near-misses are (line numbers), WHICH line first diverged
// and what the file holds there, and WHETHER the search lines exist but not consecutively. A
// bare "not found" left the model re-issuing near-identical calls until the step cap.

/** Longest quoted file/search fragment in a diagnostic — long enough to identify a line,
 *  short enough that a failing multi-hunk edit cannot flood the transcript. */
const QUOTE_MAX = 100;
/** Near-miss locations reported per failure. Two is enough to disambiguate; more is noise. */
const MAX_CANDIDATES = 2;

function quote(line: string): string {
  const t = line.trim();
  return t.length > QUOTE_MAX ? `${t.slice(0, QUOTE_MAX)}…` : t;
}

/** Leading whitespace of a line ('' when there is none). */
function leadingWs(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

/** Re-indent `replace` by however much the real matched text was indented relative to what the
 *  model wrote as `search`. Bails out unchanged when the two indents are not a clean prefix of
 *  one another (mixed tabs/spaces) — guessing there corrupts whitespace. */
function reindentTo(matched: string, search: string, replace: string): string {
  const matchedIndent = leadingWs(matched.split('\n')[0]);
  const searchIndent = leadingWs(search.replace(/^(?:[ \t]*\r?\n)*/, '').split('\n')[0]);
  if (matchedIndent === searchIndent) return replace;
  if (matchedIndent.startsWith(searchIndent)) {
    const extra = matchedIndent.slice(searchIndent.length);
    return replace.split('\n').map((l) => (l.trim() === '' ? l : extra + l)).join('\n');
  }
  if (searchIndent.startsWith(matchedIndent)) {
    const drop = searchIndent.slice(matchedIndent.length);
    return replace.split('\n').map((l) => (l.startsWith(drop) ? l.slice(drop.length) : l)).join('\n');
  }
  return replace; // mixed tabs/spaces — don't guess
}

/** Locates `search` in `text`, requiring exactly one occurrence. A non-unique hunk would
 *  otherwise silently patch whichever occurrence `indexOf` finds first. Returns the matched
 *  LENGTH as well as the offset, because the whitespace-tolerant fallback can match a span
 *  whose length differs from `search.length`. */
function locateUnique(text: string, search: string): { idx: number; len: number } | { error: string } {
  const idx = text.indexOf(search);
  if (idx !== -1) {
    if (text.indexOf(search, idx + 1) !== -1) {
      // Collect every occurrence so the error can name the lines — see ambiguousError.
      const at: number[] = [];
      for (let k = idx; k !== -1; k = text.indexOf(search, k + 1)) at.push(lineOf(text, k));
      return { error: ambiguousError(at) };
    }
    return { idx, len: search.length };
  }
  return locateFlexible(text, search);
}

/** 1-based line number of a character offset. */
function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Whitespace-tolerant, line-based fallback for when exact `indexOf` fails. Conservative:
 *  relaxes ONLY leading/trailing whitespace per line; blank pattern edge-lines are dropped; the
 *  match must still be UNIQUE. Offsets address the ORIGINAL text (never a normalised copy) so
 *  the returned index is never off by one byte per CRLF. */
function locateFlexible(text: string, search: string): { idx: number; len: number } | { error: string } {
  const pattern = search.split('\n').map((l) => l.trim());
  let a = 0;
  let b = pattern.length;
  while (a < b && pattern[a] === '') a++;
  while (b > a && pattern[b - 1] === '') b--;
  const pat = pattern.slice(a, b);
  const lines = text.split('\n');
  if (pat.length === 0) return { error: 'Search text is empty — nothing to find.' };

  const offsets: number[] = [];
  let acc = 0;
  for (const line of lines) { offsets.push(acc); acc += line.length + 1; }

  const found: Array<{ idx: number; len: number; line: number }> = [];
  for (let i = 0; i + pat.length <= lines.length; i++) {
    let hit = true;
    for (let j = 0; j < pat.length; j++) {
      if (lines[i + j].trim() !== pat[j]) { hit = false; break; }
    }
    if (!hit) continue;
    const last = i + pat.length - 1;
    found.push({ idx: offsets[i], len: offsets[last] + lines[last].length - offsets[i], line: i + 1 });
  }
  if (found.length === 1) return found[0];
  if (found.length > 1) return { error: ambiguousError(found.map((f) => f.line)) };
  return { error: notFoundError(lines, pat) };
}

/** Non-unique match: name the LINES. "Add more context" is only actionable once the model can
 *  see which occurrences it has to tell apart. */
function ambiguousError(matchLines: number[]): string {
  const shown = matchLines.slice(0, 5).join(', ');
  const more = matchLines.length > 5 ? `, +${matchLines.length - 5} more` : '';
  return `Search text matches ${matchLines.length} locations in the file (lines ${shown}${more}). `
    + 'Include more surrounding context so exactly one matches, or use the "edits" array to change each one deliberately.';
}

/** No match: report the closest thing the file DOES contain. Three ranked cases, cheapest
 *  first, each derived from the pattern lines already computed. */
function notFoundError(lines: string[], pat: string[]): string {
  const trimmed = lines.map((l) => l.trim());
  // `"a\nb\n".split('\n')` ends in a phantom '' — real content stops before it. Without this
  // a search running one line past the end reported `file has ``` (an empty quote), which
  // reads as "the line is blank" instead of "there is no such line".
  const contentLen = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;

  // Case A — the first search line lands somewhere: the block diverges further down, which is
  // the classic "context is one line stale". Name the exact line that differs and what is
  // really there; the model can fix the hunk without re-reading the whole file.
  const starts: number[] = [];
  for (let i = 0; i < trimmed.length; i++) if (trimmed[i] === pat[0]) starts.push(i);
  if (starts.length > 0) {
    const reports = starts.slice(0, MAX_CANDIDATES).map((i) => {
      let j = 1;
      while (j < pat.length && i + j < contentLen && trimmed[i + j] === pat[j]) j++;
      if (i + j >= contentLen) {
        return `line ${i + 1}: your search runs ${pat.length - j} line(s) past the end of the file`;
      }
      return `line ${i + j + 1}: file has \`${quote(lines[i + j])}\` but your search line ${j + 1} is \`${quote(pat[j])}\``;
    });
    const more = starts.length > MAX_CANDIDATES ? ` (+${starts.length - MAX_CANDIDATES} more starting points)` : '';
    return `Search text not found. Your FIRST line matches at line ${starts.map((i) => i + 1).join(', ')}${more}, `
      + `but the block then diverges — ${reports.join('; ')}. `
      + 'Re-read that range and copy the current text exactly.';
  }

  // Case B — the lines exist, just not together: context assembled from memory, or from a read
  // taken before an earlier edit in this same turn.
  const present = pat.filter((p) => p !== '' && trimmed.includes(p));
  if (present.length > 0) {
    return `Search text not found. ${present.length} of your ${pat.length} search lines exist in the file but not as one consecutive block — `
      + `the first that does is \`${quote(present[0])}\`. Your context is probably stale; re-read the file and copy the current text exactly.`;
  }

  // Case C — nothing of the search is in the file at all: wrong file, or fully rewritten text.
  return `Search text not found — no line of it appears anywhere in the file (first line looked for: \`${quote(pat[0])}\`). `
    + 'Check the path, then read the file to see what it actually contains.';
}

/** Apply one {search, replace} hunk to `text`, or explain why it could not be applied. */
export function applyHunk(text: string, search: string, replace: string): { text: string } | { error: string } {
  const located = locateUnique(text, search);
  if ('error' in located) return { error: located.error };
  const matched = text.slice(located.idx, located.idx + located.len);
  return { text: text.slice(0, located.idx) + reindentTo(matched, search, replace) + text.slice(located.idx + located.len) };
}
