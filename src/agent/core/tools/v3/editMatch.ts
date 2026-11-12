// Search/replace matcher for editFile. Pure text. Tiers: exact indexOf (unique) → whitespace-
// tolerant line match (CRLF/indent drift, still unique) → the same with typographic punctuation
// folded to ASCII → re-indent the replacement to the matched text, in the file's line ending. Failure diagnostics are derived from the two strings — WHERE the near-misses
// are, WHICH line first diverged, WHETHER the lines exist non-consecutively — because a bare
// "not found" left the model re-issuing near-identical calls until the step cap.

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

/** Typographic punctuation and non-ASCII spaces folded to their ASCII look-alikes. */
function foldPunct(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/\u2026/g, '...');
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

  const scan = (key: (l: string) => string): Array<{ idx: number; len: number; line: number }> => {
    const want = pat.map(key);
    const hits: Array<{ idx: number; len: number; line: number }> = [];
    for (let i = 0; i + pat.length <= lines.length; i++) {
      let hit = true;
      for (let j = 0; j < pat.length; j++) {
        if (key(lines[i + j]) !== want[j]) { hit = false; break; }
      }
      if (!hit) continue;
      const last = i + pat.length - 1;
      // A CRLF line's '\r' is not part of the match: the replacement must not swallow it.
      const lastLen = lines[last].endsWith('\r') ? lines[last].length - 1 : lines[last].length;
      hits.push({ idx: offsets[i], len: offsets[last] + lastLen - offsets[i], line: i + 1 });
    }
    return hits;
  };
  let found = scan((l) => l.trim());
  // Smart quotes, dashes and odd spaces: a model retyping `it’s — done` writes `it's - done`
  // (or the reverse). Matching only — the file keeps its own characters outside the replaced span.
  if (found.length === 0) found = scan((l) => foldPunct(l.trim()));
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
    + 'Include more surrounding context so exactly one matches, use the "edits" array to change each one deliberately, '
    + 'or set "replaceAll": true to change every occurrence.';
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

  // Cases B and C: show the block that comes closest, so the model can copy the real text
  // instead of spending a readFile round trip (aider's find_similar_lines, line-level).
  const closest = closestBlock(lines, trimmed, contentLen, pat);
  const shown = closest ? `\nClosest block in the file (lines ${closest.from}–${closest.to}):\n${closest.text}\nCopy from it exactly.` : '';

  // Case B — the lines exist, just not together: context assembled from memory, or from a read
  // taken before an earlier edit in this same turn.
  const present = pat.filter((p) => p !== '' && trimmed.includes(p));
  if (present.length > 0) {
    return `Search text not found. ${present.length} of your ${pat.length} search lines exist in the file but not as one consecutive block — `
      + `the first that does is \`${quote(present[0])}\`. Your context is probably stale.`
      + (shown || ' Re-read the file and copy the current text exactly.');
  }

  // Case C — nothing of the search is in the file at all: wrong file, or fully rewritten text.
  return `Search text not found — no line of it appears anywhere in the file (first line looked for: \`${quote(pat[0])}\`).`
    + (shown || ' Check the path, then read the file to see what it actually contains.');
}

/** Character-bigram multiset of a line (Dice similarity input). */
function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function dice(a: Map<string, number>, b: Map<string, number>, sa: string, sb: string): number {
  if (sa === sb) return 1;
  if (sa.length < 2 || sb.length < 2) return 0;
  let common = 0;
  for (const [g, n] of a) common += Math.min(n, b.get(g) ?? 0);
  return (2 * common) / (sa.length - 1 + sb.length - 1);
}

/** Work cap for the similarity scan (file lines × search lines). Past it the hint is skipped —
 *  a failed edit must stay cheap. */
const CLOSEST_MAX_WORK = 200_000;
const CLOSEST_MIN_SCORE = 0.6;
const CLOSEST_MAX_LINES = 15;

