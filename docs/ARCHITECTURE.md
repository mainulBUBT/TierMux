# TierMux Architecture


## Identity

**TierMux** = a VS Code extension that routes every AI request to the best
free model across 22 LLM providers, with automatic failover, key rotation,
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
chatViewProvider.ts → agent.ts → core/loop.ts (streamText) →
  core/routerProvider.ts → TierMux Router → 22+ Free Providers
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
│  │  loop.ts          runTurn(): builds the streamText() call     │  │
│  │  routerProvider.ts  Router → LanguageModelV4 protocol adapter │  │
│  │  policies/        the toolApproval permission policy          │  │
│  │  middleware/       telemetry (wrapLanguageModel)               │  │
│  │  tools/**          filesystem/shell/workspace/ui/mcp factories│  │
│  └────────────────────────────────┬─────────────────────────────┘  │
│                                   │ AI SDK types stop here          │
│  ┌────────────────────────────────▼─────────────────────────────┐  │
│  │  TierMux Router (src/router/router.ts) — AI-SDK-agnostic     │  │
│  │  - multi-provider failover with key rotation                 │  │
│  │  - per-platform + per-key rate-limit cooldown                │  │
│  │  - 1-minute preflight health cache + 1-token ping            │  │
│  │  - tool-incompatible + 404-deprecated quarantine             │  │
│  │  - quality-based escalation (exclude list, intel floor)      │  │
│  │  - complexity-aware latency preference                       │  │
│  │  - Smart Auto scoring (src/router/scoring.ts)                │  │
│  └────────────────────────┬─────────────────────────────────────┘  │
│                           │                                        │
│  ┌────────────────────────▼─────────────────────────────────────┐  │
│  │  22+ Provider Adapters (src/providers/*.ts)                  │  │
│  │  18 OpenAI-compat (Groq, Mistral, Cerebras, …) + Google +    │  │
│  │  Cloudflare + Cohere + custom OpenAI-compatible endpoints    │  │
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

### TierMux Router — `src/router/router.ts` (the heart)

- **Candidates pipeline:** `enabledByPriority()` → pin if specified → drop
  tool-incompatible / quarantined / deprecated → drop `exclude` set
  (escalation) → `maxIntelligenceRank` floor → `orderForTask()` reorder
  (user 👍/👎 score is primary) → prefer non-cooled platforms.
- **Per-candidate loop:** `MAX_RETRIES = 3` → preflight ping (1-min health
  cache) → proactive rate-limit check via `RateTracker` → `fitMessages` to
  context window → streaming or buffered completion.
- **Failure handling:** classify error → 429 cool the key, rotate the pool
  (or cool the platform); 401/403 → invalid; bad request + tools → 10-min
  tool-incompatible quarantine; 404 → 24-h deprecated quarantine.
- **Streaming:** `onChunk` deltas flow through; tool-call turns are buffered
  and emitted as one chunk.
- **On `AllModelsFailedError`:** throws with a detailed message naming which
  providers failed and why (key missing, rate-limited, deprecated, rejected
  key, etc.) — `chatViewProvider.ts`'s catch handler (`maybeRecommendModels`)
  turns this into a concrete "enable these free models" prompt instead of a
  bare error.

### Provider adapters — `src/providers/*.ts`

18 OpenAI-compat providers (Groq, Mistral, Cerebras, OpenRouter, etc.) +
bespoke adapters for Google Gemini and Cloudflare Workers AI + Cohere +
arbitrary `custom` OpenAI-compatible endpoints. Untouched by the OpenCode
removal / AI SDK migration — the Router calls them exactly as before.

### Agent core — `src/agent/core/`

The in-process agent engine, built directly on the AI SDK. Nothing above
this layer (`agent.ts`, `chatViewProvider.ts`, the webview) ever imports an
AI SDK type — see the Layering boundary note above.

- **`loop.ts`** — `runTurn(router, opts)`, the one place `streamText()` is
  called. Deliberately a thin, direct function — not wrapped in a
  `TierMuxAgentRunner`/`ExecutionManager`/`LoopManager` class. Consumes
  `result.fullStream` directly (text-delta/reasoning-delta/tool-call/
  tool-result/tool-error parts), mapping each to the existing `AgentOpts`
  callbacks (`onChunk`, `onReasoning`, `onTool`, …). Also forwards two SDK
  lifecycle callbacks (`onStart`/`onStepStart`) to `opts.onStep` as a thin
  projection — no new phase-tracking state of its own.
- **`routerProvider.ts`** — `createRouterProvider(router, opts)`: a *pure*
  protocol adapter implementing `LanguageModelV4` (`doGenerate`/`doStream`)
  by translating to/from `Router.route()`. No routing decisions, no scoring,
  no failover logic here — that's entirely `Router.route()`'s job. Also
  forwards `onFailover`/`onKeyRotated`/`onSelectionRationale` (Smart Auto's
  "why this model?" rationale) straight through from `RouteOptions`.
- **`policies/permission.ts`** — `createToolApproval(opts)`, passed as
  `streamText`'s native `toolApproval` option (the AI SDK's own tool-
  execution gate — a denied verdict means the tool's `execute()` never runs
  at all, not just that its effect is discarded). Mode gate, live read-only
  command classification, dangerous-pattern override, then the existing
  `onPermissionAsk` UI callback.
- **`middleware/telemetry.ts`** — `createTelemetryMiddleware({profiler,
  traceId})`, profiler instrumentation via `wrapLanguageModel()` instead of
  manual timer calls.
- **`tools/**`** — one `create*Tool()` factory per tool
  (`filesystem/{read,write,edit,delete}`, `shell/bash`, `workspace/
  {list,glob,grep}`, `ui/{todo,question}`, `mcp/mcp`), assembled by
  `tools/index.ts`'s `createToolSet(opts, mcp)` into the mode's actual tool
  set (see "Three modes" below). MCP tools are registered as ordinary
  `tool()` objects — nothing in the loop/tool-set builder can tell an
  MCP-backed tool apart from a built-in one.
  Tools capture session data (session id, `onTodos`, `onAskUser`) via
  closures rather than the AI SDK's `runtimeContext`/`ToolExecutionOptions.
  context` — that mechanism was verified empirically **not** to propagate
  as documented in `ai@7.0.34` (see the comment in `tools/index.ts` and
  `docs/sdk-upgrade.md`, which also has the full upgrade checklist).

`agent.ts` is the stable contract above `core/`: `AgentOpts`/`AgentResult`/
`ToolEvent`, and `runAgentStream`/`runPlanStream`/`runAskStream` (each just
sets `mode` and dynamically imports `core/loop.ts` — dynamic so `agent.ts`
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
4. agent.ts dynamically imports core/loop.ts and calls runTurn(router, opts).
5. runTurn() calls streamText({ model: wrapLanguageModel(createRouterProvider(router, …)),
   tools: createToolSet(opts, mcp), toolApproval: createToolApproval(opts), … }).
6. Each doGenerate/doStream call inside the provider adapter calls
   Router.route() → 1+ provider adapter calls (with failover/rotation/cooling) —
   entirely in-process, no HTTP hop.
7. runTurn() consumes result.fullStream directly, mapping text-delta/
   reasoning-delta/tool-call/tool-result/tool-error parts onto the AgentOpts
   callbacks (onChunk, onTool, onReasoning, onTodos, onStep, onError).
8. On stream end: finish with accumulated text. Token usage → UsageTracker
   (incremented inside Router.route() itself, independent of the AI SDK
   layer) + UsageStore. Title generation fires in the background.
```

---

## Three modes

| Mode | Tools attached | Streaming via Router? | Notes |
|---|---|---|---|
| Ask | 0 (none) | yes | Pure conversational Q&A — no file/tool access at all (see `ASK_MODE_TAIL` in `promptBuilder.ts`). |
| Plan | 6 (read-only + `todowrite` + `question`) | no (tools non-empty) | Read-only: no `writeFile`/`createFile`/`editFile`/`deleteFile`/`runCommand`. Also has its own `???QUESTIONS???` text-sentinel pre-flight clarify channel, independent of the `question` tool. |
| Agent | 11 (full set) | no (tools non-empty) | Everything, including MCP tools if configured. |

`Router.route()`'s `wantsStream` gate (`router.ts`) only streams when
`tools` is empty — Plan/Agent always have tools attached, so they always
take the buffered path; Ask, since it now carries zero tools, is the only
mode that streams through Router. The buffered path has a token-estimate
fallback (`estimateMessagesTokens`/`estimateTokens`) for providers that
omit or zero-fill `usage` on their response, matching the one the
streaming path already had.

---

## Async utilities (shipped, no agent involvement)

These bypass the agent core entirely and call `Router.route()` directly:

- `inlineChat` (Cmd+I) — edit selection via `EditGate`.
- `commitMessage` (git SCM) — generate commit message from diff.
- `generateSessionTitle` — 2-5 word title from first message.
- `condenseHistory` — long-context compaction.

---

## Configuration surface

Settings (`package.json:contributes.configuration`):

- `tiermux.fallback` — fallback chain.
- `tiermux.endpoints` — per-platform base URL overrides.
- `tiermux.disabledProviders` — excluded providers.
- `tiermux.customEndpoints` — custom OpenAI-compatible endpoints.
- `tiermux.agent.{maxIterations, maxConcurrentRuns, requireWriteConfirmation,
  commandApproval, commandTimeoutMs, commandAllowlist, autoCompactThreshold}`.
- `tiermux.context.{includeOpenEditors, ambientSliceRadius, ambientMaxChars,
  ambientMaxTabs}`.
- `tiermux.tools.{web, exaApiKey, braveApiKey, searchEndpoint,
  searchProviderPriority}`.
- `tiermux.embeddings.{enabled, provider, model, autoContext, batchSize,
  requestDelayMs, rerank}`.
- `tiermux.cache.{fileEnabled, searchEnabled, searchTtlMs, researchEnabled}`.
- `tiermux.usage.{referencePriceInPer1M, referencePriceOutPer1M}`.
- `tiermux.catalog.url` — remote CSV for the model catalog.
- `tiermux.{mcpServers, mcpRegistryUrl, mcpRegistrySearchUrl}`.

Secret storage (`vscode.SecretStorage`): `tiermux.key.<platform>`,
`tiermux.keys.<platform>`, `tiermux.modelKey.<platform>::<modelId>`, plus
the same shape for custom endpoints.

---

## Roadmap (Phase 3+ — not yet implemented)

The pieces below are **design targets**, not current behavior. They are
preserved here as a forward-looking spec; the code does not implement them
today.

### Adaptive Orchestrator — `ExecuteRequest` / `ExecutionEvent` / `ExecutionPolicy` (CHAT | AGENT | INLINE | BACKGROUND)

The current `Router` is the classic multi-provider failover cascade. The
future design is a single `AdaptiveOrchestrator.execute()` that:

- Takes a typed `ExecuteRequest` (messages, mode, model, policy, signal).
- Returns `AsyncIterable<ExecutionEvent>` (`model_chosen`, `provider_switch`,
  `streaming_chunk`, `streaming_end`, `error`, `quota_update`).
- Owns the PKB sort + selection loop + continuation logic.
- Is the single entry point for every model call (CHAT, AGENT, INLINE,
  BACKGROUND).

### `Router.capabilities(needs)` — pure capability resolver

A new public API on the Router that answers "which models can do this
task?" without ordering or failover. Capability bits (CODING | REASONING
| VISION | TOOLS | LONG_CTX | CHEAP | FAST) are already present on
`CatalogModel` (see `capability_bits` in the catalog schema) but not yet
consumed by routing logic — `Router.candidates` still uses
`supportsTools !== false` as its only capability filter.

### Performance Knowledge Base (SQLite) — Phase 4+

Three tables built after real usage patterns emerge:

| Table | Purpose | Written by |
|---|---|---|
| `models` | Static metadata, capability_bits | Catalog import |
| `runtime_health` | cooldown, latency, success_rate, 429 count | Router on every call |
| `benchmark_scores` | Offline eval scores | Bench command |

The current in-memory state (`Router.lastGood`, `health` map, `rateTracker`,
`latencyTracker`) is the Phase 1 stand-in.

### History — three agent execution eras

1. **v6 and prior** — a hand-rolled, in-process agent loop (`src/agent/
   {agent,tools,toolSpecs,tiermuxProvider,lspTools,editLock,templates,
   textToolProtocol}.ts`) built and maintained entirely by TierMux.
2. **v7** — that loop was removed in favor of **OpenCode**: a separate,
   external-process agent CLI (bundled/auto-downloaded binary), spawned
   unmodified and routed to TierMux's own free-tier providers via an HTTP
   bridge (`src/backend/routerProxy.ts`) that exposed the Router as an
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
   `127.0.0.1`) no longer exists; the AI SDK calls `Router.route()` directly
   in the same process. There is still no remote-TierMux option.
8. **No rollback to OpenCode** — the v8 removal was deliberate and total
   (no dual-engine toggle, no "native" naming implying an alternative
   engine still exists). There is no flip-back-to-OpenCode path.
