
// First-class plan execution: an approved plan runs step-by-step through the existing
// headless step engine (runStepTask), so every step gets its own rounds, continuation
// rules, and verify-acceptance — instead of the old "re-send the whole plan as one chat
// message and hope" path. Pure engine logic: no vscode, no UI posting, no persistence —
// the provider owns those effects via the config callbacks.
//
// SAFETY INVARIANT (deliberate, mirrors the runTurn escalation rule): a step that fails
// verification is retried on the SAME routing constraints as its first attempt — no
// excludeModels, no intelligence-rank boost, no other failure-driven model switch. The
// only cross-model call allowed here is `repairSteps`: a READ-ONLY planner pass that may
// rewrite the remaining steps (planning, not execution), exactly like the mixture
// pipeline's planner. Verification failure must never become an implicit model escalation.

import type { ChatMessage, PlanRunState, PlanStep, TodoItem } from '../../shared/types';
import type { AgentOpts, AgentResult } from '../agent';
import type { Router } from '../../router/router';
import { inferStepDifficulty } from '../stepDifficulty';
import { runStepTask } from './stepEngine';

export interface PlanRunnerConfig {
  /** Attempts per step (first try + verify-failure retries). Default 2. */
  maxStepAttempts?: number;
  /** Total read-only plan repairs allowed across one run. Default 2. */
  maxPlanRepairs?: number;
  /** Consecutive unrecoverable steps before the run gives up. Default 2. */
  maxConsecutiveFailedSteps?: number;
  /** maxRounds handed to each step's runStepTask. Default 8. */
  stepRounds?: number;
  /** Read-only planner repair: given the failure output and the remaining steps, return a
   *  rewritten step list (or null to keep going without a repair). Supplied by the caller. */
  repairSteps?: (failureOutput: string, remainingSteps: string[]) => Promise<string[] | null>;
  /** Abort check between steps (defaults to the abort signal on opts). */
  isActive?: () => boolean;
  /** Called after every state mutation — the provider persists + posts to the webview. */
  onState?: (state: PlanRunState) => void;
  /** The plan checklist as todos — re-emitted after each step so the plan stays the live
   *  contract even though the model may write its own sub-todos mid-step. */
  onTodos?: (todos: TodoItem[]) => void;
  /** Per-step transcript appends (step prompt + step summary) so the caller can persist
   *  them into session history for cross-step context and resume-after-reload. */
  onHistory?: (messages: ChatMessage[]) => void;
}

export interface PlanRunResult {
  state: PlanRunState;
  /** Human-readable final summary (also the last thing appended to history). */
  summary: string;
  lastResult?: AgentResult;
}

const RETRY_FAILURE_CHARS = 3000;

/** Map the plan steps to the todo-list shape (pending/in_progress/completed) for the UI. */
export function planTodos(state: PlanRunState): TodoItem[] {
  return state.steps.map((step) => ({
    content: step.text,
    status: step.status === 'done' ? 'completed'
      : step.status === 'in_progress' ? 'in_progress'
        : 'pending',
    difficulty: inferStepDifficulty(step.text),
  }));
}

function stepPrompt(state: PlanRunState, index: number): string {
  const done = state.steps.slice(0, index)
    .filter((st) => st.status === 'done')
    .map((st, i) => `${i + 1}. ${st.text}`);
  const remaining = state.steps.slice(index + 1)
    .filter((st) => st.status === 'pending')
    .map((st) => `- ${st.text}`);
  const lines = [
    `[Plan execution — step ${index + 1} of ${state.steps.length}]`,
    state.steps[index].text,
    '',
    `Original task: ${state.originalTask}`,
  ];
  if (done.length) lines.push('', `Already completed steps:\n${done.join('\n')}`);
  if (remaining.length) lines.push('', `Later steps (do NOT do them now):\n${remaining.slice(0, 6).join('\n')}${remaining.length > 6 ? `\n- … (+${remaining.length - 6} more)` : ''}`);
  lines.push(
    '',
    'Execute ONLY this step, fully. The plan checklist is already tracked for you — use the',
    'todowrite tool only for sub-tasks within this step. Verify your work before finishing',
    '(run the project verify command / check diagnostics); a step is not done while it fails.',
  );
  return lines.join('\n');
}

