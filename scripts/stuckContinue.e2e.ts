/* Regression test for the auto-continue loop giving up on an ENTIRE todo plan the instant one
 * item stalls. Before this fix, chatViewProvider.ts's auto-continue loop treated
 * `result.stopReason === 'stuck'` as an unconditional `break` — a turn that finished 3 of 5 todo
 * items and then hit a stuck-loop guard (e.g. repeating the same grep 3x) on item 4 halted the
 * WHOLE plan right there, reporting items 4-5 as "unresolved" even though item 5 might have
 * nothing to do with whatever item 4 was stuck on, and item 4 itself might well succeed with a
 * different approach. Reported directly by the user: "jodi agent janei eshb remaining tahole shey
 * nije korena keno?" (if the agent already knows what's remaining, why doesn't it just do it
 * itself?).
 *
 * Fixed by giving 'stuck' the same bounded-continuation treatment 'budget' already had
 * (maxBudgetContinuations), via a new maxStuckContinuations setting (default 1) — one retry with
 * an explicit "you got stuck, try something different or move on" nudge (stuckContinueMessage),
 * not a blind repeat of the same "keep going" message that would likely just repeat the stall.
 *
 * chatViewProvider.ts's auto-continue loop isn't unit-testable in isolation (it's deep inside a
 * message handler with live session/router state) — mirrors its exact per-round decision logic
 * instead, the same contract-test pattern used elsewhere in this suite (unverifiedBadge.e2e.ts,
 * budgetNudge.e2e.ts).
 *
 * Run: npm run test:e2e:stuck-continue
 */
let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

type StopReason = 'budget' | 'stuck' | undefined;

/** Mirrors the counter/halt decision at the top of chatViewProvider.ts's auto-continue loop body
 *  for ONE round. Returns whether this round halts, and the updated streak counters. */
function decideRound(
  stopReason: StopReason,
  budgetContinuations: number,
  stuckContinuations: number,
  maxBudgetContinuations: number,
  maxStuckContinuations: number,
): { halt: boolean; budgetContinuations: number; stuckContinuations: number } {
  if (stopReason === 'stuck') {
    if (stuckContinuations >= maxStuckContinuations) return { halt: true, budgetContinuations, stuckContinuations };
    return { halt: false, budgetContinuations: 0, stuckContinuations: stuckContinuations + 1 };
  }
  if (stopReason === 'budget') {
    if (budgetContinuations >= maxBudgetContinuations) return { halt: true, budgetContinuations, stuckContinuations };
    return { halt: false, budgetContinuations: budgetContinuations + 1, stuckContinuations: 0 };
  }
  return { halt: false, budgetContinuations: 0, stuckContinuations: 0 };
}

// --- The actual regression: ONE stuck stop, default cap (1), must continue, not halt. ---
{
  const r = decideRound('stuck', 0, 0, 1, 1);
  ok('a single stuck stop (default cap 1): does NOT halt — gets one more try', !r.halt);
  ok('stuck streak advances to 1', r.stuckContinuations === 1);
}

// --- A SECOND consecutive stuck stop must halt for real (avoid nudging forever). ---
{
  const first = decideRound('stuck', 0, 0, 1, 1);
  const second = decideRound('stuck', first.budgetContinuations, first.stuckContinuations, 1, 1);
  ok('a SECOND consecutive stuck stop (cap 1): halts', second.halt);
}

// --- A round that completes cleanly (no stopReason) between two stuck stops resets the streak,
// so a later, UNRELATED stall still gets its own retry rather than inheriting the old streak. ---
{
  const stuckOnce = decideRound('stuck', 0, 0, 1, 1);
  const cleanRound = decideRound(undefined, stuckOnce.budgetContinuations, stuckOnce.stuckContinuations, 1, 1);
  ok('a clean round resets the stuck streak to 0', cleanRound.stuckContinuations === 0);
  const stuckAgain = decideRound('stuck', cleanRound.budgetContinuations, cleanRound.stuckContinuations, 1, 1);
  ok('a later, independent stall after a clean round gets its own retry (does not halt)', !stuckAgain.halt);
}

// --- A budget cutoff resets the stuck streak and vice versa — the two brakes are independent. ---
{
  const stuckOnce = decideRound('stuck', 0, 0, 1, 1);
  const thenBudget = decideRound('budget', stuckOnce.budgetContinuations, stuckOnce.stuckContinuations, 1, 1);
  ok('a budget cutoff after a stuck round resets the stuck streak', thenBudget.stuckContinuations === 0);
  ok('a budget cutoff after a stuck round still continues (own cap not yet hit)', !thenBudget.halt);
}

// --- maxStuckContinuations: 0 restores the old always-halt-immediately behavior. ---
{
  const r = decideRound('stuck', 0, 0, 1, 0);
  ok('maxStuckContinuations=0: halts immediately on the first stuck stop (old behavior)', r.halt);
}

// --- A higher cap tolerates more consecutive stalls before giving up. ---
{
  let b = 0, st = 0;
  let halted = false;
  for (let i = 0; i < 3; i++) {
    const r = decideRound('stuck', b, st, 1, 3);
    b = r.budgetContinuations; st = r.stuckContinuations;
    if (r.halt) { halted = true; break; }
  }
  ok('maxStuckContinuations=3: survives 3 consecutive stuck rounds without halting', !halted);
  const fourth = decideRound('stuck', b, st, 1, 3);
  ok('maxStuckContinuations=3: the 4th consecutive stall halts', fourth.halt);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
