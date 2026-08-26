// v3 edit matcher — extracted VERBATIM from src/edits/applyEdit.ts (locateUnique /
// locateFlexible / reindentTo / applyHunk) so the v3 editFile tool has zero dependency on
// src/edits/**, which the v3 plan deletes in step 10. Pure text functions: no vscode, no gate,
// no approval. The battle-tested matching tiers are the value being kept:
//   1. exact indexOf, required UNIQUE
//   2. whitespace-tolerant line-based fallback (CRLF/indent drift), still unique-only
//   3. re-indent of the replacement to the matched text's real indentation

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
      return { error: 'Search text matches multiple locations in file — include more surrounding context to make it unique.' };
    }
    return { idx, len: search.length };
  }
  return locateFlexible(text, search);
}

/** Whitespace-tolerant, line-based fallback for when exact `indexOf` fails. Conservative:
 *  relaxes ONLY leading/trailing whitespace per line; blank pattern edge-lines are dropped; the
 *  match must still be UNIQUE. Offsets address the ORIGINAL text (never a normalised copy) so
 *  the returned index is never off by one byte per CRLF. */
function locateFlexible(text: string, search: string): { idx: number; len: number } | { error: string } {
  const notFound = { error: 'Search text not found in file.' };
  const pattern = search.split('\n').map((l) => l.trim());
  let a = 0;
  let b = pattern.length;
  while (a < b && pattern[a] === '') a++;
  while (b > a && pattern[b - 1] === '') b--;
  const pat = pattern.slice(a, b);
  if (pat.length === 0) return notFound;

  const lines = text.split('\n');
  const offsets: number[] = [];
  let acc = 0;
  for (const line of lines) { offsets.push(acc); acc += line.length + 1; }

  const found: Array<{ idx: number; len: number }> = [];
  for (let i = 0; i + pat.length <= lines.length; i++) {
    let hit = true;
    for (let j = 0; j < pat.length; j++) {
      if (lines[i + j].trim() !== pat[j]) { hit = false; break; }
    }
    if (!hit) continue;
    const last = i + pat.length - 1;
    found.push({ idx: offsets[i], len: offsets[last] + lines[last].length - offsets[i] });
    if (found.length > 1) {
      return { error: 'Search text matches multiple locations in file — include more surrounding context to make it unique.' };
    }
  }
  return found.length === 1 ? found[0] : notFound;
}

/** Apply one {search, replace} hunk to `text`, or explain why it could not be applied. */
export function applyHunk(text: string, search: string, replace: string): { text: string } | { error: string } {
  const located = locateUnique(text, search);
  if ('error' in located) return { error: located.error };
  const matched = text.slice(located.idx, located.idx + located.len);
  return { text: text.slice(0, located.idx) + reindentTo(matched, search, replace) + text.slice(located.idx + located.len) };
}
