

import { tool, generateText, isStepCount } from 'ai';
import { z } from 'zod';
import type { Router } from '../../../router/router';
import { createRouterProvider } from '../routerProvider';
import { createReadTool } from './filesystem/read';
import { createGrepTool } from './workspace/grep';
import { createGlobTool } from './workspace/glob';
import { createListDirTool } from './workspace/list';

// The whole point is to keep the MAIN agent's context small, so this sub-loop is deliberately
// short: enough steps to search + read a few files, not to solve a task. It runs on the cheap
// utility model (pickUtilityModel) so the noisy exploration doesn't burn the primary model's
// tokens or rate-limit budget.
const MAX_STEPS = 6;

// Hard wall-clock ceiling for the whole sub-agent. Without it, a nested 6-step loop on a pinned
// free utility model that keeps hitting rate-limit backoff can run for minutes, freezing the
// parent turn with no output ("huge time / response not showing"). On timeout the sub-agent aborts
// and degrades to a "search yourself" message the main agent can act on. Capped at 20s (was 45s):
// the sub-agent is read-only exploration on a cheap model — a search that hasn't converged in 20s
// is almost certainly thrashing on rate-limit backoff, and every second it blocks the parent turn
// is a second the user sees nothing.
const EXPLORE_TIMEOUT_MS = 20_000;

const EXPLORE_SYSTEM =
  'You are a codebase exploration sub-agent. Your ONLY job is to investigate the workspace and '
  + 'report concise findings back to the main agent. You have READ-ONLY tools (readFile, grep, '
  + 'glob, listDir) — you cannot edit files or run commands.\n\n'
  + 'Work efficiently: search, read only the relevant parts, and STOP as soon as you can answer. '
  + 'Then reply with a compact findings report:\n'
  + '- The specific files and symbols that matter, as workspace-relative `path:line` locations.\n'
  + '- 1–3 sentences on how they fit together / answer the question.\n'
  + 'Do NOT paste large code blocks — cite locations instead. Keep the whole report under ~400 '
  + 'words. If you could not find something, say so plainly rather than guessing.';

/**
 * The "Explore sub-agent" — the context-isolation pattern Cursor/Copilot/Kilo converged on,
 * adapted for free tiers. A cheap utility model does the grep/read flailing in ITS OWN loop and
 * returns only a short findings summary; the primary model never carries the raw tool output.
 * This is the biggest lever against the tool-result bloat that otherwise re-bills large reads on
 * every iteration (see capOutput.ts for the complementary per-result cap).
 */
export function createExploreTool(router: Router, abortSignal?: AbortSignal) {
  // The AI SDK lets one model step request several tool calls at once — if the model fires two
  // `explore` calls with the SAME task text in that batch (a known weak-model tic, not a
  // deliberate parallel investigation), each would otherwise spin up its own redundant nested
  // 6-step sub-loop. Dedupe concurrent identical tasks by sharing the in-flight promise; cleared
  // once it settles so a later, genuinely re-asked identical question still gets a fresh answer
  // reflecting whatever changed in between, instead of a stale cached one.
  const inFlight = new Map<string, Promise<string>>();

  return tool({
    description:
      'Delegate a codebase investigation to a fast, read-only sub-agent. Prefer this over doing '
      + 'many grep/read calls yourself when you need to LOCATE code or UNDERSTAND how something '
      + 'works — the sub-agent searches and returns only a concise findings summary (files, '
      + 'symbols, line numbers), keeping your own context small. Good for "where is X handled", '
      + '"how does Y work", "which files touch Z". Not for edits or running commands.',
    inputSchema: z.object({
      task: z.string().describe('The investigation to perform, phrased as a specific question.'),
    }),
    execute: async ({ task }: { task: string }) => {
      if (!task) throw new Error('Missing required "task" argument.');
      const existing = inFlight.get(task);
      if (existing) return existing;

      const p = runExplore(task);
      inFlight.set(task, p);
      try {
        return await p;
      } finally {
        inFlight.delete(task);
      }
    },
  });

  async function runExplore(task: string): Promise<string> {
    // undefined pinnedModel → the router auto-routes a cheap model itself.
    const utility = await router.pickUtilityModel();
    const provider = createRouterProvider(router, { taskKind: 'reasoning', pinnedModel: utility });

    const tools = {
      readFile: createReadTool(),
      grep: createGrepTool(),
      glob: createGlobTool(),
      listDir: createListDirTool(),
    };

    // Bound the sub-agent in time: whichever fires first — the parent turn's abort or our own
    // 20s ceiling — cancels the nested loop. AbortSignal.any keeps both live.
    const timeout = AbortSignal.timeout(EXPLORE_TIMEOUT_MS);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;

    try {
      const result = await generateText({
        model: provider as any,
        system: EXPLORE_SYSTEM,
        prompt: task,
        tools: tools as any,
        stopWhen: isStepCount(MAX_STEPS),
        abortSignal: signal,
      } as any);
      const text = ((result as any).text ?? '').trim();
      return text || '(exploration finished but produced no findings)';
    } catch (err) {
      // Never throw out of the sub-agent — a failed exploration should degrade to a message the
      // main agent can react to (e.g. fall back to searching itself), not abort the whole turn.
      return `Exploration failed: ${err instanceof Error ? err.message : String(err)}. Fall back to searching directly.`;
    }
  }
}
