# Plan mode's boundary is a tool call (2026-08-31)

## What changed

The model now DECLARES its plan by calling `exitPlanMode`
(`src/agent/core/tools/v3/exitPlanMode.ts`). The engine captures the validated input on
`AgentResult.plan` and ends the turn (`stopWhen: [stepCountIs(50), hasToolCall('exitPlanMode')]`).
`chatViewProvider` renders the `planProposed` card straight from that structure.

Before, plan mode inferred AFTER the fact whether a prose reply "was a plan":

1. `looksLikeActionablePlan` — a regex needing ≥2 edit-verb + path-ish lines.
2. `extractPlanFromProse` — an LLM classifier when the regex missed.
3. `structurePlanSteps` — a THIRD model call to normalize the prose into steps.

Plus a `looksLikeGroundedAnswer` corrective re-run before any of it. That is up to four model
calls for one plan-mode turn, three separate judgments of the same question, and a transcript
that had to be popped and re-pushed on approval.

## Why a tool

Every comparable agent draws this line with an explicit signal, not prose recognition:

| | boundary |
|---|---|
| Claude Code | `ExitPlanMode` tool (plan written to a file first) |
| opencode | `plan` agent with `write/edit/patch: false`, handoff to `build` |
| Copilot (VS Code / VS) | `plan.md` session memory + "Start Implementation" |
| Zed (proposed, #60655) | a plan-update primitive: `{content, status, priority}` |

The AI SDK gives this for free: the tool's Zod schema IS the structure, so `{what, files[],
verify}` arrives typed and validated. Nothing downstream re-derives it.

## What is deliberately gone — do not re-add

- **`extractPlanFromProse`** (the LLM "was that a plan?" classifier). With an explicit boundary
  there is nothing left to disambiguate, and it cost a full model round-trip on every turn the
  regex gate missed.
- **The plan-mode half of the `looksLikeGroundedAnswer` corrective re-run.** Plan mode's signal
  that the model engaged is whether it called `exitPlanMode` — not whether a regex found the
  user's nouns in the prose. (Ask mode keeps it; that check earned its place on the 2026-08-09
  benchmark's query E1.)
- **The `## Plan: / ### Step N:` markdown template** in the plan system prompt. The tool schema
  carries what/files/verify now, so the prompt no longer asks the model to choose between two
  markdown shapes depending on whether it was asked a question or given a task.

This is the same rule as `SIMPLE_CORE_RESET_2026-08-24.md`: the core does not judge answer
quality. Classifying prose to decide whether it was a plan is exactly that judgment, and it is
unnecessary once the model can just say so.

## What is deliberately KEPT

- **`looksLikeActionablePlan`** as the fallback for models too weak to call the tool — TierMux
  routes a lot of free tiers. It costs nothing (a regex) and only runs when `result.plan` is
  undefined. `upgradePlanSteps` still refines that fallback path, never the tool path.
- **Two-layer enforcement.** `buildV3ToolSet('plan')` omits the editors AND
  `permissions/policy.ts` hard-denies them with `sessionMode: 'plan'`. opencode enforces plan
  mode by system-prompt reminder alone and has open bugs about sub-agents walking through it.
