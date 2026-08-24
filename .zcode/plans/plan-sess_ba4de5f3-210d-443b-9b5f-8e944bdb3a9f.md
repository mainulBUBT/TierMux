# TierMux — Simple Core Reset (execution engine, not answer-policing engine)

**Decision:** Keep Vercel AI SDK. Reset the turn loop to a simple execution model. Not a capability rewrite — a removal of the judgment/heuristics tower.

**Commit boundaries:** `pre-simple-core` (tag) → `simple-core` → `simple-core-e2e` → `cleanup-judgment-machinery`. Never mix cleanup into the core rewrite, so core-rewrite breakage and legacy-removal breakage stay distinguishable.

## Step 0 — Safety
`git tag pre-simple-core` before touching the core.

## Step 1 — Slim system prompt (`src/agent/promptBuilder.ts`)
Add `buildSimpleSystemPrompt(mode)`, intentionally small:
- Identity (~3 lines: what the agent is, what it can do)
- Mode tail (~10 lines: mode capabilities, tool usage, ground claims in what was read this turn, ask only when genuinely blocked)
- Dynamic context: today's date, project profile, user memory, project rules
- Removed from live prompt: behavior.md, research.md, skills index, findings, terse tail (files stay on disk as infrastructure)

## Step 2 — Rewrite core loop (`src/agent/core/loop.ts`, ~3,000 → ≤350 lines)
Same public signature + `AgentResult` contract — no unnecessary rewrite elsewhere.
```
lastUserText → classifyTaskCore() (regex ONLY — no LLM fallback, no planner, no reclassification)
→ createRouterProvider() (rotation/429/transport/cooldown/scoring intact — infra, not judgment)
→ buildSimpleSystemPrompt()
→ createToolSet() (COMPLETE toolset: delegate, explore, implementPipeline, editFile, createFile, all native tools)
→ streamText({ model, system, messages, tools, abortSignal,
    stopWhen: [stepCountIs(50), askQuestionsStop],
    prepareStep: pruneCascade, toolApproval, repairToolCall })
→ collect result (workMessages, changedFiles, todos, askQuestions)
```

## Steps 3–4 — Transcript is the source of truth; cross-model continuity
- ONE history: neutral `CoreMessage[]` (user/assistant/tool-calls/tool-results). No competing semantic histories (no model-A/model-B/planner/judge/synthesis histories). SDK normalizes dialects; every model sees the actual execution history.
- Keep: `workMessages` accumulation, condense's "Continued from a previous model: X" stamp, `fitMessages` for window mismatches, router rotation.

## Steps 5–6 — Mechanical provider failover (exactly ONE continuation)
Only for: provider execution failed before task completed. NOT judgment of the answer.
```
streamText() → provider failure → exclude failed model → fresh router pick
→ [...messages, ...workMessages] → fitMessages() → streamText() ONCE → done
```
The replacement model receives user request + prior assistant output + tool calls + tool results + accumulated work — that IS the continuity proof. No A→B→C→D→E ladder, no behavioral/quality/escalation retries.
**Abort ≠ provider failure:** an abortSignal abort must NOT trigger this path.

## Step 7 — Architectural rule: execution vs judgment
Loop MAY: execute tools/models, preserve/prune/condense/fit context, rotate providers, recover from provider failure, enforce approvals + tool safety, stop at hard execution limits, collect results.
Loop MUST NOT: judge answer quality, detect narration and force action, retry on weak/incomplete-looking output, synthesize a second answer, force tool calls, escalate on answer quality, semantically decide the model "failed", manufacture extra task steps.
**Mechanical execution recovery allowed. Semantic answer judgment never.**

## Step 8 — Delete the judgment tower
LLM classify fallback (keep regex) · mixture planner · narrationWall + detectors · force-action nudges · behavioral same-model retry · Auto failover ladder (replaced by the single mechanical continuation) · answer judge + escalation · forced synthesis + SYNTH suffixes · stuck/budget/exploration stops · repeat reminders · script-salad detector. Termination comes from SDK execution boundaries + `stepCountIs(50)`.

## Step 9 — Remains in the loop
sanitize · prune + re-anchor · tool circuit breaker · approvals · todo handling · askQuestions/question detection · changedFiles · workReport · delegate/explore/implementPipeline · multi-file tools · Router.

## Step 10 — `src/chatViewProvider.ts`
Delete dead branches: auto-continue ladder, budget compaction recovery, narration-stop resumable flow. Keep untouched: memory, rules, active editor, diagnostics, @mentions, resume context, session persistence. Chat view stays the UI/session layer.

## Steps 11–14 — New e2e harness (`scripts/simpleTurn.e2e.ts` + package script)
- **Test A basic:** stream → native tool call → tool result → model sees result → final answer; AgentResult compatible
- **Test B abort:** abort mid-stream → execution stops, no accidental continuation, clean AgentResult, NO failover triggered
- **Test C askQuestions:** question → turn ends. Question is a legitimate terminal state — no auto-continuation, no forced answer
- **Test D failover continuity (most important):** Provider A: assistant → tool_call → tool_result → provider failure. Provider B receives user request + A's transcript + tool result → completes. **Assert B continues using something that exists ONLY in A's transcript/tool result** — proving continuity, not just rotation.

## Step 15 — Cleanup commit (after core + e2e green)
Retire suites + entries: repeat-guard, self-correct, verify-gate, planner-gate, step-routing, budget-nudge, deflection-repro, false-capability-decline, task-sim, human-sim, complex-task; trim prompt-contract. Remove dead settings (`mixturePipeline`, `plannerGate`, `stepRouting`, `maxTurnTokens`, `maxExplorationCalls`, `terseReplies`, …) — each only after references confirmed dead.

## Step 16 — Capability wishlist preserved (no capability regression)
Tools (multi-file editFile/createFile, implementPipeline, worktrees) · sub-agents (delegate, explore) · context (active editor, diagnostics, mentions, profile) · memory (memory.md, rules, auto-condense) · tokens (caps, prune + re-anchor, condense, fitMessages, cache-ordered prompts) · Router auto mode (rotation, cooldown, scoring, 429, transport errors) · continuity (workMessages, CoreMessage transcript, condense stamp, fitMessages, mechanical continuation).

## Step 17 — Accepted by design
"Weak model narrates instead of acting" ships as the answer. The harness never decides "should have acted, therefore retry". If a failure pattern becomes serious, ONE small evidence-driven guard later — never the tower again.

## Steps 18–19 — Verification
1. `npm run typecheck`
2. Infra suites: condense-split, fit-messages, scoring, circuit, rotation, cooldown, prune-threshold, edit-match, tool-history, compact-result, output-limit
3. New simple-turn e2e green: tool→answer · abort · askQuestions · provider failure → fresh model → full transcript survives → replacement completes the task
4. Manual Extension Development Host smoke: one Agent task with delegated sub-task + multi-file edit — delegation works, sub-agent works, files changed + reported, session persists, memory/rules apply, NO auto-continue/narration-detector/forced-synthesis behavior appears.

**Core invariant:** The AI SDK handles the model loop. The Router handles selection + mechanical rotation. The transcript handles continuity. The tools do the work. Memory/rules/context provide grounding. The loop coordinates and handles mechanical failures. Nothing in the core loop decides whether the model's answer was "good enough".