/** The window of the file most similar to the search block, rendered with line numbers. */
function closestBlock(lines: string[], trimmed: string[], contentLen: number, pat: string[]):
  { from: number; to: number; text: string } | undefined {
  const n = pat.length;
  if (n === 0 || contentLen === 0 || contentLen * n > CLOSEST_MAX_WORK) return undefined;
  const patGrams = pat.map(bigrams);
  const fileGrams: Array<Map<string, number> | undefined> = [];
  const gramsAt = (i: number) => (fileGrams[i] ??= bigrams(trimmed[i]));
  let best = -1;
  let bestAt = 0;
  for (let i = 0; i + Math.min(n, contentLen) <= contentLen; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      if (i + j >= contentLen) break;
      sum += dice(gramsAt(i + j), patGrams[j], trimmed[i + j], pat[j]);
    }
    if (sum > best) { best = sum; bestAt = i; }
  }
  if (best / n < CLOSEST_MIN_SCORE) return undefined;
  const from = bestAt;
  const to = Math.min(contentLen, bestAt + n, bestAt + CLOSEST_MAX_LINES);
  const width = String(to).length;
  const text = lines.slice(from, to)
    .map((l, k) => `${String(from + k + 1).padStart(width)}\t${l.replace(/\r$/, '').slice(0, 200)}`)
    .join('\n');
  return { from: from + 1, to, text };
}

/** readFile's `cat -n` prefix (`  12\t`). Weak models paste it into `search` despite the tool
 *  description; stripped only when EVERY non-blank line carries it, so real tab-indented
 *  numbers are never touched. */
const LINE_NO_PREFIX = /^ *\d+\t/;
function stripLineNumbers(s: string): string | undefined {
  const ls = s.split('\n');
  const content = ls.filter((l) => l.trim() !== '');
  if (content.length === 0 || !content.every((l) => LINE_NO_PREFIX.test(l))) return undefined;
  return ls.map((l) => l.replace(LINE_NO_PREFIX, '')).join('\n');
}

/** A file whose every line break is CRLF — inserted text follows it. Mixed files are left alone. */
function isCrlfFile(text: string): boolean {
  return text.includes('\r\n') && !/(^|[^\r])\n/.test(text);
}

function withEol(replace: string, crlf: boolean): string {
  return crlf ? replace.replace(/\r?\n/g, '\r\n') : replace;
}

/** Apply one {search, replace} hunk to `text`, or explain why it could not be applied.
 *  `replaceAll` changes every EXACT occurrence (a rename); with none it falls back to the
 *  single-match tiers. */
export function applyHunk(text: string, search: string, replace: string, replaceAll = false): { text: string } | { error: string } {
  const crlf = isCrlfFile(text);
  if (replaceAll && search) {
    const parts = text.split(search);
    if (parts.length > 1) return { text: parts.join(withEol(replace, crlf)) };
  }
  let located = locateUnique(text, search);
  if ('error' in located) {
    const bare = stripLineNumbers(search);
    if (bare !== undefined) {
      const retry = locateUnique(text, bare);
      if (!('error' in retry)) {
        located = retry;
        search = bare;
        replace = stripLineNumbers(replace) ?? replace;
      }
    }
  }
  if ('error' in located) {
    // Already applied: after a failover or a Continue, the next model re-sends an edit that
    // landed. "Not found, re-read" cost a read and a retry of an edit that must not happen.
    if (replace.trim().length >= 8 && replace.trim() !== search.trim()) {
      const there = locateUnique(text, replace);
      if (!('error' in there)) {
        return { error: `Search text not found, but your replacement text is already in the file at line ${lineOf(text, there.idx)} — this change looks already applied. Do not re-send it.` };
      }
    }
    return { error: located.error };
  }
  const matched = text.slice(located.idx, located.idx + located.len);
  return { text: text.slice(0, located.idx) + withEol(reindentTo(matched, search, replace), crlf) + text.slice(located.idx + located.len) };
}

/** The changed region between two versions of a file, numbered like readFile, with `context`
 *  lines around it — returned with a successful edit so the model has the current text (and
 *  fresh line numbers) for its next hunk without re-reading. Empty when nothing changed or the
 *  region is too big to be worth echoing. */
export function changedRegion(before: string, after: string, context = 2, maxLines = 30): string {
  if (before === after) return '';
  const a = before.split('\n');
  const b = after.split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const from = Math.max(0, p - context);
  const to = Math.min(b.length, b.length - q + context);
  if (to - from > maxLines) return `Lines ${p + 1}–${b.length - q} changed (too many to echo; readFile that range if you need it).`;
  const width = String(to).length;
  const body = b.slice(from, to).map((l, k) => `${String(from + k + 1).padStart(width)}\t${l.replace(/\r$/, '')}`).join('\n');
  return `Current text (lines ${from + 1}–${to}):\n${body}`;
}