- **Steps shown IN the approval surface.** Claude Code writes the plan to a file and prompts
  inline, so users are asked to approve something they have not read (anthropics/claude-code
  #28288). The card carries the steps.
- **`structurePlanSteps`**, now skipped via `isCleanNumberedList` when the plan text is already
  one clean step per numbered line — which it always is on the tool path.

## The plan-gap nudge (live repro, same day)

`Ollama/nemotron-3-ultra`, "add a dark mode toggle to setting", 3:06 PM: 69.5k in / 236 out /
1m2s. It read its way through the codebase and then ended the turn on *"Now let me check if
there's any existing theme or dark mode support in the application."* — no `exitPlanMode` call,
so no card, and the narration shipped as the answer.

This is the SAME unclosed loop the agent-mode act/report-gap nudge already handles, so it
EXTENDS that guard rather than adding a second one (`planGap` in `engine.ts`): finish `'stop'`,
reply empty or narration, not a question, and — the plan-mode-specific part — `!proposedPlan`.
A turn that DID call `exitPlanMode` is closed by definition and never reaches it, so this stays
a wire-level check, not answer-quality judgment.

The continuation tells the model the thing it needs to know and cannot infer: it has no editors,
so calling `exitPlanMode` is the only way to finish — or, if the user actually asked a question,
to answer it directly. Invariant 3 still holds: ONE continuation per turn, `continued` gates it.

Two things fell out of that repro's test:

- The act-gap **health demotion** (`recordOutcome(..., false)`) is skipped for a plan-gap — "this
  model talks instead of acting" is an agent-mode judgment; plan mode has nothing to act on.
- `narrationSinceToolCall` was leaking across passes, so a continuation's first tool call fired
  a SECOND `onRetractDraft` for a draft the nudge had already retracted. It is per-pass state
  and is now reset in `runPass`.

## Making a weak model actually call it

TierMux routes free and local tiers, where "call this tool" is a suggestion, not a guarantee.
Two mechanical levers, both cheap:

1. **`toolChoice` on the continuation's first step.** `prepareStep` pins the closing tools for
   one step — `toolChoice: 'required'` with `activeTools: ['exitPlanMode', 'askUser']`, so the
   turn must close but the model still chooses HOW (2026-09-01: pinning `exitPlanMode` alone
   compelled a guess out of a model that had hesitated).

   Step 0 only — forcing every step would make a prose answer impossible. Pass 1 already gave
   the model its free chance to answer in prose and `looksLikeQuestion` already excluded genuine
   Q&A, so the only outcome this removes is "narrate a third time".

   **This lever did not actually work until 2026-09-01.** `core/routerProvider.ts` never mapped
   the SDK's `toolChoice` onto the router's `tool_choice`, so the field was dropped at the
   adapter — for every provider, since the boundary was written. `RouteOptions.tool_choice` and
   `openai-compat.ts` had carried it the whole time; nothing populated it. The "wire-level
   guarantee" was prompt text. Fixed by `toRouterToolChoice`, pinned by the foundation suite —
   and it is the reason the plan-gap repros kept recurring after each prompt fix.
2. **A worked example in the tool description.** Weak models copy a concrete input shape far
   more reliably than they infer one from a schema. Inline rather than via the SDK's
   `inputExamples` + `addToolInputExamplesMiddleware`, for the reason recorded in
   `sdk-adoption-policy.md`.

What was rejected: an **XML/text fallback protocol** for the plan boundary (Cline's
`plan_mode_respond` shape). Roo Code migrated OFF XML tool calling after measuring ~10% failure
on top-tier models and >15% on `apply_diff`, degrading through multi-turn — so a second parser
would buy weak-model coverage by making every strong model worse.

## How other agents shape the same tool

| | boundary tool | plan payload |
|---|---|---|
| Claude Code | `ExitPlanMode` | none — reads a plan file written first |
| Qwen Code | `exit_plan_mode` | one markdown `plan` string |
| AgentScope | `plan_enter` / `plan_write` / `plan_exit` | appended to `plans/PLAN.md`; non-whitelisted tools rejected with "[Tool denied — plan mode is active]" |
| Cline | `switch_to_act_mode` (plan-only tool) | prose; a `<mode_notice>` is injected on switch |
| TierMux | `exitPlanMode` | structured `steps[{what, files[], verify}]` |

TierMux takes the structured payload on purpose: it is what makes the card's file list
authoritative instead of a regex guess, and the AI SDK validates it for free. The cost is a
harder shape for weak models, which is what the two levers above pay for.

Worth stealing later, not done yet:

- **An editable plan FILE as the working draft** (Copilot's `plan.md` re-syncing into chat,
  AgentScope's `plan_write`). TierMux writes the file only on approval; the card is editable,
  which covers most of it.
- **AgentScope's four terminal states**, one of which is literally *"still planning without a
  written plan (narration without commitment)"* — the 2026-08-31 repro, named as a state to
  handle rather than a bug to be surprised by. `planGap` is TierMux's handler for it.
- **Qwen Code's four-way approval** (Restore Previous / Proceed Once / Proceed Always / Cancel).
  TierMux has Execute / Save / Discuss / Discard, which is the same shape minus the
  auto-approve-future-edits option.

## The saved plan document

`renderPlanMarkdown` (planStructurer.ts) replaced a flat `# Plan: <title>` + `toLocaleString()`
line + one-line-per-step checklist. What the old format threw away:

- **why the plan exists** — the user's request was never written down;
- **the structure** — `files` and `verify` were crammed onto the checkbox line;
- **sortability** — a locale timestamp cannot be sorted, diffed, or read the same way twice.

The new document leads with YAML frontmatter (`title`, ISO-8601-with-offset `created`, `status`
= approved | executing, `model`, `session`, `steps`, and the full `files` list), quotes the
original request, then renders each step as a `- [ ]` checkbox with `Files:` / `Verify:`
sub-bullets. The checkboxes are the old format's one good idea and are kept — the file doubles
as a working checklist during implementation.

Structure is recovered from the CARD text (`parsePlanStepLine`), not from a second copy of
`ProposedPlan`: the user can hand-edit steps on the card before saving, so the card is the
source of truth and a stored duplicate could silently disagree with what was approved.

Still not done (deliberate): the file is written on approval, not at propose time, so an
edited-but-never-approved plan leaves no stray `.md`. Copilot's editable-draft loop would flip
that.

## Session titles are picked once

Unrelated to the tool boundary, same failure shape — the UI changing its mind. `maybeGenerateTitle`
used to assign a regex-derived title, persist it, then overwrite it with the LLM title a moment
later, so the tab visibly went from one plausible title to a different one.

Now `s.title` is written exactly once, by `commitTitle`, and never rewritten. Until then the
session is untitled and renders the neutral `UNTITLED_SESSION` ("New chat") label — going from
"New chat" to the real title reads as filling in, not as changing its mind. The derived
stand-in helper (`deriveTitle`) is gone with it.

Second bug fixed alongside: `persist()` stored `s.title ?? deriveTitle(s)`, so a session
persisted mid-generation saved a derived stand-in — and `hydrateSession` inferred from that
string that a title had already been generated, permanently preventing the real one. Both
`title` and `titleGenerated` are now persisted explicitly, with the old inference kept only as
the back-compat path for sessions stored before the flag existed.

## Verify

```
npm run test:e2e:exit-plan-mode   # the boundary: wiring · policy · tool · engine · card text
npm run test:e2e:foundation       # scenario 11 drives the real engine through it
npm run test:e2e:plan-structurer  # the prose fallback still works
```
