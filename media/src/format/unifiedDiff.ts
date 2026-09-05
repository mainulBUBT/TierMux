/**
 * unifiedDiff — a pure line diff producing unified-format output for ToolCard's edit previews.
 * DOM-free and vscode-free. Common prefix/suffix trim, then an LCS table over the middle; moved
 * blocks fall out as delete+add hunks, as in git. Inputs are CRLF/CR-normalized first.
 */

/** Above this many DP cells (rows×cols of the middle sections) the LCS is skipped and the
 *  whole middle is emitted as one delete+add hunk — deterministic, correct, just not minimal.
 *  Keeps pathological inputs (two 20k-line files with nothing in common) from allocating
 *  gigabytes; real edits are orders of magnitude below this. */
const MAX_DP_CELLS = 6_250_000; // 2500 × 2500

export interface UnifiedDiffOptions {
  /** Emitted as the `---` header when set. When omitted, NO file headers are emitted —
   *  only @@ hunks (clean for embedding inside tool cards). */
  oldLabel?: string;
  /** Emitted as the `+++` header when set. */
  newLabel?: string;
  /** Lines of unchanged context around each hunk (default 3, like git). */
  context?: number;
}

type Op = { t: '=' | '-' | '+'; line: string };

function splitLines(text: string): string[] {
  const norm = text.replace(/\r\n?/g, '\n');
  if (norm === '') return [];
  const lines = norm.split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // trailing newline is structural, not a line
  return lines;
}

/** LCS ops over the two middle sections. Caller has already trimmed the common prefix/suffix
 *  and enforced MAX_DP_CELLS. Backtracking is deterministic: on ties prefer deletion before
 *  addition, keeping moved blocks as contiguous '-' runs followed by contiguous '+' runs. */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length, m = b.length;
  // l[i*(m+1)+j] = LCS length of a[i..] vs b[j..]
  const w = m + 1;
  const l = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      l[i * w + j] = a[i] === b[j]
        ? l[(i + 1) * w + j + 1] + 1
        : Math.max(l[(i + 1) * w + j], l[i * w + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: '=', line: a[i] }); i++; j++; }
    else if (l[(i + 1) * w + j] >= l[i * w + j + 1]) { ops.push({ t: '-', line: a[i] }); i++; }
    else { ops.push({ t: '+', line: b[j] }); j++; }
  }
  while (i < n) { ops.push({ t: '-', line: a[i] }); i++; }
  while (j < m) { ops.push({ t: '+', line: b[j] }); j++; }
  return ops;
}

function wholeReplaceOps(a: string[], b: string[]): Op[] {
  return [
    ...a.map((line) => ({ t: '-' as const, line })),
    ...b.map((line) => ({ t: '+' as const, line })),
  ];
}

/** Group ops into git-style hunks: runs of changes padded with `context` equal lines on each
 *  side; two change runs separated by ≤ 2×context equal lines merge into one hunk. */
function buildHunks(ops: Op[], context: number): string[] {
  // Indices of every changed op.
  const changeIdx: number[] = [];
  for (let i = 0; i < ops.length; i++) if (ops[i].t !== '=') changeIdx.push(i);
  if (!changeIdx.length) return [];

  // Group change indices into clusters: merge when the EQUAL lines between two consecutive
  // changes are few enough that their context windows would overlap/touch. Counting equals
  // (not raw index distance) keeps a contiguous −/+ pair in ONE hunk even at context 0.
  const groups: Array<[number, number]> = []; // inclusive [firstChangeIdx, lastChangeIdx]
  let gs = changeIdx[0], ge = changeIdx[0];
  for (let k = 1; k < changeIdx.length; k++) {
    const idx = changeIdx[k];
    const equalsBetween = idx - ge - 1;
    if (equalsBetween <= context * 2) ge = idx;
    else { groups.push([gs, ge]); gs = idx; ge = idx; }
  }
  groups.push([gs, ge]);

  // Track current position counters while emitting.
  let aLine = 1, bLine = 1; // 1-based line numbers of ops[0]
  // Precompute per-op numbers once.
  const aNo = new Int32Array(ops.length);
  const bNo = new Int32Array(ops.length);
  for (let i = 0; i < ops.length; i++) {
    aNo[i] = aLine; bNo[i] = bLine;
    if (ops[i].t === '=') { aLine++; bLine++; }
    else if (ops[i].t === '-') aLine++;
    else bLine++;
  }

  const hunks: string[] = [];
  for (const [cs, ce] of groups) {
    const start = Math.max(0, cs - context);
    const end = Math.min(ops.length - 1, ce + context); // inclusive
    let cA = 0, cB = 0;
    const body: string[] = [];
    for (let i = start; i <= end; i++) {
      const op = ops[i];
      if (op.t !== '+') cA++;
      if (op.t !== '-') cB++;
      // Standard unified format: '-'/'+' prefixes touch the line; context lines carry a
      // single leading space.
      body.push(op.t === '=' ? ` ${op.line}` : `${op.t}${op.line}`);
    }
    // An empty side in a hunk range reports the line BEFORE the insertion/deletion point
    // (git convention): a pure add at the top of a file is `@@ -0,0 +1,N @@`.
    const startA = cA === 0 ? aNo[start] - 1 : aNo[start];
    const startB = cB === 0 ? bNo[start] - 1 : bNo[start];
    const rangeA = cA === 1 ? `${startA}` : `${startA},${cA}`;
    const rangeB = cB === 1 ? `${startB}` : `${startB},${cB}`;
    hunks.push(`@@ -${rangeA} +${rangeB} @@\n${body.join('\n')}`);
  }
  return hunks;
}

/** Produce a unified diff between two strings. Returns '' when there is no textual difference
 *  (after line-ending normalization). Pure: same inputs ⇒ same output string, always. */
export function unifiedDiff(oldText: string, newText: string, opts: UnifiedDiffOptions = {}): string {
  const context = Math.max(0, opts.context ?? 3);
  const a = splitLines(oldText);
  const b = splitLines(newText);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const middleOps: Op[] = midA.length && midB.length && midA.length * midB.length > MAX_DP_CELLS
    ? wholeReplaceOps(midA, midB)
    : lcsOps(midA, midB);

  if (!middleOps.some((op) => op.t !== '=')) return '';

  const ops: Op[] = [
    ...a.slice(0, start).map((line) => ({ t: '=' as const, line })),
    ...middleOps,
    ...a.slice(endA).map((line) => ({ t: '=' as const, line })),
  ];

  const hunks = buildHunks(ops, context);
  if (!hunks.length) return '';

  const head: string[] = [];
  if (opts.oldLabel != null || opts.newLabel != null) {
    head.push(`--- ${opts.oldLabel ?? 'a'}`, `+++ ${opts.newLabel ?? 'b'}`);
  }
  return [...head, ...hunks].join('\n');
}
