

// Per-step difficulty (Phase-2 step routing). The planner tags each plan step `[easy]` /
// `[medium]` / `[hard]`; the tag is stripped into `TodoItem.difficulty` when the checklist is
// seeded, and each auto-continue round routes its model by the difficulty of the step it is
// actually executing (loop.ts maps it to Router rank constraints): reads/searches run on the
// cheap fast pool, tricky edits on the top tier. Mis-classifying a step must fail SAFE, so the
// heuristic below only calls something `easy` when it is unmistakably a read — an edit tagged
// easy by mistake just routes on the unconstrained default, which is today's behavior.

export type StepDifficulty = 'easy' | 'medium' | 'hard';

/** Splits a leading `[easy]`/`[medium]`/`[hard]` tag off a step line. Returns the difficulty
 *  (undefined when untagged) and the tag-free content. Tolerant of case and stray whitespace. */
export function parseStepDifficultyTag(text: string): { difficulty?: StepDifficulty; content: string } {
  const m = /^\s*\[(easy|medium|hard)\]\s*/i.exec(text);
  if (!m) return { content: text.trim() };
  return { difficulty: m[1].toLowerCase() as StepDifficulty, content: text.slice(m[0].length).trim() };
}

/** Read/search verbs — a step that ONLY does these is a lookup any working model performs
 *  equally well, so it belongs on the cheap pool. */
const READ_VERB_RE = /\b(?:read|check|look|explore|search|find|review|list|open|inspect|locate|identify|scan|verify the|confirm the)\b/i;
/** Mutation verbs — a step that changes code carries correctness risk and needs the capable
 *  tier (or at least the unconstrained default). */
const EDIT_VERB_RE = /\b(?:edit|write|create|fix|implement|add|update|change|delete|remove|refactor|rename|move|migrat|rewrit|modif|replac|configur|integrat|wir)\w*\b/i;

/** Fallback difficulty for untagged steps (model-authored todos, older plans). Deliberately
 *  conservative: `easy` requires read verbs and NO edit verbs; any edit verb → `hard`; anything
 *  ambiguous → `medium` (no routing constraint at all). A wrong `hard` wastes some budget; a
 *  wrong `easy` could route real edits to a weak model — so only the unmistakable case wins. */
export function inferStepDifficulty(text: string): StepDifficulty {
  const t = text.trim();
  if (!t) return 'medium';
  const reads = READ_VERB_RE.test(t);
  const edits = EDIT_VERB_RE.test(t);
  if (reads && !edits) return 'easy';
  if (edits) return 'hard';
  return 'medium';
}

/** Difficulty for a step line: an explicit planner tag wins; otherwise the conservative
 *  heuristic. The tag is stripped from the content either way. */
export function stepDifficultyOf(text: string): { difficulty: StepDifficulty; content: string } {
  const { difficulty, content } = parseStepDifficultyTag(text);
  return { difficulty: difficulty ?? inferStepDifficulty(content), content };
}
