# TierMux Architecture


## Identity

**TierMux** = a VS Code extension that routes every AI request to the best
free model across 30 built-in LLM providers (plus unlimited user-defined
OpenAI-compatible endpoints), with automatic failover, key rotation,
rate-limit cooldowns, and quality-based escalation.

The coding agent is **Cline's SDK** (`@cline/agents` runs the loop, `@cline/core` supplies
the tools, prompt, rules, skills, compaction and MCP), in-process. TierMux owns what sits
around it: the model router and provider fleet underneath, the approval policy, sessions, and
the VS Code UI on top. It does not implement agent behavior — see
[CLINE_AGENT.md](CLINE_AGENT.md). The AI SDK (`ai`) is still used for TierMux's own one-shot
calls (titles, handoff notes, commit messages, inline completions).

```
chatViewProvider.ts → agent.ts → core/cline/clineEngine.ts (Cline AgentRuntime + @cline/core tools) →
  core/cline/routerModel.ts → router/picker.ts → 30 Built-in Providers (+ custom)
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
│  │  runAgentStream / runPlanStream                               │  │
│  └────────────────────────────────┬─────────────────────────────┘  │
│                                   │ dynamic import (vscode-free      │
│                                   │ above this line)                │
│  ┌────────────────────────────────▼─────────────────────────────┐  │
│  │  agent/core/cline/ — the host seams around Cline's SDK        │  │
│  │  clineEngine.ts   one turn: Cline tools + prompt + runtime    │  │
│  │  routerModel.ts   the picker as a Cline AgentModel            │  │
│  │  prepareTurn.ts   Cline compaction adapter (+ /compact)       │  │
│  │  clineRuntime.ts  loads the ESM-only @cline/* packages        │  │
│  └────────────────────────────────┬─────────────────────────────┘  │
│                                   │ Cline types stop here           │
│  ┌────────────────────────────────▼─────────────────────────────┐  │
│  │  Model picker (src/router/picker.ts) — AI-SDK-agnostic        │  │
│  │  - task table → intelligence-rank tail, never a dead end      │  │
│  │  - multi-provider failover with per-key rotation              │  │
│  │  - per-platform + per-key rate-limit cooldown                 │  │
│  │  - tool-incompatible + 404-deprecated quarantine              │  │
│  │  - round-robin platform diversity across the failover scan    │  │
│  │  - proactive rate-limit skip (rateTracker.ts)                 │  │
│  └────────────────────────┬─────────────────────────────────────┘  │
│                           │                                        │
│  ┌────────────────────────▼─────────────────────────────────────┐  │
│  │  30 Provider Adapters (src/providers/*.ts)                    │  │
│  │  28 OpenAI-compat (Groq, Mistral, Cerebras, gateways, …) +    │  │
│  │  Google + Cloudflare + custom OpenAI-compatible endpoints     │  │
│  └─────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

**Layering boundary**: Cline types (`@cline/shared`'s `AgentMessage`, `AgentModel`,
`AgentTool`, …) are used *inside* `agent/core/cline/` only. `agent.ts` exposes just TierMux's
own `AgentOpts`/`AgentResult`/`ToolEvent` — nothing above it (`chatViewProvider.ts`, the
webview) imports a Cline type. The picker never imports one either; `routerModel.ts` is the
only place the two meet. A Cline upgrade changes `agent/core/cline/` and nothing else.

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

### Agent — Cline, and its seams in `src/agent/core/cline/`

The agent is Cline's SDK; **read [CLINE_AGENT.md](CLINE_AGENT.md) before changing anything
here.** TierMux supplies only what a host must:

- **`routerModel.ts`** — every model request Cline makes is served from the picker's failover
  chain (key rotation, cooldowns, platform condemn) and reported back as Cline model events.
- **`../../permissions/policy.ts`** — Cline's `requestToolApproval`. Chain:
  `alwaysDeny → plan-mode profile → alwaysAllow → READ_ONLY_TOOLS → settings → ask`.
- **`clineEngine.ts`** — builds Cline's act/plan toolset with three host executors (the ask
  card, the editor wrapped to record the checkpoint baseline, skills), adds MCP tools in agent
  mode, and maps runtime events onto the `AgentOpts` callbacks.
- **`prepareTurn.ts`** — Cline's own compaction pipeline, adapted to the runtime hook.
- **`../routeOnce.ts`** — one non-agentic call for the utility callers (titles, handoff,
  commit messages, completions), through the AI SDK adapter in `routerProvider.ts`.
- **`../../toolArgs.ts`** — provider-side rescue of tool calls weak models write as text,
  mapped onto Cline's tool names and argument shapes.

`agent.ts` is the stable contract above: `AgentOpts`/`AgentResult`/`ToolEvent` and
`runAgentStream`/`runPlanStream`, which dynamically import the engine so `agent.ts` stays
`vscode`-free.

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
2. webview postMessage → chatViewProvider.handleSend(m); the turn is wrapped in Cline's
   <user_input mode="…"> (plus <mode_notice> after a Plan/Agent switch).
3. handleSend builds AgentOpts and calls runAgentStream | runPlanStream (agent.ts).
4. agent.ts dynamically imports core/cline/clineEngine.ts and calls runTurn(opts).
5. runTurn() builds Cline's toolset, prompt and rules, re-seeds Cline's AgentRuntime with the
   session transcript, and runs it with the TierMux AgentModel, the approval policy and
   Cline's compaction.
6. Each model request walks the picker's candidate chain → 1+ provider adapter calls (with
   failover/rotation/cooling) — entirely in-process, no HTTP hop.
7. Runtime events map onto the AgentOpts callbacks (onChunk, onTool, onReasoning, onStep,
   onError); ask_question drives the ask card, editor writes feed the checkpoints.
8. The run's transcript is persisted for the next turn; usage → UsageStore; the title is
   generated in the background via routeOnce.
```

