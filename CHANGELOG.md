# Changelog

All notable changes to TierMux are documented here. The format is loosely
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [3.0.1] — 2026-09-06

### Changed — fewer, faster steps on free tiers

- **Auto keeps its model for the whole turn.** The router used to re-run selection on every
  step (the SDK calls the provider once per step) and the equal-rank rotation counter advanced
  each time, so a multi-step Auto turn switched models step after step — every switch a cold
  provider, the full transcript re-sent, no prompt cache. The candidate that served step 1 now
  goes first on later steps and the fallback chain is resolved only if it fails; rotation still
  happens between turns, and 429/cooldown/failover behave as before
  (`src/agent/core/routerProvider.ts`, locked by `npm run test:e2e:router-sticky`).
- **System prompt: one search round, then answer.** The search-honesty rules were being applied
  to every question (workspace-wide bare-term grep, re-reading pasted findings); the bare-term
  grep is now scoped to negative claims and re-checks to findings the user asks to act on.
- `tiermux.agent.verifyFixRounds` default 2 → 1; chat-title generation asks one model, not
  up to three.
- **System prompt rewritten as sections with reasons** (`src/context/system.ts`): what is
  already in context (rules, editor, @mentions — never re-read), one search round then answer,
  todoWrite only for multi-phase work, one-question policy in agent mode, tool-free answers in
  ask mode when the context already holds the answer, answer size banded by change size.

### Changed — a universal method, and plumbing for weak models (2026-09-06)

- **System prompt: Stance / Method / Honesty** (`src/context/system.ts`). One investigation
  method for every task: observe the thing itself before the code that produces it; locate
  the path; name a cause only when it fits every fact; note each finding in one line so the
  trail survives pruning; gather as much as the task needs, never the same call twice. The
  research sub-agent shares `METHOD`. The earlier "one search round" rule is gone — it
  discouraged evidence, not waste.
- **Every Auto turn was routed as `chat`.** The host never passed a task kind and the picker
  classified an empty message list. The engine now classifies once per turn
  (`classifyConversation`): a short follow-up ("is this correct?", "issue ki?") inherits the
  previous substantive turn's kind instead of dropping to the chat tier.
- **AI SDK "Prompts for Tools" tips applied:** tool-offered calls run at `temperature: 0.2`
  (0 sent a free model into a decoding loop; the Responses and compat adapters omit it for
  o-series/gpt-5, which reject it); a stream that repeats the same block three times is cut
  and the model cooled down (`isDegenerateRepeat`, live repro 2026-09-06);
  `inputExamples` on readFile/grep/glob/editFile/runCommand/delegateTask ride in the wire
  description; a null-valued optional parameter is stripped mechanically before any model
  repair round (`withoutNullKeys`).
- **delegateTask on every window** — a small-window model is exactly the one that needs to keep
  a 10-file exploration out of its context; only `todoWrite` is withdrawn there. Its schema is
  `task` alone, with when / when-not / "write it for a colleague with no context" guidance.
  The sub-agent gets a classifier-gated read-only shell (git history, listings, data queries).
- Tool descriptions say when NOT to use them (readFile, runCommand, todoWrite).
- **An identical read-only call never re-runs.** The second copy returns the earlier result
  with a note, later copies only the note, and the fourth pauses the turn as stuck
  (`dedupeReads`, live repro: grep "distance" 15× in one turn).
- A question ("why…?") is answered before anything is changed (Stance); "why X is not set"
  routes as debug; the verify fix round is told to leave the work alone when the failure is
  unrelated (a missing service) instead of reverting it.
- Locked by `npm run test:e2e:weak-model-plumbing`; `tool-offer` and `delegate-task` updated.

### Added — TierMux learns across sessions (no extra model calls)

- **Corrections are remembered.** Every compaction already writes a "Corrections & rejected
  approaches" section; those entries are now appended to `.tiermux/memory.md` under an
  agent-maintained heading (de-duplicated, newest 20 kept, the user's own text always injected
  first) and reach every later turn through `<user_memory>` (`src/context/userMemory.ts`,
  `condenseHistory().corrections`).
- **Auto routing learns from outcomes.** The verify command's exit code and a stuck stop are
  recorded as implicit signals on the served model (`ModelStatsStore.recordSignal`, half the
  weight of a 👍/👎) and persist across reloads. Still only a tie-break among equal-rank peers —
  never overrides intelligence rank. Pinned models are not scored.
- **The verify command is stated in `<environment_context>`** so the model does not spend a
  search round discovering how the project is tested.
