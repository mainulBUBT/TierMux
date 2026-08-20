

// The step-execution brain (Phase 3), lifted out of chatViewProvider's UI loop so the SAME
// decision rules serve three callers: the chat UI's auto-continue loop, headless/programmatic
// callers via runStepTask(), and the e2e harness. Everything here is pure decision-making plus
// the headless driver — no vscode import, no UI posting, no persistence. The provider keeps
// only the UI effects around each decision (persisting the turn, pushing history, posting).
//
// One rule is NEW versus the old provider loop — step acceptance: a round whose verify command
// FAILED (AgentResult.verifyOutcome === 'failed') is not an acceptable completion, even when the
// model marked every todo completed. The checklist is the contract, but the verify command is
// its arbiter: "the model said done" loses to "the command still fails". Bounded to one focused
// extra round (maxUnacceptedContinuations) — after that the deterministic failure note already
// appended to the turn's text is the honest end state.
import type { TodoItem, ChatMessage } from '../../shared/types';
import type { AgentResult, AgentOpts } from '../agent';
import type { Router } from '../../router/router';
import { inferStepDifficulty, type StepDifficulty } from '../stepDifficulty';
import { runTurn } from './loop';

/** The synthetic user message that drives one round of the step loop. When the visible plan
 *  still has unfinished todos, spell them out so the model resumes the exact remaining work
 *  (rather than a generic "continue" string, which invited re-planning or repeating done
 *  steps). Falls back to a plain continuation when the loop was triggered by a step-cap pause
 *  with no todos.
 *
 *  `originalTask` (optional) re-injects the user's original request at the head of each
 *  continuation — after history compaction or a small-window trim the goal can be evicted from
 *  context, leaving the model working toward a summary it never saw. The goal line is kept
 *  short (first 200 chars) so it doesn't compete with the todo list on tiny free windows. */
export function autoContinueMessage(remainingTodos: TodoItem[], originalTask?: string): string {
  const goalLine = originalTask
    ? `\nOriginal request: ${originalTask.slice(0, 200)}${originalTask.length > 200 ? '…' : ''}\n`
    : '';
  if (remainingTodos.length === 0) {
    return `${goalLine}Continue from where you left off. Keep going with the remaining steps using the work `
      + 'already done above — do not restart or repeat completed steps.';
  }
  const list = remainingTodos
    .map((t) => `- ${t.content}${t.status === 'in_progress' ? ' (in progress)' : ''}`)
    .join('\n');
  return `${goalLine}Keep going — your plan still has unfinished items. Continue working through them using `
    + 'the work already done above; do not restart or repeat completed steps. Update the todo list '
    + 'as you finish each item, and only stop once every item is completed (or you hit a genuine '
    + `blocker, which you must state plainly).\n\nRemaining items:\n${list}`;
}

/** Companion to {@link autoContinueMessage} for a 'stuck' stop specifically. A plain "keep going"
 *  message would very likely reproduce the exact same repeated tool call that caused the stall —
 *  this one names that risk explicitly and asks for a genuinely different approach (or, failing
 *  that, to move on to the next item rather than stopping the whole plan over one blocked step).
 *  Bounded to one use per stall by the caller (maxStuckContinuations) — if the SAME approach
 *  fails a second time, the loop halts for real rather than nudging forever. */
export function stuckContinueMessage(remainingTodos: TodoItem[], originalTask?: string): string {
  const goalLine = originalTask
    ? `\nOriginal request: ${originalTask.slice(0, 200)}${originalTask.length > 200 ? '…' : ''}\n`
    : '';
  const base = 'You got stuck repeating the same action without making progress — do NOT repeat '
    + 'it. Try a genuinely different approach for whatever you were stuck on (a different search '
    + 'term, file, or tool entirely). If it still doesn\'t work, move on to the next item rather '
    + 'than stopping the whole plan, and report the stuck one as blocked at the end, stating '
    + 'plainly what you tried and why it didn\'t work.';
  if (remainingTodos.length === 0) return `${goalLine}${base}`;
  const list = remainingTodos
    .map((t) => `- ${t.content}${t.status === 'in_progress' ? ' (in progress)' : ''}`)
    .join('\n');
  return `${goalLine}${base}\n\nRemaining items:\n${list}`;
}

/** The step-acceptance message: every todo is marked completed, but the verify command still
 *  fails. The plan is NOT accepted — the last "completed" step is, observably, not done. */
function unacceptedContinueMessage(originalTask?: string): string {
  const goalLine = originalTask
    ? `\nOriginal request: ${originalTask.slice(0, 200)}${originalTask.length > 200 ? '…' : ''}\n`
    : '';
  return `${goalLine}You marked every todo completed, but the project's verify command still FAILS — `
    + 'the plan is not accepted yet, and the last step is not actually done. Fix the cause of the '
    + 'failing command (its output is in the previous result), re-run it, and only then report '
    + 'completion. If it genuinely cannot be fixed in this step, say so plainly and explain what '
    + 'remains broken.';
}

