# Changelog

All notable changes to TierMux are documented here. The format is loosely
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [Unreleased]

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