- Locked by `npm run test:e2e:memory-learned`.

### Fixed — long turns no longer lose the conversation

- **Compaction after a 50-step turn forgot the goal.** The summarizer received the raw prefix
  with no fitting (a 400k-token prefix into a 32k-window utility model — the provider kept the
  tail, the original ask was the head), the blank-retry dropped the OLDER half, and 95% of the
  input was tool output. Now (`src/agent/condense.ts`): tool results/arguments are capped before
  summarizing, the request is fitted to the summarizer's window with the first user message
  pinned, the summary budget is 2048 tokens, and an earlier summary's Goal/Corrections/Next
  steps are carried forward explicitly.
- **An oversized tail is folded into the summary.** A tool-heavy turn's tail was ~100 messages
  of stubs (26k tokens) re-sent on every later step; the tail is now the turn's user message plus
  its closing reply. This is also the first time a session that STARTS with a mega-turn can
  compact at all (tailStart 0 returned null).
- **Tool results are capped at 2,000 chars when persisted into history** (`capForHistory`) —
  the aging threshold, so nothing a later step could see changes, while a 1.5M-char history
  stops being estimated, persisted and summarized every turn.

### Changed — model rationale UI

- The model-selection rationale is now a compact footer chip in the chat composer instead
  of an inline block; the details live in a redesigned, collapsible popover.
- The rationale filters out disabled providers and tracks which model actually served the
  turn.

## [3.0.0] — 2026-08-31

### Added — plan mode's boundary is a tool call

- **`exitPlanMode`** (`src/agent/core/tools/v3/exitPlanMode.ts`) — the model now DECLARES
  its plan by calling a tool with a validated `{what, files[], verify}` structure. The
  engine captures it on `AgentResult.plan` and ends the turn
  (`stopWhen: [stepCountIs(50), hasToolCall('exitPlanMode')]`); `chatViewProvider` renders
  the `planProposed` card straight from that structure.
- Removed the prose-classification path it replaces: `extractPlanFromProse` (an LLM
  "was that a plan?" classifier), the plan-mode half of the `looksLikeGroundedAnswer`
  corrective re-run, and the third model call that normalized prose into steps — up to
  four model calls per plan turn collapse to zero. See
  `docs/PLAN_MODE_TOOL_BOUNDARY_2026-08-31.md`; the classifier must not come back.
- **`npm run test:e2e:exit-plan-mode`** — 50 scenarios covering the tool boundary, plan
  serialization, and the saved-plan document format.

### Changed — Tips UI uses standard theme colours

- The tips cards, the composer strip, the RECENT rows and the unread indicator were painted
  with `charts-yellow` and `editor-inactiveSelectionBackground`. The first is a *chart series*
  colour and the second a *text-selection* colour — neither is a surface token, so cards came
  out navy under Dark+ and the strip came out mustard regardless of theme (report 2026-08-31).
  Surfaces now use the standard widget palette: `editorWidget-background`,
  `badge-background/foreground` for pills and the toolbar dot, `list-hoverBackground` on
  hover. The accent survives where it carries meaning rather than decorating a panel — the
  strip's border, its TIP label, and the unread card's left rail. They inherit whatever the
  user's theme defines instead of fighting it. `charts-*` stays where it is genuinely semantic
  (queued/approval/finished status dots, file-type chips).
- The RECENT list dropped `input-background`, which made the rows read as one large text
  field, and with it the `body.vscode-light` override that only existed to patch that.
- Fixed descender clipping in the ticker: the 16px track cut the tails off `p`/`g`/`y` on a
  16px line box; the track is 18px now.

### Added — a session dot on the welcome screen's RECENT rows

- RECENT listed sessions as bare title + timestamp lines, so several entries read as one
  wrapped list. Each row now leads with a status dot, matching the history dropdown, with
  the same status colours (queued / needs-approval / running / finished). RECENT uses its
  own glyph map: the history dropdown swaps `running` for a real spinner, and a static `⟳`
  in a plain list reads as a stuck reload button.

### Changed — the tips ticker lives on the welcome screen

- The Tips & Announcements headline ticker (new in this release) cycles one headline at a
  time above RECENT on the welcome screen — permanently, so it does not die when a chat
  starts (user request 2026-08-31: "keep it forever slide show always"). It deliberately
  has NO placement above the composer: tips pinned over the input box during chats read as
  system messages, not announcements (user direction, same day). Read tips keep cycling;
  only a genuinely empty feed hides it; clicking it opens the full Tips page.