/** The verify-failure retry note: same model, same routing — only the failure is new input. */
function retryPrompt(step: PlanStep, failureOutput: string): string {
  const clipped = failureOutput.slice(-RETRY_FAILURE_CHARS);
  return [
    `[Plan step retry — attempt ${step.attempts + 1}]`,
    `The previous attempt at "${step.text}" left verification FAILING:`,
    '',
    '```',
    clipped,
    '```',
    '',
    'Fix the failures so this step actually passes (same plan, same files). Do not restart',
    'the plan and do not skip ahead to later steps.',
  ].join('\n');
}

function mutate(state: PlanRunState, cfg: PlanRunnerConfig): void {
  state.updatedAt = Date.now();
  cfg.onState?.(state);
}

/**
 * Drive an approved plan to completion (or a bounded stop). Each step runs through
 * runStepTask with identical routing constraints on every attempt; a verify failure earns
 * one same-model retry with the failure output injected, then possibly one read-only plan
 * repair, then the step is marked failed and the run continues (two consecutive failed
 * steps stop the run). Steps marked `skipped`/`failed` are never re-run on resume.
 */
export async function runPlan(router: Router, opts: AgentOpts, state: PlanRunState, cfg: PlanRunnerConfig = {}): Promise<PlanRunResult> {
  const maxStepAttempts = cfg.maxStepAttempts ?? 2;
  const maxPlanRepairs = cfg.maxPlanRepairs ?? 2;
  const maxConsecutiveFailed = cfg.maxConsecutiveFailedSteps ?? 2;
  const stepRounds = cfg.stepRounds ?? 8;
  const isActive = cfg.isActive ?? (() => !opts.abortSignal?.aborted);

  const messages: ChatMessage[] = [...opts.messages];
  let consecutiveFailed = 0;
  let lastResult: AgentResult | undefined;
  // Work-Report tallies for the final summary: per-step verification outcomes.
  let verifiedSteps = 0;
  let untestedSteps = 0;

  const emitTodos = (): void => cfg.onTodos?.(planTodos(state));

  /** Work-Report-style stats line for the final summary — same honest shape as the
   *  end-of-turn report in loop.ts: verified vs untested is the difference between
   *  "resolved" and "not confirmed resolved". */
  const statsLine = (): string => {
    const total = state.steps.length;
    const done = state.steps.filter((st) => st.status === 'done').length;
    const parts = [`${done}/${total} step(s) done`];
    if (verifiedSteps) parts.push(`✅ ${verifiedSteps} verified`);
    if (untestedSteps) parts.push(`⚠️ ${untestedSteps} untested`);
    return parts.join(' · ');
  };

  for (let i = state.currentStep; i < state.steps.length; i++) {
    if (!isActive()) {
      if (state.status === 'running') { state.status = 'paused'; mutate(state, cfg); }
      return { state, summary: `Plan paused at step ${i + 1}/${state.steps.length}.`, lastResult };
    }
    const step = state.steps[i];
    if (step.status !== 'pending') continue; // already done/failed/skipped on a resumed run

    state.currentStep = i;
    step.status = 'in_progress';
    step.attempts += 1;
    mutate(state, cfg);
    emitTodos();

    // Same routing constraints on every attempt — difficulty comes from the step text via the
    // normal step-routing policy, never from the failure (see the invariant at the top).
    const runOnce = async (userText: string): Promise<AgentResult> => {
      const stepOpts: AgentOpts = {
        ...opts,
        messages: [...messages, { role: 'user', content: userText }],
        stepDifficulty: inferStepDifficulty(step.text),
        mode: 'agent',
      };
      const stepResult = await runStepTask(router, stepOpts, { originalTask: state.originalTask, maxRounds: stepRounds });
      return stepResult.result;
    };

    const prompt = stepPrompt(state, i);
    let result = await runOnce(prompt);
    lastResult = result;
    messages.push({ role: 'user', content: prompt });
    messages.push({ role: 'assistant', content: result.text || '(step produced no summary)' });
    cfg.onHistory?.([
      { role: 'user', content: prompt },
      { role: 'assistant', content: result.text || '(step produced no summary)' },
    ]);

    // Verify-failed retry: same model, same constraints, failure output injected.
    if ((result.verifyOutcome === 'failed' || result.failed) && step.attempts < maxStepAttempts && isActive()) {
      step.attempts += 1;
      mutate(state, cfg);
      const failureOutput = result.verifyOutcome === 'failed'
        ? `${result.text || ''}`
        : (result.errorMessage || result.text || 'the attempt errored');
      const retry = retryPrompt(step, failureOutput);
      result = await runOnce(retry);
      lastResult = result;
      messages.push({ role: 'user', content: retry });
      messages.push({ role: 'assistant', content: result.text || '(retry produced no summary)' });
      cfg.onHistory?.([
        { role: 'user', content: retry },
        { role: 'assistant', content: result.text || '(retry produced no summary)' },
      ]);
    }

    const stepFailed = result.verifyOutcome === 'failed' || result.failed === true;

    // Read-only plan repair: rewrite the remaining steps around what actually failed.
    if (stepFailed && state.repairs < maxPlanRepairs && cfg.repairSteps && isActive()) {
      const remaining = state.steps.slice(i).filter((st) => st.status === 'pending' || st === step).map((st) => st.text);
      const repaired = await cfg.repairSteps(
        `Plan step failed verification twice.\nStep: ${step.text}\nLast attempt output:\n${(result.text || result.errorMessage || '').slice(0, RETRY_FAILURE_CHARS)}`,
        remaining,
      );
      if (repaired && repaired.length) {
        state.repairs += 1;
        const rebuilt: PlanStep[] = repaired.slice(0, 20).map((text, k) => k === 0
          ? { text, status: 'pending', attempts: 0 }
          : { text, status: 'pending', attempts: 0 });
        // Keep finished steps, replace everything from the failing step onward.
        state.steps = [...state.steps.slice(0, i), ...rebuilt];
        const repairNote = `[Plan repaired — remaining steps rewritten by the planner]\n${state.steps.slice(i).map((st, k) => `${k + 1}. ${st.text}`).join('\n')}`;
        messages.push({ role: 'user', content: repairNote });
        messages.push({ role: 'assistant', content: 'Understood — continuing with the repaired steps.' });
        cfg.onHistory?.([{ role: 'user', content: repairNote }]);
        mutate(state, cfg);
        i -= 1; // re-enter the loop at the rewritten failing step (as a fresh pending step)
        continue;
      }
    }

    if (stepFailed) {
      step.status = 'failed';
      consecutiveFailed += 1;
      mutate(state, cfg);
      emitTodos();
      if (consecutiveFailed >= maxConsecutiveFailed) {
        state.status = 'failed';
        mutate(state, cfg);
        const summary = `Plan stopped: step ${i + 1} ("${step.text.slice(0, 120)}") failed verification after ${step.attempts} attempt(s) — the issue is NOT resolved for this step. Fix it manually or ask to re-plan. (${statsLine()})`;
        return { state, summary, lastResult };
      }
      continue; // move on to the next step — one failed step doesn't sink the plan
    }

    step.status = 'done';
    if (result.verifyOutcome === 'passed') verifiedSteps += 1; else untestedSteps += 1;
    consecutiveFailed = 0;
    state.currentStep = i + 1;
    mutate(state, cfg);
    emitTodos();
  }

  state.status = 'done';
  mutate(state, cfg);
  emitTodos();
  const failedSteps = state.steps.filter((st) => st.status === 'failed');
  const summary = failedSteps.length
    ? `Plan finished with ${failedSteps.length} failed step(s): ${failedSteps.map((st) => st.text.slice(0, 60)).join('; ')} — those are NOT resolved. (${statsLine()})`
    : `Plan completed — ${statsLine()}.`;
  return { state, summary, lastResult };
}
