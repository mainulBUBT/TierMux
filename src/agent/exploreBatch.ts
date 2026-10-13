// `/explore`: the USER sends research to read-only explore sub-agents, one per line, one at a
// time. Free-tier models never chose delegateTask on their own (agentBench research task: 0 of 6
// runs, 2026-10-12), so this keeps a broad investigation's file reads out of the main context
// without waiting for the model to decide it.

export const EXPLORE_MAX_QUESTIONS = 6;
/** One at a time: three in parallel on free tiers drew 429s from every candidate and answered 0 of 3
 *  (agentBench research-explore, 2026-10-12). The batch runner still takes a higher count. */
export const EXPLORE_PARALLEL = 1;

export function exploreQuestions(rest: string): string[] {
  return rest
    .split('\n')
    .map((q) => q.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .slice(0, EXPLORE_MAX_QUESTIONS);
}

export async function runExploreBatch(
  questions: string[],
  explore: (question: string) => Promise<string>,
  parallel = EXPLORE_PARALLEL,
): Promise<string> {
  const reports: string[] = new Array(questions.length);
  let next = 0;
  const worker = async () => {
    while (next < questions.length) {
      const i = next++;
      try {
        reports[i] = await explore(questions[i]);
      } catch (e) {
        reports[i] = `_Explore failed: ${e instanceof Error ? e.message : String(e)}_`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, questions.length) }, worker));
  return questions.map((q, i) => `### ${q}\n\n${reports[i]}`).join('\n\n---\n\n');
}