---

## Two modes

Cline's presets decide the toolset; the approval policy enforces the same line.

| Mode | Tools offered | Notes |
|---|---|---|
| Plan (Cline `plan`) | `read_files`, `search_codebase`, `run_commands`, `fetch_web_content`, `skills`, `ask_question` | No editor. Every shell command asks. The plan is the answer; the user switches to Agent to carry it out. |
| Agent (Cline `act`) | the above plus `editor`, and every connected MCP server's tools | Read-only commands auto-run; writes and other commands follow the approval settings. |

---

## Async utilities (shipped, no agent involvement)

These bypass the agent loop and make one non-agentic call through
`routeOnce` (`src/agent/core/routeOnce.ts`):

- `inlineChat` (Cmd+I) — edit selection via `EditGate`.
- `commitMessage` (git SCM) — generate commit message from diff.
- `generateSessionTitle` — 2-5 word title from first message.
- `generateHandoff` — a handoff note for the session.

---

## Configuration surface

Settings (`package.json:contributes.configuration`) — `package.json` is the
authority; this is the shape, not the registry:

- `tiermux.agent.{maxStepsPerTurn, maxConcurrentRuns, requireWriteConfirmation,
  commandApproval, commandAllowlist, commandTimeoutMs, toolCompaction, diagTrace}`.
- `tiermux.completions.{enabled, model, debounceMs}`, `tiermux.utilityModel`.
- `tiermux.context.{includeOpenEditors, ambientSliceRadius}`.
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
or failover. The picker uses `supportsTools !== false` as its only hard
capability filter today; catalog tags are display-only.

### Performance Knowledge Base (SQLite) — Phase 4+

Three tables built after real usage patterns emerge:

| Table | Purpose | Written by |
|---|---|---|
| `models` | Static metadata, capability_bits | Catalog import |
| `runtime_health` | cooldown, latency, success_rate, 429 count | Router on every call |
| `benchmark_scores` | Offline eval scores | Bench command |

The current in-memory state (picker.ts's `modelHealth` cooldown map and
`taskRoundCounters`, plus `RateTracker`) is the Phase 1 stand-in.

### History — four agent execution eras

1. **v6 and prior** — a hand-rolled, in-process agent loop (`src/agent/
   {agent,tools,toolSpecs,tiermuxProvider,lspTools,editLock,templates,
   textToolProtocol}.ts`) built and maintained entirely by TierMux.
2. **v7** — that loop was removed in favor of **OpenCode**: a separate,
   external-process agent CLI (bundled/auto-downloaded binary), spawned
   unmodified and routed to TierMux's own free-tier providers via an HTTP
   bridge (since removed) that exposed the Router as an
   OpenAI-compatible `/v1` endpoint. This traded owning the agent loop for
   OpenCode's session/tool management "for free."
3. **v8** — OpenCode was fully removed (2026-07). The bet in v7
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
4. **Cline (current, 2026-09-23)** — the AI SDK loop plus TierMux's own tools, prompts,
   condense, plan structuring and sub-agent were a harness TierMux had to keep improving. The
   agent is now Cline's SDK, run in-process with the router as its model; TierMux keeps
   routing, providers and the UI. See [CLINE_AGENT.md](CLINE_AGENT.md).

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
3. **Cline owns the agent, TierMux owns routing, providers and UI** — no agent behavior is
   written in TierMux; the engine only wires Cline's runtime and tools to TierMux's model,
   approvals and UI.
4. **Provider is an implementation detail** — the Router only sees catalog
   entries; adapters are pluggable.
5. **Upgrade Cline, don't patch around it** — the `@cline/*` packages are pinned to one exact
   version and upgraded together; a gap in agent behavior is fixed by a Cline upgrade or
   upstream, not in TierMux (see [CLINE_AGENT.md](CLINE_AGENT.md#upgrading-cline)).
6. **Local SecretStorage for keys** — keys live in `vscode.SecretStorage`,
   per VS Code install. No account, no cross-device sync, no managed keys.
7. **In-process, no loopback bridge** — v7's Router Proxy (HTTP, bound to
   `127.0.0.1`) no longer exists; Cline's model is `routerModel.ts`, which walks the picker's
   chain directly in the same process. (Serving the router as a local endpoint again is the
   one way to unlock Cline's `ClineCore` and sub-agents — see CLINE_AGENT.md.)
8. **No rollback to OpenCode** — the v8 removal was deliberate and total
   (no dual-engine toggle, no "native" naming implying an alternative
   engine still exists). There is no flip-back-to-OpenCode path.
