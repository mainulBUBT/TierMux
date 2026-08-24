# The Simple Core Reset (2026-08-24)

> **Audience:** any agent (or human) working on this repo after 2026-08-24. Read this before
> touching `src/agent/core/loop.ts`, adding a "quality" retry, or reviving a detector. It
> documents what the reset removed, what it kept, the invariants that must survive, and how to
> verify all of it.

## TL;DR — before / after

| | Before (`pre-simple-core` tag) | After |
|---|---|---|
| Turn engine | ~3,080-line loop: classify (LLM fallback) → mixture planner → attempt → narration/action/pasted/permission detectors → force-action nudges → same-model retries → Auto failover ladder → answer judge → escalation → forced synthesis → verify-fix rounds → plan repair | ~1,050-line file (turn logic ~350): ONE `streamText()` call; SDK owns the model loop |
| System prompt | ~6KB scaffolding tower (behavior.md 130 lines + research.md + skills + findings + terse tail) | `buildSimpleSystemPrompt()`: identity + ~10-line mode tail + today + project profile + memory + rules (~1.5KB) |
| Who judges the answer | The harness (detectors, judges, escalation) | **Nobody.** The model's answer ships. |
| Failure recovery | Behavioral retry ladder (A→B→C…) | Exactly ONE mechanical continuation on provider failure, transcript carried over |
| History | Competing semantic views (planner/judge/synthesis contexts) | ONE neutral `CoreMessage[]` transcript — source of truth |

Net: **−5,300 lines**. Rollback at any time: `git reset --hard pre-simple-core`.

## The architectural rule (enforce it in review)

**`src/agent/core/loop.ts` is a MECHANICAL EXECUTION ENGINE. It never judges.**

The loop MAY:
- execute tools and models
- preserve / prune / condense / fit context
- rotate providers (via the Router)
- recover from provider failures (exactly ONE continuation)
- enforce approvals and tool safety
- stop at hard execution limits (`stepCountIs(50)`, `askQuestionsStop`)
- collect results

The loop MUST NOT:
- judge whether an answer is "good enough"
- detect "narration" and force action
- retry because output looks weak or incomplete
- synthesize a second answer because the first seems bad
- force a particular tool call
- escalate based on answer quality
- decide the model "failed" semantically
- manufacture additional task steps

**Mechanical execution recovery is allowed. Semantic answer judgment is never.**

If a real failure shape recurs, the rule is: add ONE small, evidence-driven guard — cite the
live repro in its comment — never rebuild a tower. If you find yourself adding a second
detector, stop and re-read this file.

## Invariants (each is test-locked — don't break them)

1. **Transcript is the source of truth.** ONE neutral `CoreMessage[]` history. Every model
   sees the actual execution history (SDK normalizes dialects). No per-model, planner, judge,
   or synthesis histories may be introduced.
2. **Cross-model continuity.** On a provider failure mid-task, the replacement model receives
   `[...messages, ...workMessages]` fitted via `fitMessages()` — user request, prior assistant
   output, tool calls, tool results. Proven by `simpleTurn.e2e.ts` Test D (a secret that exists
   ONLY in the failed model's tool result must appear in the replacement's request).
3. **Exactly ONE continuation.** Initial execution → provider failure → one continuation →
   stop. No ladder, no behavioral retries, no answer-quality retries.
4. **An abort is not a failure.** `isAbortError` + aborted signal ⇒ clean stop; it must never
   trigger the mechanical continuation (Test B).
5. **`askQuestions` is a legitimate terminal state.** The questions ARE the response; the turn
   ends; no auto-continuation, no forced answer (Test C).
6. **The incremental stream transcript must survive stream errors.** The AI SDK's `steps`
   promise REJECTS when the stream errors mid-step — a pre-reset gap that lost a failed
   attempt's tool results. `streamWork` (collected part-by-part in the stream loop) is the
   fallback; keep it.
7. **A step-cap hit is a resumable pause, not a terminal stop.** `finishReason === 'max-steps'`
   ⇒ `paused: true` ⇒ the UI's Continue/Resume affordance.