### Fixed — asserted negatives without an adequate search

- Live repro 2026-08-31 ("wallet now commented right?"): four consecutive Ask turns answered
  "no commented wallet configurations were found" — the model had grepped decorated literals
  (`# wallet`, `// wallet`) that cannot match real code like `// $wallet_status = ...`,
  treated the open `.env` as the search scope, and finally claimed "I revisited the workspace"
  while restating an answer the user had pasted from a rival tool. The v3 prompt composer
  ships one search-honesty guard in the BASE prompt (all modes): negatives require a bare-term
  case-insensitive workspace-wide grep with the pattern stated; never claim tool runs that did
  not happen this turn; verify user-pasted findings in the files before agreeing.
  (`.tiermux/agent/research.md` is not in the live v3 prompt — see
  `docs/SIMPLE_CORE_RESET_2026-08-24.md` — so this is the one place the rule can live.)

### Fixed — "Why this model?" credited the wrong model

- The popover named the model TierMux *intended* to use, not the one that answered. The
  report is built by `selectModel()` before the first byte is sent, so `picked` is
  `chain[0]`; when that candidate failed over, nothing re-pointed it at the winner. Live
  repro 2026-08-31: the footer read `ChatAnywhere/gpt-4.1` while the popover insisted
  `✓ opencode/muse-spark-1.2-contributor-free — serves this turn`.
  `rationaleForServed()` (`src/router/picker.ts`) now re-points the report the moment a
  candidate succeeds, and relabels the ones walked past as `tried first, failed over` — so
  the popover shows the whole walk instead of hiding it. Candidates *after* the winner keep
  their `failover #n` label, since they were never dialed.

### Changed — a set model runs ALONE (no silent failover)