/** Everything decideStepRound needs to decide the next round. Todos must already be scoped to
 *  "written during THIS send" by the caller (the same rule the old UI loop used — stale
 *  checklists from an earlier turn must not keep a fresh, unrelated turn spinning). */
export interface StepRoundInput {
  /** Todos written during this send ([] when none were). */
  todos: TodoItem[];
  /** The round that just finished. */
  result: AgentResult;
  originalTask?: string;
  /** Continuations already spent (the decision returns updated counters). */
  stuckContinuations: number;
  maxStuckContinuations: number;
  budgetContinuations: number;
  maxBudgetContinuations: number;
  /** Acceptance retries already spent (verify-failed "completed" checklists). */
  unacceptedContinuations: number;
  maxUnacceptedContinuations: number;
  /** Auto mode only — a user-pinned model is never excluded, even after a stall. */
  allowModelExclusion: boolean;
}

export type StepRoundDecision =
  | { action: 'stop'; reason: string }
  | {
      action: 'continue';
      /** Which guard drove the continuation: pending todos / stall recovery / fresh budget /
       *  step-cap resume / step acceptance. For diagnostics. */
      kind: 'todos' | 'stuck' | 'budget' | 'paused' | 'unaccepted';
      /** Human-readable diag summary. */
      reason: string;
      /** User message to push before the next round. */
      message: string;
      /** Route the next round by the difficulty of the step it executes (Phase 2). */
      difficulty?: StepDifficulty;
      /** Auto mode only: exclude the model that just stalled so the retry genuinely differs. */
      excludeModels?: string[];
      stuckContinuations: number;
      budgetContinuations: number;
      unacceptedContinuations: number;
    };

/** Difficulty for the round about to run: the first remaining todo's planner tag, or the
 *  conservative inference when the model rewrote the checklist without tags. */
export function stepDifficultyFor(todo: TodoItem | undefined): StepDifficulty | undefined {
  if (!todo) return undefined;
  return todo.difficulty ?? inferStepDifficulty(todo.content);
}

/** Decides whether the step loop runs another round, and with what nudges/constraints. Ports the
 *  exact decision order the provider's UI loop used (stuck cap → budget cap → todos/paused),
 *  adds the step-acceptance rule, and computes the per-round routing difficulty. Pure — the
 *  caller owns counters, history, and any UI effects. */
export function decideStepRound(input: StepRoundInput): StepRoundDecision {
  const { todos, result, originalTask } = input;
  const remaining = todos.filter((t) => t.status !== 'completed');

  // --- Stall recovery: worth exactly one genuinely-different try (a repeated tool call on
  //     item 4 says nothing about whether item 5 is reachable). Second stall halts for real.
  if (result.stopReason === 'stuck') {
    if (input.stuckContinuations >= input.maxStuckContinuations) {
      return { action: 'stop', reason: `stuck ${input.stuckContinuations}× in a row (cap ${input.maxStuckContinuations})` };
    }
    const excludeModels = input.allowModelExclusion && result.platform && result.model
      ? [`${result.platform}::${result.model}`]
      : undefined;
    return {
      action: 'continue',
      kind: 'stuck',
      reason: `stall recovery (${input.stuckContinuations + 1}/${input.maxStuckContinuations})`,
      message: stuckContinueMessage(remaining, originalTask),
      difficulty: stepDifficultyFor(remaining[0]),
      excludeModels,
      stuckContinuations: input.stuckContinuations + 1,
      budgetContinuations: 0,
      unacceptedContinuations: input.unacceptedContinuations,
    };
  }

  // --- Budget cutoff: each continuation is a brand-new turn with a FRESH token budget
  //     (not a raised ceiling) — the Claude Code/Cursor-style agent behavior on big rewrites.
  if (result.stopReason === 'budget') {
    if (input.budgetContinuations >= input.maxBudgetContinuations) {
      return { action: 'stop', reason: `budget cutoff ${input.budgetContinuations}× in a row (cap ${input.maxBudgetContinuations})` };
    }
    return {
      action: 'continue',
      kind: 'budget',
      reason: `fresh turn budget (${input.budgetContinuations + 1}/${input.maxBudgetContinuations})`,
      message: autoContinueMessage(remaining, originalTask),
      difficulty: stepDifficultyFor(remaining[0]),
      stuckContinuations: 0,
      budgetContinuations: input.budgetContinuations + 1,
      unacceptedContinuations: input.unacceptedContinuations,
    };
  }

  // --- Step acceptance: the checklist says done, the verify command says otherwise. The
  //     command is the arbiter — one focused retry, then the failure note stands. Only when a
  //     checklist EXISTS: with no todos there is no "completed" claim to reject, and runTurn's
  //     own internal fix retry already covered the failure.
  if (!result.paused && remaining.length === 0) {
    if (todos.length > 0 && result.verifyOutcome === 'failed' && input.unacceptedContinuations < input.maxUnacceptedContinuations) {
      return {
        action: 'continue',
        kind: 'unaccepted',
        reason: `checklist completed but verify failed (${input.unacceptedContinuations + 1}/${input.maxUnacceptedContinuations})`,
        message: unacceptedContinueMessage(originalTask),
        stuckContinuations: 0,
        budgetContinuations: 0,
        unacceptedContinuations: input.unacceptedContinuations + 1,
      };
    }
    return { action: 'stop', reason: remaining.length === 0 && todos.length > 0 ? 'goal met (checklist complete)' : 'no plan to pursue' };
  }

  // --- Pending todos (or a resumable step-cap pause) → keep going.
  return {
    action: 'continue',
    kind: result.paused ? 'paused' : 'todos',
    reason: result.paused ? 'step-cap pause mid-task' : `${remaining.length} todo(s) left`,
    message: autoContinueMessage(remaining, originalTask),
    difficulty: stepDifficultyFor(remaining[0]),
    stuckContinuations: 0,
    budgetContinuations: 0,
    unacceptedContinuations: input.unacceptedContinuations,
  };
}