8. **Verify runs ONCE as observation.** After a mutating turn, the project's verify command
   runs a single time; the outcome feeds the WorkReport honestly ('passed' / 'failed' /
   'unverified'). No fix rounds, no plan repair inside the loop. (Plan-mode execution keeps
   ITS OWN retry + repair in `planRunner.ts` / `stepEngine.ts` — that is plan mechanics, not
   answer judgment.)

## What was kept (do not "clean these up")

- **Sub-agents & multi-file:** `delegate`, `explore`, `implementPipeline` (parallel worktrees),
  `editFile`/`createFile`/`writeFile`, full `createToolSet`
- **Router:** rotation, 429 handling, cooldowns, scoring, Auto mode (`createRouterProvider`)
- **Memory/context:** memory.md, project rules, session persistence, between-turn auto-condense
  (`condense.ts`), active-editor + diagnostics injection, @mentions, deterministic project
  profile, continue/resume context
- **Token saving:** per-result output caps, `prepareStep` prune + re-anchor (`blankStaleToolResults`,
  `AnchorStore`), `fitMessages`, cache-ordered prompt assembly (stable → volatile)
- **SDK-native mechanics:** `stopWhen` `[isStepCount(50), askQuestionsStop]`, `toolApproval`
  (createToolApproval), `repairToolCall` (3-tier incl. `tryModelRepair`), tool circuit breaker
- **UI contract:** `AgentResult` unchanged; `workReport` (ResultCard), `changedFiles`, todos,
  watchdog/telemetry wrapping

## What was deleted (do not resurrect without a live repro)

LLM classify fallback (regex `classifyTaskCore` remains) · mixture planner + todo seeding ·
`narrationWall` + all action/pasted/permission/decline detectors · force-action nudges ·
behavioral same-model retry + Auto failover ladder · answer judge (`fulfillment.ts` — file
deleted) · escalation · forced synthesis + SYNTH suffixes + `shrinkForSynthesis` ·
stuck/budget/exploration stops · repeat reminders · script-salad detector · verify-fix rounds
+ in-loop plan repair · LLM change recap · terse-replies tail · chatViewProvider's autonomous
continuation ladder, budget-stop compaction recovery, narration-stop resumable flow.

`behavior.md` / `research.md` / skills index / findings remain ON DISK as infrastructure
(the legacy `buildSystemPrompt` path still compiles and some suites use it) — they are simply
not in the live prompt.

## How to verify (run these after any loop change)

```bash
npm run typecheck
npm run test:e2e:simple-turn   # THE contract: tool→answer · abort · askQuestions · failover continuity
npm run test:e2e:core          # approval gating, event ordering, approval-once
npm run test:e2e:plan-runner   # plan execution: retry + repair under the simple core
npm run test:e2e:step-executor # stepEngine decisions + acceptance
npm run test:e2e:prompt-contract  # slim prompt per mode; tower absent
npm run test:e2e:prompt-diet      # live prompt pinned < 2.5K chars
# infra: condense-split, fit-messages, scoring, circuit, rotation, cooldown-recovery,
#        prune-threshold, edit-match, tool-history, compact-result, output-limit, …
```

All 63 suites green as of `a49eb5b`.

## Commit map

```
pre-simple-core (tag) ─ rollback point
dd8be42  simple-core              core rewrite + slim prompt + dead chatView branches
1a18cf3  simple-core-e2e          the 17-assertion execution-contract harness
7049b99  cleanup-judgment-machinery   14 suites retired, 12 dead settings removed
a49eb5b  plan-runner align + dead fulfillment judge removed
```

## Accepted trade-off (this is intentional, not a bug)

A weak model may answer "Sure, you should inspect X and Y…" instead of editing, and that
narration SHIPS as the answer. The harness does not decide "this model should have acted,
therefore retry." If users report a recurring failure shape, gather a live repro first, then
add ONE targeted guard citing it. The tower is gone; keep it gone.
