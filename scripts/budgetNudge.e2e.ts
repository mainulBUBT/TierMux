/* Budget-approaching nudge — the decision logic inside loop.ts's prepareStep (agent mode only).
 *
 * budgetStop is a pure kill switch: once cumulative usage exceeds maxTurnTokens the turn is cut
 * off, with no warning beforehand. Measured 2026-08-10: a complex-task run made 29 read-only tool
 * calls, hit budgetStop, and made ZERO edit-tool calls — confirmed by adding per-call
 * instrumentation to the harness (it previously only logged tool NAMES, not outcomes, so this was
 * invisible). Pruning doesn't help: it shrinks what gets RE-SENT to the model, not the cumulative
 * usage budgetStop counts, so a model that keeps exploring can burn the whole budget regardless.
 *
 * prepareStep can't be unit-tested directly (it only runs inside a live streamText call), so this
 * mirrors its threshold/hasMutated decision as a documented contract — the same shape
 * synthShrink.e2e.ts uses for the unexported looksLikeToolCallAttempt.
 *
 * Run: npm run test:e2e:budget-nudge
 */
import { MUTATING_TOOLS } from '../src/agent/core/policies/permission';

const BUDGET_NUDGE_THRESHOLD = 0.65;

function shouldNudge(
  steps: Array<{ usage?: { totalTokens?: number }; toolCalls?: Array<{ toolName?: string }> }>,
  maxTurnTokens: number,
  alreadyNudged: boolean,
): boolean {
  if (alreadyNudged || maxTurnTokens <= 0) return false;
  const usedSoFar = steps.reduce((n, s) => n + (s.usage?.totalTokens ?? 0), 0);
  const hasMutated = steps.some((s) => (s.toolCalls ?? []).some((tc) => tc.toolName && MUTATING_TOOLS.has(tc.toolName)));
  return !hasMutated && usedSoFar > maxTurnTokens * BUDGET_NUDGE_THRESHOLD;
}

let bad = 0;
const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) bad++; };

const readSteps = (n: number, tokPerStep: number) =>
  Array.from({ length: n }, () => ({ usage: { totalTokens: tokPerStep }, toolCalls: [{ toolName: 'readFile' }] }));

ok('below threshold: no nudge', !shouldNudge(readSteps(10, 1000), 200_000, false));
ok(
  'above threshold, no mutation yet: nudges',
  shouldNudge(readSteps(29, 5000), 200_000, false), // 145K / 200K = 72.5% > 65%
);
ok(
  'above threshold but already mutated: no nudge — the model is already acting',
  shouldNudge(
    [...readSteps(28, 5000), { usage: { totalTokens: 5000 }, toolCalls: [{ toolName: 'editFile' }] }],
    200_000,
    false,
  ) === false,
);
ok('fires-once guard: does not re-nudge once already nudged', !shouldNudge(readSteps(40, 5000), 200_000, true));
ok('budget disabled (maxTurnTokens<=0): never nudges', !shouldNudge(readSteps(100, 5000), 0, false));

console.log(bad ? `\n${bad} FAILURE(S)` : '\nALL PASS');
process.exit(bad ? 1 : 0);