/** Headless multi-round executor: runTurn rounds driven by decideStepRound until the checklist
 *  is accepted (or a cap/abort stops the run). This is what gives non-UI callers — a future CLI,
 *  scripts, tests — the same step-wise, verify-gated autonomy the chat has: rounds route by the
 *  executing step's difficulty, stalls get a different model, and a "completed" checklist whose
 *  verify command still fails is not accepted. The continuation transcript is returned, not
 *  pushed anywhere. */
export interface StepTaskConfig {
  maxRounds?: number;
  maxStuckContinuations?: number;
  maxBudgetContinuations?: number;
  maxUnacceptedContinuations?: number;
  originalTask?: string;
  /** Abort check between rounds (defaults to the opts abortSignal). */
  isActive?: () => boolean;
}

export interface StepTaskResult {
  result: AgentResult;
  /** Number of runTurn rounds executed (≥1). */
  rounds: number;
  /** The checklist as last written this task ([] when the model never called todowrite). */
  todos: TodoItem[];
  /** Continuation messages the engine pushed between rounds (empty for a one-round task). */
  continuationMessages: ChatMessage[];
}

export async function runStepTask(router: Router, opts: AgentOpts, cfg: StepTaskConfig = {}): Promise<StepTaskResult> {
  const maxRounds = cfg.maxRounds ?? 25;
  const maxStuck = cfg.maxStuckContinuations ?? 1;
  const maxBudget = cfg.maxBudgetContinuations ?? 1;
  // Default 2 (own setting — a failing verify is more recoverable than a stall; see package.json).
  const maxUnaccepted = cfg.maxUnacceptedContinuations ?? 2;
  const isActive = cfg.isActive ?? (() => !opts.abortSignal?.aborted);

  // Todos written during THIS task only — replaces-wholesale semantics match the todowrite
  // tool; forwarded to the caller's own onTodos so a UI (or test) still sees live updates.
  let todos: TodoItem[] = [];
  const onTodos = (list: TodoItem[]): void => {
    todos = list;
    opts.onTodos(list);
  };

  let current: AgentOpts = { ...opts, onTodos, mode: 'agent' };
  let result = await runTurn(router, current);
  const continuationMessages: ChatMessage[] = [];

  let stuck = 0;
  let budget = 0;
  let unaccepted = 0;
  for (let round = 1; round < maxRounds && isActive(); round++) {
    const decision = decideStepRound({
      todos,
      result,
      originalTask: cfg.originalTask,
      stuckContinuations: stuck,
      maxStuckContinuations: maxStuck,
      budgetContinuations: budget,
      maxBudgetContinuations: maxBudget,
      unacceptedContinuations: unaccepted,
      maxUnacceptedContinuations: maxUnaccepted,
      allowModelExclusion: !opts.pinnedModel,
    });
    if (decision.action === 'stop') break;
    stuck = decision.stuckContinuations;
    budget = decision.budgetContinuations;
    unaccepted = decision.unacceptedContinuations;
    const msg: ChatMessage = { role: 'user', content: decision.message };
    continuationMessages.push(msg);
    current = {
      ...current,
      messages: [...current.messages, msg],
      stepDifficulty: decision.difficulty,
      excludeModels: decision.excludeModels,
    };
    result = await runTurn(router, current);
  }

  return { result, rounds: 1 + continuationMessages.length, todos, continuationMessages };
}
