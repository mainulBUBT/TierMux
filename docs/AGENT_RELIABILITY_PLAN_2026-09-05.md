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

### 0.1 Hitting the step cap is invisible

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

**Verify.** New scenario in `foundation.e2e.ts` driving the REAL engine with a mock that never
stops calling tools: assert `paused === true` and that the host renders Continue.

### 0.2 Nothing detects a no-progress loop

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

**Verify.** New e2e: a mock that repeats one failing `editFile` call; assert the turn stops at
3, not 50, and reports `stuck`.

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

### 1.2 Tool-output aging elides the read the edit depends on

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

**Verify.** `test:e2e:tool-output-aging` — add a read→read→edit fixture asserting the first
read is still verbatim at the edit step.

---

## Tier 2 — advertised safety nets that do not exist

Everything here is worse than a missing feature: the UI, the settings, and the type contracts
all promise it, so nobody notices it is absent.

### 2.1 Verify-after-edit is fully built and never called

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

Do not leave it half-present. If wiring, note it also fixes 2.2 (`verifyOutcome` is a required
`WorkReportData` field).

### 2.2 The work report is dead from engine to CSS

The whole reporting surface is plumbed and never fires:

| Layer | State |
|---|---|
| `AgentResult.workReport` ([agent.ts:74](../src/agent/agent.ts#L74)) | declared |
| engine | **never assigns it** — `grep workReport src/agent/` finds only the type |
| host ([chatViewProvider.ts:2811](../src/chatViewProvider.ts#L2811)) | reads it, posts `workReport`, persists it |
| `media/src/ui/components/ResultCard.ts` | **zero importers** |
| `media/styles/components/result-card.css` | **restyled in commit 5273aef** |

So a "Worked for Ns / files changed / verify passed" card exists in four layers, renders never,
and is still being maintained. `renderLegacyMarkdown` in the host is dead too.

**Fix.** Same decide-and-act. Producing it in the engine is genuinely valuable for an autonomous
agent (the user's only honest summary of a long unattended run) and most inputs already exist:
`changedFiles` is computed ([engine.ts:683](../src/agent/core/engine.ts#L683)), tool tallies are
derivable from `toolEvents`, `stopReason` comes from 0.1/0.2, `verifyOutcome` from 2.1. If you
will not wire it, delete all four layers in one commit.

### 2.3 `AgentResult` documents a loop that was deleted

Three fields describe machinery from the pre-v3 loop:

- `stopReason` — "the autonomous continuation loop in chatViewProvider uses this to HALT".
  Never set, so the halt never triggers.
- `verifyOutcome` — references `loop.ts` and `core/stepEngine.ts`. **Neither file exists.**
- `workReport` — see 2.2.

`docs/SIMPLE_CORE_RESET_2026-08-24.md` and **`CLAUDE.md` itself** both open by telling the
reader to study `src/agent/core/loop.ts` before touching the core. That file does not exist;
the core is `src/agent/core/engine.ts`. Every agent and human onboarding to this repo is sent
to a dead path first.

**Fix.** Rename the references to `engine.ts` throughout `CLAUDE.md` and the reset doc. Either
implement or delete each of the three fields per 0.1 / 0.2 / 2.1 / 2.2.

### 2.4 Ten declared settings are never read

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

**Fix.** Wire `maxStepsPerTurn` (needed by 0.1 anyway). Delete the other nine declarations.
Deleting a setting is safe: VS Code ignores stored values for undeclared keys.

---

## Tier 3 — context management contradicts itself

### 3.1 Two independent auto-compaction paths

| | `maybeAutoCondense` | `maybeAutoCompact` |
|---|---|---|
| when | before a turn (1 call site) | after a turn (4 call sites) |
| setting | `agent.autoCondense` + `agent.autoCondenseTokenCap` | `agent.autoCompactThreshold` |
| cooldown | 10 min | **none** |
| honours the 32k cap | yes | **no** |

Two settings, two thresholds, one job. The `autoCondenseTokenCap` added on 2026-09-04 — the fix
for "a trivial question shipped 65k input tokens" — applies to only one of the two, so the
after-turn path can immediately regrow history past the cap the before-turn path just enforced.

**Fix.** Keep ONE. The before-turn path is the right one (a turn should START with headroom).
Delete `maybeAutoCompact` and `agent.autoCompactThreshold`, or reduce it to a call into
`maybeAutoCondense`. Then re-examine the 10-minute cooldown: with a 32k cap and heavy turns it
can block a compaction the cap demands. Gate the cooldown on *failed* attempts only.

### 3.2 The compaction notice misattributes its own trigger

[chatViewProvider.ts:1917](../src/chatViewProvider.ts#L1917) always blames the model's window:

> Context auto-compacted — ~33k → ~8k tokens (was approaching the model's ~200k window)

33k is not approaching 200k. The trigger was the 32k cap. One-line fix: name whichever bound
actually fired.

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

### 4.2 Two complete routing systems

`src/router/` is 4,313 LOC. `picker.ts` (479) is the live one; `router.ts` (2,373) plus its
scoring stack (`scoring`, `scoringConfig`, `wilson`, `metricsStore`, `rateTracker`,
`latencyTracker`, `capabilityProfile`, `mockFixture` — 1,461 LOC) exists for six utility
callers. **The scoring stack is a closed cycle — nothing outside `router.ts` imports it.**

It is not only weight. `router.ts` never fails over on a forced pick, so every caller hand-rolls
a retry ladder — `condense.ts` carries the same 25-line ladder twice
([condense.ts:207](../src/agent/condense.ts#L207), [:289](../src/agent/condense.ts#L289)).
The picker path (`createRouterProvider(opts)`) has that failover built in.

**Fix.** Migrate the six callers (`condense`, `commitMessage`, `inlineCompletion`, `inlineChat`,
`planStructurer`, `groundingVerify`) to `createRouterProvider(opts)`; delete `router.ts` and the
scoring stack. ~3,800 LOC, and every utility call inherits real failover. Separate session —
this is the largest item here and unrelated to correctness.

---

## Suggested order

1. **4.1** — port the gate to the real engine (everything after this needs it)
2. **1.1** — edit-failure diagnostics (highest leverage per line changed)
3. **0.1 + 0.2 + 2.4-partial** — step cap visible, stuck detection, `maxStepsPerTurn` wired
4. **1.2** — three-message aging window
5. **2.3 + 3.2 + 2.4-rest** — doc/setting truth pass (cheap, removes active misinformation)
6. **3.1** — collapse to one compaction path
7. **2.1 + 2.2** — decide verify + work report: wire both, or delete both
8. **4.2** — retire the old Router

Items 2–6 are each a single sitting. Item 1 unblocks trustworthy verification of the rest.