- Pinning a model is an exact request: the selection is the pin and NOTHING else. The old
  chain padded the pin with the task table and every usable enabled model, so a failing pin
  was silently answered by a different provider's model while the footer still credited the
  pin (live repro 2026-08-31: `openrouter/z-ai/glm-5.2:free` pinned, turn served by
  `kilo/nvidia/nemotron-3-ultra`). A dead pin now fails the turn with the real reason
  (no key, provider off, cooldown) instead of rerouting (`src/router/picker.ts` +
  `resolveCandidates`); the "Switch model & retry" affordance remains the escape hatch.
  Auto is unaffected — the selector's default `auto` value means "no pin", and the
  pin-runs-alone branches must never treat it as one (this guard was the one blocker found
  by the pre-release scan; without it every default Auto turn died with "Pinned model auto
  could not run". Regression-tested in `test:e2e:foundation`).

### Fixed — the footer paired the pin with whichever provider served

- `Kilo Gateway/z-ai/glm-5.2:free` — an OpenRouter pin's modelId shown under a failover
  provider's name — was the visible symptom of the footer trusting the pin over the run.
  The platform/model that ACTUALLY served (reported per-step by the engine) now wins
  everywhere: the streaming footer, the settled message footer, and failover notices.
  Platforms are shown through their display names ("OpenRouter", "Kilo Gateway"), not raw
  ids. The pin remains only as the fallback label for turns that produced no run metadata,
  so an errored turn still names the model it was aiming at.
  Locked by `npm run test:e2e:rationale-served` (13 scenarios).
- The Score tooltip claimed "the highest-scoring model is chosen", which contradicted the ✓
  on screen: the picker orders by pin → task table → catalog rank, so a task-table pick at
  rank 2 shows 0.80 while the rank-1 tail it beat shows 1.00. The tooltip now states the
  real rule and points at the per-row reason line.

### Fixed — declaration emit skipped after a partial `dist` clean

- `tsconfig.lib.json` is `incremental`, so a stale `.cache/lib.tsbuildinfo` convinced `tsc`
  the `.d.ts` files were already emitted and it wrote nothing — then `vsce` refused every
  target with "include patterns in the files property do not match any files". Production
  type emit no longer trusts that cache (`build:types` runs `--incremental false`), and
  `scripts/package-targets.sh` now checks the expected artifacts up front so a missing
  bundle fails with a readable message instead of six identical opaque vsce errors.

### Added — self-updating README

- **`scripts/sync-readme.mjs`** + **`npm run sync:readme` / `check:readme`** regenerate the
  provider/model counts and provider lists in `README.md` from the live catalog. The
  hand-written numbers had already drifted (README said 585 models; the catalog served
  600). Display names are parsed from `src/providers/index.ts` so there is one source of
  truth for them. Folded into `sync:all`, plus a weekly
  `.github/workflows/readme-stats.yml`.

### Changed — documentation

- `README.md` rewritten against the shipped code and cut from 584 to ~190 lines; the depth
  moved to `docs/PROVIDERS.md` (keys, rotation, custom OpenAI-compatible endpoints,
  settings), `docs/ROUTING.md` (selection, failover, "Why this model?", algorithms), and
  `docs/FEATURES.md` (modes, tools, comparison).
- Corrected claims that no longer matched the code: the removed `terseReplies` setting, an
  "embeddings index" that is a symbol/dependency index, git-worktree sub-agent workers that
  no longer exist, step-verified plan execution, and Wilson/EWMA scoring presented as the
  agent-turn router (it now serves utility calls only).
- Marketplace badges rebuilt — shields.io retired every `visual-studio-marketplace/*`
  endpoint, so those badges rendered "retired badge"; download counts added for both
  marketplaces and a live provider count from the catalog.

## [Unreleased] — earlier v3 work

### Changed — v3 engine: policy layer over the AI SDK

TierMux v3 restructures the agent around one division of labor: **the AI SDK is the
execution engine** (tool parsing/validation, tool execution, the multi-step loop, abort,
execute-error wrapping) and **TierMux is the policy layer** (model selection, permissions,
tools, system prompt, compaction).

- **New engine** (`src/agent/core/engine.ts`, ~330 LOC) replaces `core/loop.ts` (1,358 LOC).
  One `streamText` call with `toolApproval`, `repairToolCall`, `prepareStep`,
  `stopWhen: [stepCountIs(50)]` — the SDK owns the loop.
- **Self-correcting tool calls** (`core/repair.ts`): malformed calls (bad JSON, wrong
  schema, unknown tool) are repaired by showing the model its own error and asking for one
  corrected call — budgeted at 3 per turn. Replaces the 677-LOC regex rescue ladder in
  `agent/toolArgs.ts` at the engine level.
- **Thin model picker** (`src/router/picker.ts`): a readable `TASK_ROUTING` table
  (task kind → candidate chain) with failover on 429/5xx. The scoring stack (Wilson,
  capability profiles, metrics/rate/latency trackers, hedging) no longer participates in
  agent-turn selection; the `Router` remains for utility one-shot calls (titles, commit
  messages, completions) until v3.1.
- **Uniform permission policy** (`src/permissions/policy.ts`): priority chain
  `alwaysDeny → alwaysAllow → read-only → mode → ask`; full-auto can never bypass an
  explicit deny.
- **v3 toolset** (`core/tools/v3/`): readFile, editFile (whitespace-tolerant matching +
  re-indent preserved), writeFile, deleteFile, listDir, glob, grep, runCommand — all
  `tool()`-form with Zod schemas, exception-safe (`{ error }` results), and no embedded
  approval. Plan/ask modes drop mutating tools entirely.
- **Minimal compaction** (`core/compact.ts`): token-budget tool-result stubbing via
  `prepareStep`. The re-anchor/collapse-repeat/watchdog cascade is removed.
- Approved plans now execute as one agent turn with the steps enumerated in the prompt
  (the dedicated step engine is gone; step-level pause/resume returns in v3.1).
- 116 legacy files deleted (~19,000 LOC): the old loop machinery, scoring stack, fleet/
  delegate/explore sub-agents, gate-coupled tools, and 51 superseded e2e scripts.
  The 10-scenario foundation gate (`npm run test:e2e:foundation`) covers the new engine.

### Added — Foundation Gate expanded to 14 scenarios (plan §13)

Scenarios 11-14 drive the REAL engine through a test-only model seam:

- **11. Plan mode flow (§12)** — read/search offered freely, `runCommand` ASKS, edit/delete
  hard-denied at the policy level (even with alwaysAllow — an approved plan is never a
  blanket mutation approval); plan output follows the `## Plan:` markdown convention;
  approving re-gates every tool call in agent mode.
- **12. Context correctness** — prior tool results, user text, and the mode-tail system
  prompt reach the model verbatim; nothing fabricated enters the context.
- **13. Streaming + reasoning + think-tag** — reasoning flows to the reasoning channel
  (never leaks into chat text), precedes text within a step, and `<think>` tags split
  across chunks are stripped/routed with duplicate reasoning suppressed (the R1 routing
  regression, fixed and now gated).
- **14. Session persistence** — transcript round-trip: a fresh turn seeded with the
  persisted workMessages sees prior tool results, does not re-read or re-plan, and
  recovers the agent toolset.

Deferred to v3.1 (after the gate passed): long-conversation compaction, diagnostics-after-edit,
terminal edge cases (cwd/env/exit), model fallback beyond the picker chain, network retry,
optional sub-agent.

### Fixed

- **Auto no longer dies blind on the circuit-breaker cache** (live repro:
  "eto models on, but Auto keeps saying All 5 configured models are
  unavailable" seconds apart). When every candidate sat in the per-model
  health cache from failures moments ago, `route()` skipped them all without
  sending a single request and re-threw the stale verdict instantly — on
  every retry, even after the providers had recovered. A blind-death guard
  now detects "nothing was really attempted" and runs ONE bypass pass that
  ignores the cache and dials for real; outcomes refresh health naturally.
  The cache's normal benefit is untouched — skips still save requests
  whenever a live alternative exists (`S7d`), and the guard fires only when
  zero real requests were made (`S7c`).
- **Honest failure report.** The cached-skip verdict is now reported as
  "benched (recently failed)" instead of borrowing the old failure's reason
  ("1 timed out" used to claim a request that never happened), and the
  message appends why the rest of the enabled pool was never eligible this
  turn: without a usable key, without tool support in Agent mode, or flagged
  unavailable by the provider.
- **Duplicate error blocks removed.** A turn that died before producing any
  text posted the same error twice (a live notice plus the final failure
  bubble). The live notice now fires only when partial output already
  streamed — i.e. when it is the error's only surface.
- Preflight ping timeout raised 1200ms → 2500ms: free aggregators routinely
  answer a cold ping in 1.5–2s, so half-open probes kept re-benching alive
  models on an exponential cooldown and starving Auto's pool.
- Bundled catalog re-synced against the live worker with pruning: 405 → 326
  models. Everything the worker no longer serves (Google's paid/deprecated
  and duplicate `models/`-prefixed ids, OpenAdapter's top-tier-only models,
  Groq's non-chat orpheus/whisper, llm7's now-key-gated gemma4:31b) is gone
  from the offline/first-run fallback too, so the verified free list is the
  only one the extension can ever show or route.

### Added

- **OSS-ready library entry point.** `import { Router, runAgentStream,
  runPlanStream, runAskStream, classifyTask, createRouterProvider, ... } from
  'tiermux'` (or `'tiermux/router'`, `'tiermux/agent'`, `'tiermux/providers'`,
  `'tiermux/shared'`). The same agent engine that powers the VS Code
  extension is now consumable from any Node 18+ application. The library
  build is wired into `npm run build`; declaration files are emitted by
  `npm run typecheck:lib`. A smoke test (`npm run test:e2e:library`)
  proves the public surface resolves under plain Node with the same
  `scripts/vscodeMock.cjs` shim the e2e suite uses.
- **`package.json` exports map**, `files`, `sideEffects: false`, and
  `keywords` updates so the npm tarball contains only what consumers need
  and the package.json's `import`/`require`/`types` resolution paths all
  work.
- **`NOTICE`** — Apache-2.0 §4(d) attribution for the bundled Vercel AI SDK
  and `pdf-parse`, plus an informational list of other MIT/ISC/BSD
  dependencies. Required for the AI SDK's Apache-2.0 license when shipped
  bundled.
- **`CONTRIBUTING.md`** — build, layout, and the simple-core rule summary.
- **`CHANGELOG.md`** (this file).
- **Library smoke e2e** (`scripts/librarySmoke.e2e.ts`) — headless
  end-to-end proving `Router`, `runAgentStream`, and `classifyTask` import
  and run under plain Node.

### Changed

- `esbuild.js` now produces a third artifact (`dist/<lib>.cjs` for each
  public entry) alongside the existing extension and webview bundles. The
  extension build path is unchanged.

### Out of scope (follow-ups, not in this release)

- Engine `vscode` decoupling (Approach B) — config reads, filesystem
  calls, and workspace root resolution still go through `vscode.*` (or
  the supplied shim). A full host-boundary refactor is a separate change.
- Webview `@ts-nocheck` removal in `media/src/main.ts` and
  `media/src/bridge.ts`. Not a packaging concern; tracked separately.
- Marketplace artwork scan (vendor name, banner image) before publishing
  to the VS Code Marketplace or open-vsx.

## [2.1.7] — 2026-08-25 and prior

See git history. Pre-OSS packaging; everything from the simple-core reset
forward. The TierMux VS Code extension was distributed as MIT throughout —
this release makes the licensing + library surface explicit.
