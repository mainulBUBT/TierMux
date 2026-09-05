# Agent reliability plan — 2026-09-05

**No new features.** Every item below makes something that already exists actually work, or
deletes something that pretends to.

The autonomous agent's job is: take a task, run tools until it is done, and tell the truth
about what happened. Each tier below is ordered by how badly it breaks that sentence.

Verify each tier with `npm run test:e2e:foundation` plus the suites in
[SIMPLE_CORE_RESET_2026-08-24.md](SIMPLE_CORE_RESET_2026-08-24.md).

---

## Tier 0 — the agent gives up and does not say so

These are autonomy killers: the run stops, and neither the model nor the user learns why.

### 0.1 Hitting the step cap is invisible — DONE 2026-09-05

`stopWhen: [stepCountIs(50), planAccepted]` ([engine.ts:373](../src/agent/core/engine.ts#L373))
ends the turn, but nothing records that the CAP is what ended it. `paused: true` is set in
exactly one place in the whole engine — the abort-before-any-output path
([engine.ts:473](../src/agent/core/engine.ts#L473)). So a 50-step turn that was mid-task ends
looking exactly like a turn that finished.

The host's Continue affordance is
`resumable = !hasQuestions && !result.failed && (result.paused || finalRemainingTodos.length > 0)`.
A capped turn that never wrote todos therefore gets **no Continue button and no explanation** —
the single worst autonomous failure mode, because the user cannot tell "done" from "gave up".

**Fix.** In `onEnd`, compare `steps.length` against the cap and set `paused: true` plus a
`stopReason` when they match. Surface a one-line notice ("stopped at the 50-step limit —
Continue to keep going"). Wire `tiermux.agent.maxStepsPerTurn` (declared, default 50, currently
never read — see 2.4) to the same constant so the cap is one number, not two.

**Done 2026-09-05.** `onEnd` sets `hitStepCap` when the cap fires *while tool calls are still
in flight* (a model that lands its final answer exactly on step `maxSteps` also satisfies
`stepCountIs`, and that turn IS complete). The turn returns `paused: true` +
`stopReason: 'budget'`, so the host's Continue button appears, and `stopReasonNote` prints a
deterministic footer naming the limit and pointing at the setting.
`tiermux.agent.maxStepsPerTurn` is now threaded through `AgentOpts` — like `toolCompaction`,
so `core/` stays vscode-free — and surfaced in the settings UI. Gate scenarios 26/26b.

### 0.2 Nothing detects a no-progress loop — DONE 2026-09-05

There is no repetition guard anywhere in `src/agent/core/`. A model that gets
`"Search text not found in file."` can re-issue the identical `editFile` call until the step
cap eats the turn — 50 model calls against a free tier for zero work. Combined with 0.1 the
user then sees a turn that just... ends.

`AgentResult.stopReason` already documents this exact case — `'budget' | 'stuck'`, described as
"stuck repeating/thrashing" ([agent.ts:40](../src/agent/agent.ts#L40)) — and is **never
assigned by anything**. The contract was written for a loop that no longer exists (see 2.3).

**Fix — one mechanical guard, no judgement.** Hash `(toolName + JSON.stringify(input))` per
step. If the same hash occurs N times (start at 3) **and** the tool returned an error each
time, stop the turn with `stopReason: 'stuck'` and `paused: true`. This is a wire-level fact —
identical bytes in, error out, N times — not an opinion about answer quality, so it satisfies
the SIMPLE_CORE_RESET rule. Cite this document as the repro.

**Done 2026-09-05.** A `notMakingProgress` StopCondition — not an abort, so the current step
finishes cleanly and the transcript stays intact. `onStepEnd` counts `toolName + JSON(input)`
signatures whose result is a failure, where "failure" covers BOTH shapes: the SDK's tool-error
state and the v3 contract's `{ error }` return, which the SDK reports as an ordinary json
result. Missing that second shape is why a failing tool was invisible to everything.

Three consecutive identical failures ⇒ `stopReason: 'stuck'`, `paused: true`, and a footer.
Any successful tool result clears the WHOLE table, not just the matching signature —
deliberately conservative, because a model that failed twice, made progress, then failed the
same call again is recovering, not thrashing. Gate scenario 27b caught the per-signature
version doing exactly that false positive. Cost: a strict fail/succeed/fail alternation never
trips this, and the step cap remains the backstop. A wrong stop is worse than a late one.

---

## Tier 1 — the agent cannot recover from its most common failure

### 1.1 Edit-failure messages are dead ends — DONE 2026-09-05

`applyHunk` fails with exactly two strings
([editMatch.ts:52](../src/agent/core/tools/v3/editMatch.ts#L52)):

- `"Search text not found in file."`
- `"Search text matches multiple locations in file — include more surrounding context to make it unique."`

Neither tells the model **what is actually in the file**, and with the multi-hunk `edits: [...]`
form neither says **which hunk** failed — `editFile` returns the bare string for whatever hunk
broke ([editFile.ts:86](../src/agent/core/tools/v3/editFile.ts#L86)). A model handed
"not found" with five hunks in flight has nothing to correct toward, so it guesses, and 0.2
turns the guess into a loop.

**Fix.** Three cheap, deterministic additions to the error payload:

1. **Hunk index** — `Hunk 3 of 5 could not be applied:` prefix. Pure bookkeeping.
2. **Nearest-line report** — the search block's first non-blank line already drives a line scan
   in `locateFlexible`; on failure, report the closest line(s) by trimmed-prefix match with
   their line numbers. "Nothing matched. Closest: line 214 `const x = compute(a, b)`".
3. **Whitespace hint** — when a trimmed match exists but the raw one does not, say so
   explicitly ("matched ignoring indentation at line 214 — your `search` indentation differs").

All three are text-only, live in `editMatch.ts`, and need no vscode. This is the single highest
leverage change in this document: edit failure is the most frequent tool failure an autonomous
coding agent hits.

**Done 2026-09-05.** `editMatch.ts` now reports, deterministically and with no fuzzy scoring:
the hunk index and that nothing was written (`editFile.ts`); the match count and line numbers
for an ambiguous hunk; and for "not found", one of three ranked diagnoses — the block diverged
(naming the line and quoting both sides), the lines exist but not consecutively (stale
context), or nothing of the search is in the file at all (wrong path). Bounded at ~200 chars.

`editMatch.e2e.ts` also moved OFF `src/edits/applyEdit.ts` — it had been testing the legacy
matcher kept alive for inlineChat, so every assertion was green against code the agent never
runs. Two of its assertions pinned old wording rather than behaviour and were rewritten.

### 1.2 Tool-output aging elides the read the edit depends on — DONE 2026-09-05

`ageToolOutputs` stubs every earlier tool output over the threshold, `readFile` included
([compact.ts:136](../src/agent/core/compact.ts#L136)). Only the MOST RECENT tool message
survives verbatim. The common autonomous pattern is read A → read B → edit A, and by the edit
step A's content is a stub — while `editFile.search` must match A byte-for-byte.

Aging is correct in principle (free gateways do not prompt-cache; a 20-round-trip turn re-pays
for every char) and the path-naming fix on 2026-09-05 restored the "re-run the tool" escape
hatch. The remaining gap is the window size.

**Fix (one constant).** Keep the last **three** tool messages verbatim instead of the last one.
Cost is bounded and small — three steps of output; benefit is that read→read→edit stops
straddling the elision boundary. Do not add a per-tool exemption list; that is a tower.

**Done 2026-09-05.** `KEEP_RECENT_TOOL_MESSAGES = 3`; the boundary is the oldest of the three,
found by walking backwards. No per-tool exemption list. `tool-output-aging` gained the
read→read→edit fixture (the first read must survive to the edit step) and a "window not yet
full" case; the older fixtures had only two tool messages, so they were silently asserting
nothing under the new window and were widened to four.

---

## Tier 2 — advertised safety nets that do not exist

Everything here is worse than a missing feature: the UI, the settings, and the type contracts
all promise it, so nobody notices it is absent.

### 2.1 Verify-after-edit is fully built and never called — WIRED 2026-09-05

`src/agent/core/tools/workspace/verifyCommand.ts` is 296 LOC implementing detection and
execution of a project verify command. `runVerifyCommand` and `resolveVerifyCommand` have
**zero callers** — only `detectVerifyCommand` is used, by `projectProfile.ts`, for prompt
context. Meanwhile two settings advertise the behaviour to users:

- `tiermux.agent.verifyCommand` (default `"auto"`) — "run automatically after a turn edits
  files, a non-zero exit triggers bounded fix-and-recheck rounds"
- `tiermux.agent.verifyFixRounds` (default `2`) — never read anywhere

For an autonomous agent this is the difference between "I edited 6 files" and "I edited 6 files
and the tests still pass". **Decide and act:**

- **Wire it** (preferred): after a turn that mutated files, run the resolved command; on
  non-zero, feed the output back for up to `verifyFixRounds` rounds; set `verifyOutcome`.
- **Or delete it**: remove the file, both settings, and `AgentResult.verifyOutcome`.

**Wired 2026-09-05.** The gate runs in `engine.ts` after the turn settles, bounded three ways:
only when the turn actually MUTATED files, only in agent mode (a plan proposes and ask answers
— neither owns a build), and at most `verifyFixRounds` extra model calls. An abort or a `stuck`
stop skips it; `ok: null` (could not run) is "no signal", never a failure. On non-zero exit the
output is fed back with an instruction to fix the cause and stop — the command is re-run
automatically, so the model never re-runs it itself.

Mechanical, not a quality judgement: it runs the USER's own command (their manifest or their
setting) and reads a real exit code. SIMPLE_CORE_RESET bars detectors that guess at answer
quality, not gates that read an exit status.

`verifyFixRounds` is threaded through `AgentOpts` and re-declared in `package.json` (it had
been deleted in §2.4 as a phantom — it is real now) plus the settings UI.

### 2.2 The work report is never produced — WIRED 2026-09-05

The whole reporting surface is plumbed and never fires:

| Layer | State |
|---|---|
| `AgentResult.workReport` ([agent.ts](../src/agent/agent.ts)) | declared |
| engine | **never assigned it** — the one and only gap |
| host ([chatViewProvider.ts](../src/chatViewProvider.ts)) | reads it, posts `workReport`, persists it ✓ |
| `media/src/main.ts` | imports `createResultCard`, handles the message, mounts live AND on replay ✓ |
| `media/src/ui/components/ResultCard.ts` | complete ✓ |
| `media/styles/components/result-card.css` | complete ✓ |

CORRECTION (2026-09-05): an earlier draft of this document claimed `ResultCard.ts` had zero
importers and that all four layers should possibly be deleted. That was wrong — it is imported
through the `./ui/components` barrel, and `main.ts` mounts it in both the live and replay paths.
Everything downstream of the engine was complete and waiting for a value that never came.

**Wired 2026-09-05.** `engine.ts` now builds `WorkReportData` from inputs it already had:
`changedFiles`, a tool tally from `toolEvents`, `stopReason` (§0.1/§0.2), `verifyOutcome` (§2.1),
and turn telemetry — token totals and failover count are accumulated in the engine because
report telemetry is TURN cost (every model call including continuations and fix rounds), which
the host's session-wide sink cannot supply.

Emitted only for turns that CHANGED something: a pure question has nothing to report, and a
card reading "0 files, unverified" is worse than no card. The two outcome vocabularies are
mapped deliberately — `AgentResult.verifyOutcome` is the GATE's result, `WorkReportData`'s is
what the USER is told, so 'unverified' splits into 'changes-only' (the project has no verify
command; stay quiet) and 'unverified' (one exists but gave no signal).

### 2.3 `AgentResult` documents a loop that was deleted — DONE 2026-09-05

Three fields describe machinery from the pre-v3 loop:

- `stopReason` — "the autonomous continuation loop in chatViewProvider uses this to HALT".
  Never set, so the halt never triggers.
- `verifyOutcome` — references `loop.ts` and `core/stepEngine.ts`. **Neither file exists.**
- `workReport` — see 2.2.

`docs/SIMPLE_CORE_RESET_2026-08-24.md` and **`CLAUDE.md` itself** both open by telling the
reader to study `src/agent/core/loop.ts` before touching the core. That file does not exist;
the core is `src/agent/core/engine.ts`. Every agent and human onboarding to this repo is sent
to a dead path first.

**Done 2026-09-05.** `loop.ts` → `engine.ts` in `CLAUDE.md`, the reset doc (with a note that
every later mention of the old name means `engine.ts`) and `sessionFindings.ts`. `stopReason`
is now genuinely produced (§0.1/§0.2) and its doc rewritten to describe what actually sets it.
`verifyOutcome` and `workReport` are annotated NOT PRODUCED, pointing at §2.1/§2.2 — the
decision to build or delete them — so the next reader is not misled by a contract that has
never once been met.

### 2.4 Ten declared settings are never read — DONE 2026-09-05

20% of the settings surface (10 of 49) is inert — declared in `package.json`, documented,
adjustable in the VS Code UI, and read by nothing:

| Setting | default | reality |
|---|---|---|
| `agent.maxStepsPerTurn` | 50 | engine hardcodes `stepCountIs(50)` |
| `agent.verifyFixRounds` | 2 | code path does not exist (2.1) |
| `agent.reanchorChars` | 6000 | no implementation at all |
| `agent.pruneAtTokens` | 12000 | named in one comment, nothing more |
| `fleet.maxWorkers`, `fleet.workerMaxSteps`, `fleet.workerTimeoutMs`, `fleet.researchMaxSteps`, `fleet.researchTimeoutMs`, `fleet.stagingBranchPrefix` | — | the fleet feature is deferred to v3.1 |

`maxStepsPerTurn` and `verifyFixRounds` are the dangerous ones — their defaults match the
hardcoded behaviour, so nothing looks wrong until a user changes them and nothing happens.

**Done 2026-09-05.** `maxStepsPerTurn` is wired (§0.1) and surfaced in the settings UI. The
other nine declarations are deleted. A scan of every remaining declared key against `src/` now
reports **none unread** — all 40 do something.

---

## Tier 3 — context management contradicts itself

### 3.1 Two independent auto-compaction paths — DONE 2026-09-05

| | `maybeAutoCondense` | `maybeAutoCompact` |
|---|---|---|
| when | before a turn (1 call site) | after a turn (4 call sites) |
| setting | `agent.autoCondense` + `agent.autoCondenseTokenCap` | `agent.autoCompactThreshold` |
| cooldown | 10 min | **none** |
| honours the 32k cap | yes | **no** |

Two settings, two thresholds, one job. The `autoCondenseTokenCap` added on 2026-09-04 — the fix
for "a trivial question shipped 65k input tokens" — applies to only one of the two, so the
after-turn path can immediately regrow history past the cap the before-turn path just enforced.

**Done 2026-09-05.** `maybeAutoCompact` is deleted and its four after-turn call sites now run
`maybeAutoCondense`, so resume and continue paths are covered too and the working-context cap
applies everywhere. Its ratio setting (`tiermux.agent.autoCompactThreshold`) survives and is
read by the surviving path — no user config breaks, and the hardcoded 0.8 is gone.

The deleted path also reached the user through `handleCompact`, which posts /compact's own
notices ("Not enough conversation to compact yet") and busy state as if they had asked for it.

The cooldown is now FAILURE-only. A successful compaction needs no timer — it drops history
below the threshold, so the check is self-limiting until the session regrows. Timing every
attempt meant a heavy turn that blew past the cap had to wait out ten minutes before the cap
could be enforced again, which is the cap's whole promise.

### 3.2 The compaction notice misattributes its own trigger — DONE 2026-09-05

[chatViewProvider.ts:1917](../src/chatViewProvider.ts#L1917) always blames the model's window:

> Context auto-compacted — ~33k → ~8k tokens (was approaching the model's ~200k window)

33k is not approaching 200k. The trigger was the 32k cap.

**Done 2026-09-05.** The notice names whichever bound actually fired, and when it is the cap it
names the setting (`tiermux.agent.autoCondenseTokenCap`) so the user can find it.

---

## Tier 4 — the safety net under all of the above

### 4.1 The foundation gate's technical half tests a stub loop — DONE 2026-09-05

`scripts/foundation.e2e.ts` — the suite `CLAUDE.md` calls "THE contract" — makes **13 calls
into `src/agent/poc/runAgent.ts` and 2 into the real engine.** Scenarios 1–10 (tool call, edit
correctness, repair ×2, SDK tool-error wrap, multi-step loop, cancellation, permissions ×3) run
the POC loop from plan step 4, not production. The header says so deliberately, but step 4
landed long ago; production's abort, repair and permission paths are now covered by nothing.

**Done 2026-09-05.** All 25 scenarios now run the real engine. `src/agent/poc/` is deleted;
`mockModel.ts` moved to `scripts/` as test infrastructure. Scenario 5 no longer needs a
synthetic throwing stub — no v3 tool can throw (they all return `{ error }`), so it asserts the
contract production actually depends on: a failed tool keeps the loop alive, its reason reaches
the model verbatim, and the next step recovers.

**It paid for itself immediately.** Scenario 7 failed on the first run against the real engine
and exposed a live production bug: the dead-at-start abort guard sat in the `catch` block, but
`consumeStream` RESOLVES on abort in ai v7 — the behaviour engine.ts documents twice for stream
errors — so Stop within the first second returned a "successful" turn with `text: ''` and
`paused: undefined`. The user got a blank assistant bubble and no Continue button: exactly the
0-token mystery placeholder the guard existed to prevent. The POC loop rejected on abort, so
that path had never been exercised. Fixed by mirroring the guard on the resolved path.

### 4.2 Two complete routing systems — DONE 2026-09-05

`src/router/` is 4,313 LOC. `picker.ts` (479) is the live one; `router.ts` (2,373) plus its
scoring stack (`scoring`, `scoringConfig`, `wilson`, `metricsStore`, `rateTracker`,
`latencyTracker`, `capabilityProfile`, `mockFixture` — 1,461 LOC) exists for six utility
callers. **The scoring stack is a closed cycle — nothing outside `router.ts` imports it.**

It is not only weight. `router.ts` never fails over on a forced pick, so every caller hand-rolls
a retry ladder — `condense.ts` carries the same 25-line ladder twice
([condense.ts:207](../src/agent/condense.ts#L207), [:289](../src/agent/condense.ts#L289)).
The picker path (`createRouterProvider(opts)`) has that failover built in.

**Done 2026-09-05.** `src/router/` is **4,313 → 919 LOC**. Deleted: `router.ts`, `scoring.ts`,
`scoringConfig.ts`, `wilson.ts`, `metricsStore.ts`, `latencyTracker.ts`, `mockFixture.ts`.

Done in stages, each verified before the next:

1. **Extracted what was not routing.** `ThinkStripper`, `stripThinkTags`, `reasoningFromDelta`
   and `clampOutputToContext` were stranded in `router.ts` and imported by the v3 path itself —
   they moved to `src/util/thinkTags.ts`, and the error classes to `src/router/errors.ts`.
2. **`routeOnce()`** (`agent/core/routeOnce.ts`) — one non-streaming completion through the
   picker, returning `{ text, platform, model, key }`. Failover, key rotation and account-level
   platform drop are the DEFAULT, where `Router.route()` refused to fail over on a forced pick.
   That refusal is why every caller hand-rolled a ladder; `condense.ts`'s two 25-line copies
   collapse into one `completeOnce` helper whose only remaining retry is for a blank HTTP-200,
   which no failover can see.
3. **Six callers migrated** — condense, commitMessage, inlineCompletion, inlineChat,
   planStructurer, groundingVerify — plus session titles. `pickUtilityModel`'s hand-rolled
   keyless chain and the hardcoded free-model fallback lists in commitMessage/titles are gone:
   they were naming by hand what the picker's `trivial` task table already selects for.
4. **`peekTopModel()`** replaces `Router.peekTopSelection` for the compaction budget. It runs a
   real selection but saves/restores the equal-rank rotation counter — a peek must not change
   which model the next real turn picks.
5. **Rate limiting inherited, not lost.** `RateTracker` (declared rpm/rpd) was Router-only, and
   TierMux exists to multiplex free tiers whose limits are published. It is wired into the
   picker's own skip filter and hydrated from `QuotaStore` at activation, so a limit is still
   respected BEFORE spending a request and a failure cooldown to discover it.
6. **`runAgentStream(router, opts)` → `runAgentStream(opts)`.** The argument had been ignored
   since v3; it is gone from the three entry points and every call site.

Also removed with the scoring engine: the "TierMux Router" scoring-trace channel and its two
settings (`agent.smartScoring`, `agent.scoringTrace`), which described a scoring engine that no
longer exists — the picker publishes its rationale to the "Why this model?" popover instead,
in front of the user rather than in a dev channel.

**Deliberate losses.** `TIERMUX_FAKE_MODEL` / `TIERMUX_MOCK_FIXTURE` replay goes with
`mockFixture.ts`; both launch configs were already dead for agent chat, because the v3 engine
never consulted them. The Router's route-level inline-tool adoption goes too — the same rescue
runs one layer down in `openai-compat.ts`, which both paths share. `Router`, `ScoringEngine`,
`RouteOptions` and the scoring types leave the published API surface (`src/index.ts`).

---

## Suggested order

1. ~~**4.1** — port the gate to the real engine~~ DONE
2. ~~**1.1** — edit-failure diagnostics~~ DONE
3. ~~**0.1 + 0.2 + 2.4-partial** — step cap visible, stuck detection, `maxStepsPerTurn` wired~~ DONE
4. ~~**1.2** — three-message aging window~~ DONE
5. ~~**2.3 + 3.2 + 2.4-rest** — doc/setting truth pass~~ DONE
6. ~~**3.1** — collapse to one compaction path~~ DONE
7. ~~**2.1 + 2.2** — verify + work report~~ DONE (wired, per the user's call)
8. ~~**4.2** — retire the old Router~~ DONE

Items 2–6 are each a single sitting. Item 1 unblocks trustworthy verification of the rest.

---

## Found while wiring §2.1 — `commandApproval: "never"` did the OPPOSITE of what it says

**Fixed 2026-09-05.** The setting's own enumDescription is *"Disable terminal command execution
entirely"*, and `CommandGate.run`/`runApproved` have always honoured it by refusing to spawn.
But `policyFromSettings` folded `'never'` into `mode: 'full-auto'` — "never ASK" — and the v3
`runCommand` tool ([tools/v3/runCommand.ts](../src/agent/core/tools/v3/runCommand.ts)) spawns
**directly**, never through CommandGate.

Net effect for the whole v3 era: the one setting a user picks to switch the shell OFF
**auto-approved every shell command with no prompt at all.** Exactly inverted, and silent —
the two readings of one setting never met, because the only code that honoured the documented
meaning was the gate the agent had stopped using.

Fix: `PolicyConfig.shellDisabled`, set from `approval === 'never'`, checked in `resolvePolicy`
before the full-auto branch and scoped to `runCommand` alone. The "don't ask" half of full-auto
is preserved; the "don't run" half is restored. The session auto-approve toggle does not
re-enable it — that toggle skips prompts, and a user who switched the terminal off did not ask
for it back. Gate scenario 29.

Surfaced only because the verify gate shells out through `CommandGate`, which said "disabled"
while the policy said "approved" — the contradiction had to be looked at to make the gate work.

---

## Dead-code sweep — 2026-09-05

A reachability walk from the real entry points (extension, every published package entry, every
e2e, the webview bundle) after the Router retirement. Deleted:

| File | LOC | Why it was dead |
|---|---|---|
| `src/agent/answerQuality.ts` | 188 | An answer-QUALITY judge — score a reply, escalate on a low score. The exact machinery [SIMPLE_CORE_RESET](SIMPLE_CORE_RESET_2026-08-24.md) forbids, uncalled since the v3 reset. Its two text checks (`REFUSAL_PREFIXES`, `hasRepeatedLineRun`) were still used to spot a junk COMMIT MESSAGE and moved to `src/scm/commitMessageText.ts`. |
| `src/agent/sessionFindings.ts` | 113 | `recordFindings`/`findingsPrompt` had no callers, so the store was never written — and `chatViewProvider` was dutifully calling `clearFindings` to empty it. |
| `src/agent/core/tools/network/checkUrl.ts` | 160 | Tool never registered in `buildV3ToolSet`. |
| `src/agent/core/tools/network/deepSearch.ts` | 71 | Same; its implementation (`tiermuxWeb/deep-search.ts`, 123 LOC) went with it. |
| `repairPlanSteps` | 21 | Died with the pre-v3 step engine that called it. |
| `src/indexer/importResolvers.test.ts` | 202 | A test with no runner — nothing invoked `runImportResolverTests`. |

Also removed: `routeOnce`'s `strict` and `tools` options, added earlier the same day for callers
that turned out not to exist — speculative API is dead code with better manners.

### The sweep found a broken feature, not dead code — MCP. FIXED 2026-09-05

`src/agent/core/tools/mcp/mcp.ts` had no caller, and neither did `buildV3ToolSet` have an MCP
branch — which means **the tools of every connected MCP server were never offered to the
model**, for the whole v3 era. The servers connected, `setMcpManager` ran at activation, the
"Reconnect MCP Servers" command worked, `tiermux.mcpServers` was documented, MCP is in the
README and the package keywords, and the model never saw one of their tools. Same shape as the
verify gate and the work report: fully built, never called. Third of three in one session.

**Fixed by calling `createMcpTools(getMcpManager())` from the AGENT branch only.** The two
read-only modes deliberately do not get them: an MCP tool's capability is unknowable from the
toolset builder (it may write anything), plan mode's policy denies every non-READ_ONLY tool so
offering one that is always denied is worse than not offering it, and ask mode would fall
through to the normal chain and AUTO-APPROVE it under full-auto, quietly breaking the read-only
promise. MCP tools are not in `READ_ONLY_TOOLS`, so the normal approval chain asks before
running one — the right default for a tool whose code lives outside this repo. Spread first so
a built-in always wins a name clash (names are `mcp__<server>__<tool>`, so a clash should be
impossible; belt-and-braces).

Gate scenario 30 pins all of it: offered in agent, absent from plan and ask, approval-gated,
and no crash when no manager is set.

### Second sweep — declared-but-absent surfaces

Beyond files and exports, three more kinds of "declared and not there" were checked:

- **Commands.** Two of 32 in `contributes.commands` were mentioned nowhere in `src/`:
  `tiermux.generateOnboardingTour` and `tiermux.bench`. Both appeared in the Command Palette
  and produced "command not found" when picked. Deleted; all 30 remaining ones resolve.
- **Webview messages.** All 52 `OutMessage` variants are both sent by the host and named in the
  webview. Nothing to do.
- **`src/edits/worktree.ts`** (208 LOC). Exactly one export was used anywhere — `currentBranch`,
  two lines — and the other seventeen drove the fleet worktree pipeline (create/merge/list/
  delete branches and worktrees), the same deferred feature whose six settings were deleted
  earlier the same day. `currentBranch` moved to `gitSnapshot.ts`, which already owned the
  "read something from git, never throw" helper and which its only caller already imported.

**Deliberately not touched:** ~70 individual unused exports scattered inside live files. They
are test seams and alternative code paths (e.g. `skills.ts` exports an auto-matching path while
the live feature uses explicit `/name` invocation). Purging them one by one is churn with real
risk and no user-visible payoff — unlike the whole-feature cases above, none of them advertises
something to the user that does not work.
