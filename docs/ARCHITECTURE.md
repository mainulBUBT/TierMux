# TierMux Architecture


## Identity

**TierMux** = a VS Code extension that routes every AI request to the best
free model across 30 built-in LLM providers (plus unlimited user-defined
OpenAI-compatible endpoints), with automatic failover, key rotation,
rate-limit cooldowns, and quality-based escalation.

Agent execution runs **in-process**, built directly on the **AI SDK**
(`ai@^7.0.34` + `@ai-sdk/provider@^4.0.3` — referred to generically as "the
AI SDK," never by vendor name) — `streamText()` is the actual execution
engine (loop, step orchestration, tool lifecycle, streaming, retry, stop
conditions, tool-approval gate). TierMux owns routing, provider adapters,
permission policy, and VS Code integration; it does not implement its own
agent loop. (OpenCode — a separate, external-process agent CLI TierMux
used to spawn and route through an HTTP proxy — was fully removed 2026-07;
see "History" below.)

```
chatViewProvider.ts → agent.ts → core/engine.ts (streamText) →
  core/routerProvider.ts → router/picker.ts → 30 Built-in Providers (+ custom)
```

---

## Layer diagram (shipped)

```
┌────────────────────────────────────────────────────────────────────┐
│                       TierMux VS Code Extension                    │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ TierMux UI (webview) ── postMessage/onDidReceiveMessage       │  │
│  └────────────────────────────────┬─────────────────────────────┘  │
│                                   │                                │
│  ┌────────────────────────────────▼─────────────────────────────┐  │
│  │  chatViewProvider.ts (VS Code integration, session state)     │  │
│  └────────────────────────────────┬─────────────────────────────┘  │
│                                   │                                │
│  ┌────────────────────────────────▼─────────────────────────────┐  │
│  │  agent.ts (stable contract — AgentOpts/AgentResult/ToolEvent) │  │
│  │  runAgentStream / runPlanStream / runAskStream                │  │
│  │  generateSessionTitle (direct Router)                        │  │
│  └────────────────────────────────┬─────────────────────────────┘  │
│                                   │ dynamic import (vscode-free      │
│                                   │ above this line)                │
│  ┌────────────────────────────────▼─────────────────────────────┐  │
│  │  agent/core/  — the AI-SDK-based agent engine                │  │
│  │  engine.ts        runTurn(): builds the streamText() call     │  │
│  │  routerProvider.ts  picker → LanguageModelV4 protocol adapter │  │
│  │  routeOnce.ts     one-shot routing for utility callers        │  │
│  │  compact.ts       prepareStep pruning + tool-output aging     │  │
│  │  repair.ts        weak-model tool-call dialect rescue         │  │
│  │  subagent.ts      the read-only delegateTask worker           │  │
│  │  tools/v3/**      file/search/shell/ui tool factories         │  │
│  └────────────────────────────────┬─────────────────────────────┘  │
│                                   │ AI SDK types stop here          │
│  ┌────────────────────────────────▼─────────────────────────────┐  │
│  │  Model picker (src/router/picker.ts) — AI-SDK-agnostic       │  │
│  │  - task table → intelligence-rank tail, never a dead end     │  │
│  │  - multi-provider failover with per-key rotation             │  │
│  │  - per-platform + per-key rate-limit cooldown                │  │
│  │  - tool-incompatible + 404-deprecated quarantine             │  │
│  │  - round-robin platform diversity across the failover scan   │  │
│  │  - proactive rate-limit skip (rateTracker.ts)                │  │
│  └────────────────────────┬─────────────────────────────────────┘  │
│                           │                                        │
│  ┌────────────────────────▼─────────────────────────────────────┐  │
│  │  30 Provider Adapters (src/providers/*.ts)                    │  │
│  │  28 OpenAI-compat (Groq, Mistral, Cerebras, gateways, …) +    │  │
│  │  Google + Cloudflare + custom OpenAI-compatible endpoints     │  │
│  └─────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

**Layering boundary**: AI SDK types (`streamText`, `LanguageModel`, `Tool`,
`ToolSet`, `ToolApprovalStatus`, …) are used *inside* `agent/core/` only.
`agent.ts` exposes just TierMux's own `AgentOpts`/`AgentResult`/`ToolEvent`
— nothing above it (`chatViewProvider.ts`, the webview) ever imports an AI
SDK type. `Router` itself never imports an AI SDK type either — it exposes
`route(messages, opts): RouteResult` and knows nothing about
`LanguageModel`/`Tool`/`streamText`. If a future AI SDK major version
changes its APIs, only `agent/core/` changes.

---

## Shipped components

### Model picker — `src/router/picker.ts` (the heart)

- **Candidates pipeline:** `enabledByPriority()` → pin if specified → drop
  tool-incompatible / quarantined / deprecated → drop `exclude` set
  (escalation) → drop models a `RateTracker` says are already at their limit →
  task-table reorder, then the enabled tail by intelligence rank → prefer
  non-cooled platforms.
- **Failover walks platforms round-robin**, not the flat chain: round 0 takes
  every usable platform's best model, later rounds its second and third,
  bounded at 20 candidates (`MAX_CANDIDATES`, routerProvider.ts). Each candidate
  gets 60 s to answer with headers and the chain stops STARTING new ones after
  120 s; a candidate already streaming is never interrupted. Among models tied
  on intelligence rank the picker rotates which one leads between turns, so
  quota spreads — that rotation runs BEFORE the "Why this model?" rationale is
  emitted. A second rotation of the platform order, downstream of the rationale,
  was removed on purpose (413ecb5): it made the popover name a model that never
  ran.
- **Failure handling:** classify error → 429 cool the key, rotate the pool
  (or cool the platform); 401/403 → invalid; bad request + tools → quarantine
  the model as tool-incompatible; 404 → deprecated. Per-model cooldown is
  exponential from 30 s, capped at 2 min, reset on success, in-memory only.
- **No learned scoring.** Wilson intervals, EWMA latency tracking, preflight
  pings, hedging and the persisted metrics store lived in a *second* router
  (`src/router/router.ts`) that was retired 2026-09-05 — see `docs/ROUTING.md` §B.
  `routeOnce.ts` now serves the utility callers that used it.

### Provider adapters — `src/providers/*.ts`

28 OpenAI-compatible providers (Groq, Mistral, Cerebras, OpenRouter, the
gateway tiers, etc.) + bespoke adapters for Google Gemini and Cloudflare
Workers AI + arbitrary `custom` OpenAI-compatible endpoints. A remote-catalog
upsert path (`upsertCompatFromCatalog`) can register brand-new compat platforms
without an extension update. Untouched by the OpenCode removal / AI SDK
migration — the Router calls them exactly as before.

### Agent core — `src/agent/core/`

The in-process agent engine, built directly on the AI SDK. Nothing above this
layer (`agent.ts`, `chatViewProvider.ts`, the webview) ever imports an AI SDK
type — see the Layering boundary note above.

**Read `docs/SIMPLE_CORE_RESET_2026-08-24.md` before changing anything here.**
The loop is a mechanical execution engine: it runs tools and models, preserves
the one `CoreMessage[]` transcript, rotates providers, and recovers from
provider failures with exactly ONE mechanical continuation. It never judges
answer quality, never detects "narration", never retries on weak-looking output.

- **`engine.ts`** — `runTurn(opts)`, the one place `streamText()` is called.
  A thin direct function, not wrapped in a runner/manager class. Consumes
  `result.fullStream` and maps each part to the existing `AgentOpts` callbacks.
  Owns the turn's `stopWhen` set: the step cap, plan acceptance, and a
  no-progress guard that stops a turn repeating an identical failing tool call.
  A turn stopped by any of those returns a `stopReason` and `paused: true` so
  the UI can offer Continue with the full transcript intact.
- **`routerProvider.ts`** — a *pure* protocol adapter implementing
  `LanguageModelV4` (`doGenerate`/`doStream`) over the picker. No routing
  decisions here. Forwards `onFailover`/`onKeyRotated`/`onSelectionRationale`.
- **`routeOnce.ts`** — one non-agentic call for the utility callers (titles,
  commit messages, completions, compaction, plan structuring). Failover, key
  rotation and account-level platform drop are the default, not options.
- **`compact.ts`** — two independent context controls: `compactIfNeeded`, a
  `prepareStep` override that prunes the transcript in two tiers once the model's
  own window is 80% full, and `ageToolOutputs`, which runs every step and elides
  earlier bulky tool results into stubs that name the tool and say how to re-run it.
- **`repair.ts`** — rescues weak models that emit a tool call as text
  (`<function=readFile>{…}</function>`) instead of a native call.
- **`subagent.ts`** — the read-only worker behind `delegateTask`. Only its
  report returns, so the main context stays small.
- **`../../permissions/policy.ts`** — the verdict function passed as
  `streamText`'s native `toolApproval` option (a denied verdict means the tool's
  `execute()` never runs, not that its effect is discarded). Chain:
  `alwaysDeny → alwaysAllow → READ_ONLY_TOOLS → mode → ask`.
- **`tools/v3/**`** — one `create*Tool()` factory per tool, assembled by
  `tools/v3/index.ts`'s `buildV3ToolSet(mode, bindings)` into the mode's actual
  set (see "Three modes"). Each is `tool()`-form with a Zod schema, an
  exception-safe `execute` (expected failures return `{ error }`), and NO
  embedded approval — the policy decides IF a mutating tool runs.
  `tools/network/` adds the keyless `webSearch`/`fetchUrl` pair, offered in
  every mode. `tools/mcp/mcp.ts` registers every connected MCP server's tools as
  ordinary `tool()` objects in **agent mode only** — nothing in the loop or the
  tool-set builder can tell an MCP-backed tool from a built-in one.
  Tools capture session data via closures rather than the AI SDK's
  `runtimeContext`/`ToolExecutionOptions.context` — that mechanism was verified
  empirically **not** to propagate as documented (see `docs/sdk-upgrade.md`).
  What the codebase adopts from the SDK at all is governed by
  `docs/sdk-adoption-policy.md`.

`agent.ts` is the stable contract above `core/`: `AgentOpts`/`AgentResult`/
`ToolEvent`, and `runAgentStream`/`runPlanStream`/`runAskStream` (each just
sets `mode` and dynamically imports `core/engine.ts` — dynamic so `agent.ts`
itself stays `vscode`-free and independently testable).

### Settings + secrets — `src/config/`

- `SecretStore` (per-platform keys, multi-key pool, per-key + per-platform
  cooldowns, quarantine state).
- `SettingsStore` (fallback chain, endpoint overrides, custom endpoints,
  disabled providers).
- `UsageStore` (lifetime tokens + estimated $ saved, recomputed on read).
- `ModelStatsStore` (per-`(taskKind, platform, modelId)` 👍/👎 counters).

---

## Data flow (shipped)

```
1. User types in the webview.
2. webview postMessage → chatViewProvider.handleSend(m).
3. handleSend builds AgentOpts and dispatches to
   runAgentStream | runPlanStream | runAskStream (agent.ts).
4. agent.ts dynamically imports core/engine.ts and calls runTurn(opts).
5. runTurn() calls streamText({ model: createRouterProvider(providerOpts),
   tools: buildV3ToolSet(mode, bindings), toolApproval: the permissions/policy.ts
   verdict, prepareStep: compaction + tool-output aging, stopWhen: [...] }).
6. Each doGenerate/doStream call inside the provider adapter walks the picker's
   candidate chain → 1+ provider adapter calls (with failover/rotation/cooling)
   — entirely in-process, no HTTP hop.
7. runTurn() consumes result.fullStream directly, mapping text-delta/
   reasoning-delta/tool-call/tool-result/tool-error parts onto the AgentOpts
   callbacks (onChunk, onTool, onReasoning, onTodos, onStep, onError).
8. On stream end: finish with accumulated text; in agent mode with mutated
   files, the verify gate runs and the work report is built. Token usage →
   UsageStore. Title generation fires in the background via routeOnce.
```

---

## Three modes

`buildV3ToolSet(mode)` (`tools/v3/index.ts`) is the single source of truth for
what each mode can do; the permissions policy denies anything a mode does not
offer, so the two lists cannot drift apart.

| Mode | Tools offered | Notes |
|---|---|---|
| Ask | read/search + web + `todoWrite`, `getDiagnostics`, `askUser`, `delegateTask`, and a READ-ONLY `runCommand` | The policy auto-runs confidently read-only commands (`ls`, `git log`), hard-denies destructive ones, asks for the rest. No file mutation. |
| Plan | the Ask set plus `exitPlanMode` | `exitPlanMode` is plan mode's ONLY exit — see `docs/PLAN_MODE_TOOL_BOUNDARY_2026-08-31.md`. No file mutation. |
| Agent | everything: the above plus `editFile`, `writeFile`, `deleteFile`, and every connected MCP server's tools | MCP tools are agent-only because their capability is unknowable and the read-only modes cannot gate what they cannot classify. |

Every mode streams. The old buffered-vs-streaming split (`wantsStream`) was a
property of the retired Router and is gone with it.

---

## Async utilities (shipped, no agent involvement)

These bypass the agent loop and make one non-agentic call through
`routeOnce` (`src/agent/core/routeOnce.ts`):

- `inlineChat` (Cmd+I) — edit selection via `EditGate`.
- `commitMessage` (git SCM) — generate commit message from diff.
- `generateSessionTitle` — 2-5 word title from first message.
- `condenseHistory` — long-context compaction.

---

## Configuration surface

Settings (`package.json:contributes.configuration`) — `package.json` is the
authority; this is the shape, not the registry:

- `tiermux.agent.{maxStepsPerTurn, maxConcurrentRuns, requireWriteConfirmation,
  commandApproval, commandAllowlist, commandTimeoutMs, verifyCommand,
  verifyFixRounds, toolCompaction, autoCondense, autoCondenseTokenCap,
  autoCompactThreshold, diagTrace}`.
- `tiermux.completions.{enabled, model, debounceMs}`, `tiermux.utilityModel`.
- `tiermux.context.{includeOpenEditors, ambientSliceRadius}`.
- `tiermux.index.{enabled, excludes, maxFiles}`, `tiermux.graph.enabled`.
- `tiermux.plan.{saveToFile, folder}`, `tiermux.profiler.{enabled, ringSize}`.
- `tiermux.catalog.url`, `tiermux.models.autoEnableNew`.
- `tiermux.{mcpServers, mcpRegistryUrl, mcpRegistrySearchUrl}`.

The fallback chain, endpoint overrides, custom endpoints and disabled
providers are NOT settings — they live in `SettingsStore` (globalState) so
the model picker can mutate them without a settings write.

Secret storage (`vscode.SecretStorage`): `tiermux.key.<platform>`,
`tiermux.keys.<platform>`, `tiermux.modelKey.<platform>::<modelId>`, plus
the same shape for custom endpoints.

---

## Roadmap (Phase 3+ — not yet implemented)

The pieces below are **design targets**, not current behavior. They are
preserved here as a forward-looking spec; the code does not implement them
today.

### Adaptive Orchestrator — `ExecuteRequest` / `ExecutionEvent` / `ExecutionPolicy` (CHAT | AGENT | INLINE | BACKGROUND)

The current picker + routerProvider pair is the classic multi-provider
failover cascade. The future design is a single `AdaptiveOrchestrator.execute()` that:

- Takes a typed `ExecuteRequest` (messages, mode, model, policy, signal).
- Returns `AsyncIterable<ExecutionEvent>` (`model_chosen`, `provider_switch`,
  `streaming_chunk`, `streaming_end`, `error`, `quota_update`).
- Owns the PKB sort + selection loop + continuation logic.
- Is the single entry point for every model call (CHAT, AGENT, INLINE,
  BACKGROUND).

### A pure capability resolver

A public API that answers "which models can do this task?" without ordering
or failover. `src/router/capabilityProfile.ts` is the seed: it already reads
tools/vision/reasoning off `CatalogModel`, but the picker still uses
`supportsTools !== false` as its only hard capability filter.

### Performance Knowledge Base (SQLite) — Phase 4+

Three tables built after real usage patterns emerge:

| Table | Purpose | Written by |
|---|---|---|
| `models` | Static metadata, capability_bits | Catalog import |
| `runtime_health` | cooldown, latency, success_rate, 429 count | Router on every call |
| `benchmark_scores` | Offline eval scores | Bench command |

The current in-memory state (picker.ts's `modelHealth` cooldown map and
`taskRoundCounters`, plus `RateTracker`) is the Phase 1 stand-in.

### History — three agent execution eras

1. **v6 and prior** — a hand-rolled, in-process agent loop (`src/agent/
   {agent,tools,toolSpecs,tiermuxProvider,lspTools,editLock,templates,
   textToolProtocol}.ts`) built and maintained entirely by TierMux.
2. **v7** — that loop was removed in favor of **OpenCode**: a separate,
   external-process agent CLI (bundled/auto-downloaded binary), spawned
   unmodified and routed to TierMux's own free-tier providers via an HTTP
   bridge (since removed) that exposed the Router as an
   OpenAI-compatible `/v1` endpoint. This traded owning the agent loop for
   OpenCode's session/tool management "for free."
3. **v8 (current)** — OpenCode was fully removed (2026-07). The bet in v7
   didn't pay off: OC's HTTP round-trip was lossy (a global forced-model
   race condition living in module-level singletons, permission state
   snapshotted once per turn and unable to react mid-turn) and each issue
   needed a hand-rolled workaround. Rather than replace one external agent
   with another, TierMux now builds directly on the **AI SDK** in-process
   (see "Agent core" above) — the same trade-off as v7 (don't reimplement
   the loop yourself) without the external-process/HTTP-bridge cost, and a
   direct in-process provider adapter passes model/task-kind/attachments/
   reasoning-effort as real per-call arguments, closing the v7 race-
   condition class by construction rather than patching it again.

---

## Key design decisions

1. **Prefer extension over replacement** — AI SDK capabilities are composed
   through providers, middleware, tools, callbacks, and policies before
   introducing new infrastructure. When a new AI SDK release grows an
   equivalent capability, the custom implementation is removed in favor of
   the SDK's (see `docs/sdk-upgrade.md`'s checklist).
2. **Dependency rule** — every layer depends only on the layer directly
   beneath it. UI never calls Router directly. Tools never call providers
   directly. `Router` never knows VS Code APIs *or* AI SDK APIs — it
   exposes `route(request): RouteResult` and nothing about
   `LanguageModel`/`Tool`/`streamText` leaks into it.
3. **AI SDK owns execution, TierMux owns orchestration and routing** — the
   agent core configures the AI SDK (`streamText`, `toolApproval`,
   `wrapLanguageModel`) rather than reproducing its control flow. `runTurn()`
   stays a thin, direct call into `streamText()` — no wrapper class.
4. **Provider is an implementation detail** — the Router only sees catalog
   entries; adapters are pluggable.
5. **Closures over `runtimeContext`** — the AI SDK's `runtimeContext`/
   `ToolExecutionOptions.context` doesn't propagate as documented (verified
   empirically against `ai@7.0.34`); tools capture session data via
   closures instead. Re-check on every AI SDK upgrade (`docs/sdk-upgrade.md`).
6. **Local SecretStorage for keys** — keys live in `vscode.SecretStorage`,
   per VS Code install. No account, no cross-device sync, no managed keys.
7. **In-process, no loopback bridge** — v7's Router Proxy (HTTP, bound to
   `127.0.0.1`) no longer exists; the AI SDK's `LanguageModelV4` adapter
   walks the picker's chain directly in the same process. There is still no remote-TierMux option.
8. **No rollback to OpenCode** — the v8 removal was deliberate and total
   (no dual-engine toggle, no "native" naming implying an alternative
   engine still exists). There is no flip-back-to-OpenCode path.
