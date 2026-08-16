

// Late re-anchoring for the tool loop.
//
// The problem this solves, in one line: PRUNE_TOOL_POLICY evicts every read result older than the
// last 2 messages, so by step 5 the model is answering about files it can no longer see.
//
// That is fine for a frontier model summarising its own notes and measurably bad for the free
// models TierMux targets. The small-model literature is unusually consistent here: continuous
// external re-anchoring (keeping the retrieved material in front of the model) is the single
// strongest inference-time intervention for sub-10B models — Cohen's d 0.23–0.93, an order of
// magnitude above anything else measured — and its benefit correlates with how weak the baseline
// is. Crucially, the same work finds reasoning errors accumulate LATE in a trace (normalised
// position 0.56–0.71), which is exactly where pruning has already thrown the anchors away. The
// harness was removing the evidence at precisely the step the model most needed it.
//
// This is deliberately NOT self-critique. Asking a weak model to re-read its own reasoning makes
// things worse ("pseudo-reflection", d = -0.14 to -0.33 — it generates text that looks like
// reflection while inventing plausible-but-wrong justifications). Re-anchoring adds no reasoning
// step at all: it just puts the source material back.
//
// Matches TierMux's measured shape — retrieval 75% but answer 54%: the agent finds the right
// files and then loses them before it writes. See docs/AGENT_QUALITY_2026-08-09.md.

/** One file's retained content. `step` is the tool-loop step it was last read at — most-recent
 *  wins on a re-read, and ordering by it puts the freshest file nearest the prompt tail, where a
 *  weak model's attention is strongest. */
interface Anchor {
  path: string;
  content: string;
  step: number;
}

/** Marker opening the injected block. Also the idempotence key: any previous block is stripped
 *  before a new one is appended, so re-injecting every step can never stack copies. */
export const ANCHOR_BLOCK_MARKER = '## Files you read this turn (re-shown — older tool output was trimmed)';

/** Files given a slice of the budget. Past this, excerpts get too small to carry meaning — better
 *  to show 4 files usefully than 12 uselessly, and the freshest reads are the relevant ones. */
const MAX_ANCHORED_FILES = 4;
/** Floor per file. If the budget can't give each file at least this much, fewer files are shown
 *  rather than shrinking every excerpt into uselessness. */
const MIN_EXCERPT_CHARS = 400;
/** Appended to a clipped excerpt. Its length is reserved exactly when sizing each file's slice. */
const TRUNCATION_NOTE = '\n…[truncated]';

/**
 * Per-turn store of what the model actually read. Populated from `tool-result` parts; rendered
 * into a single bounded block that `prepareStep` re-appends after each prune.
 *
 * Head-of-file excerpts, not middle or tail: reads already arrive capped by capOutput, and the
 * head is where imports, signatures, and type declarations live — the parts an answer cites.
 */
export class AnchorStore {
  private readonly anchors = new Map<string, Anchor>();

  /** Record (or refresh) a file's content. A re-read replaces the older copy and becomes the
   *  freshest entry — the model re-read it for a reason. */
  record(path: string, content: string, step: number): void {
    if (!path || !content.trim()) return;
    this.anchors.set(path, { path, content, step });
  }

  get size(): number {
    return this.anchors.size;
  }

  /**
   * The re-anchor block, or '' when there is nothing worth showing. `budgetChars` is a hard
   * ceiling on the rendered result — callers size it well under the prune threshold so
   * re-anchoring can never be what pushes a turn back over it.
   */
  digest(budgetChars: number): string {
    if (budgetChars <= 0 || this.anchors.size === 0) return '';
    // Freshest last: the block is appended at the prompt tail, and recency bias means the final
    // file is the best-attended one. Sorting ascending by step puts the newest read closest.
    const ordered = [...this.anchors.values()].sort((a, b) => a.step - b.step);
    const header = `${ANCHOR_BLOCK_MARKER}\n`;
    const available = budgetChars - header.length;
    if (available < MIN_EXCERPT_CHARS) return '';

    // Keep the N freshest, then re-sort ascending so the newest still lands last.
    const shown = ordered.slice(-MAX_ANCHORED_FILES);
    // Shrink the file count until each survivor clears the floor, rather than showing everything
    // at a width too small to be usable. `overheadFor` is exact rather than a guessed constant —
    // an approximate reservation is what let a 500-char budget emit a 503-char block.
    const overheadFor = (a: Anchor): number => `\n### ${a.path}\n`.length + TRUNCATION_NOTE.length;
    // `usable` also reserves the '\n' joining consecutive file sections. Leaving those out is what
    // made every block land a few chars over and get clipped by the final clamp — which cuts mid
    // source line and drops the truncation marker, so the model cannot tell it was cut.
    const usableFor = (n: number): number => available - (n - 1);
    let count = shown.length;
    while (count > 1) {
      const worst = Math.max(...shown.slice(-count).map(overheadFor));
      if (Math.floor(usableFor(count) / count) - worst >= MIN_EXCERPT_CHARS) break;
      count--;
    }
    const picked = shown.slice(-count);
    const perFile = Math.floor(usableFor(count) / count);
    // Even one file may not fit: a few hundred characters of a single source file is noise, not an
    // anchor. Emitting nothing is the honest outcome — the caller then sends the pruned history it
    // would have sent anyway.
    if (perFile - overheadFor(picked[picked.length - 1]) < MIN_EXCERPT_CHARS) return '';

    const parts = picked.map((a) => {
      const bodyBudget = perFile - overheadFor(a);
      const body = a.content.length > bodyBudget
        ? `${a.content.slice(0, bodyBudget)}${TRUNCATION_NOTE}`
        : a.content;
      return `\n### ${a.path}\n${body}`;
    });
    const out = header + parts.join('\n');
    // Belt and braces. Every branch above is bounded, but this block is injected on a turn that
    // ALREADY crossed the prune threshold, so "usually within budget" is not good enough — an
    // oversized block would re-trigger the pruning it exists to compensate for.
    return out.length <= budgetChars ? out : out.slice(0, budgetChars);
  }
}

/**
 * Remove a previously injected block from a message list. `prepareStep` may run many times on a
 * growing history; without this, each pass would append another copy and re-anchoring would
 * become the context bloat it exists to prevent.
 */
export function stripAnchorBlock<T extends { role: string; content: unknown }>(messages: T[]): T[] {
  return messages.filter((m) => !(
    m.role === 'user'
    && typeof m.content === 'string'
    && m.content.startsWith(ANCHOR_BLOCK_MARKER)
  ));
}
