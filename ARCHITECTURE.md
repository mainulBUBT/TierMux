# TierMux Architecture

> **Reading guide:** sections marked **🚢 Shipped in v0.1.0-beta.6** describe
> what the codebase actually does today. Sections marked **🛣️ Roadmap (Phase
> 3+)** describe the future design target — they're not yet implemented and
> should be treated as design notes, not behavior contracts.

## Identity

**TierMux** = a VS Code extension that routes every AI request to the best
free model across 22 LLM providers, with automatic failover, key rotation,
rate-limit cooldowns, and quality-based escalation.

Agent execution is delegated to **OpenCode** (bundled or auto-downloaded
binary, spawned unmodified). TierMux exposes its own Router as a single
OpenAI-compatible `/v1` endpoint that OC points at, so every model call OC
makes is transparently routed across free tiers.

Pinned OpenCode version: **v1.17.11** (see `scripts/fetch-opencode.mjs`).

```
OpenCode → Router Proxy → TierMux Router → 22+ Free Providers
```

---

## Layer diagram (shipped)

```
┌────────────────────────────────────────────────────────────────────┐
│                       TierMux VS Code Extension                    │
│                                                                    │
│  ┌──────────────┐  ┌────────────────┐  ┌────────────────────────┐  │
│  │ TierMux UI   │  │ OcClient       │  │ Router Proxy           │  │
│  │ (webview)    │──│ (HTTP + SSE)   │──│ (HTTP bridge, loopback)│  │
│  └──────┬───────┘  └────────┬───────┘  └────────────┬───────────┘  │
│         │                   │                        │              │
│  ┌──────▼───────────────────▼────────────────────────▼───────────┐  │
│  │  agent/sdk.ts  (engine boundary — single entry point)         │  │
│  │  runChatStream / runAgentStream / runPlanStream              │  │
│  │  generateSessionTitle (direct Router)                        │  │
│  └────────────────────────┬─────────────────────────────────────┘  │
│                           │                                        │
│  ┌────────────────────────▼─────────────────────────────────────┐  │
│  │  TierMux Router (src/router/router.ts)                       │  │
│  │  - multi-provider failover with key rotation                 │  │
│  │  - per-platform + per-key rate-limit cooldown                │  │
│  │  - 1-minute preflight health cache + 1-token ping            │  │
│  │  - tool-incompatible + 404-deprecated quarantine             │  │
│  │  - quality-based escalation (exclude list, intel floor)      │  │
│  │  - complexity-aware latency preference                       │  │
│  └────────────────────────┬─────────────────────────────────────┘  │
│                           │                                        │
│  ┌────────────────────────▼─────────────────────────────────────┐  │
│  │  22+ Provider Adapters (src/providers/*.ts)                  │  │
│  │  18 OpenAI-compat (Groq, Mistral, Cerebras, …) + Google +    │  │
│  │  Cloudflare + Cohere + custom OpenAI-compatible endpoints    │  │
│  └─────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
                             │ HTTP
┌────────────────────────────▼───────────────────────────────────────┐
│  opencode serve (bundled binary, loopback)                         │
│  Agent loop │ Tool execution │ Context building │ Session mgmt     │
│  Provider:  http://127.0.0.1:<proxyPort>/v1 (the Router Proxy)    │
└────────────────────────────────────────────────────────────────────┘
```

---

## Shipped components

### Router Proxy — `src/backend/routerProxy.ts`

Dumb HTTP bridge. No session state, no retry, no SSE state machine — those
belong to the Router and to OC respectively. Pure protocol translation.

- `GET /v1/models` — returns virtual routing profiles (`tiermux/auto|fast|smart`)
  + every enabled catalog model as `platform::modelId`.
- `POST /v1/chat/completions` — accepts OpenAI shape, calls
  `router.route()`, streams the response back as SSE.
- Profile mapping: `tiermux/auto` → auto-routing, `tiermux/fast` → chat
  profile (fastest), `tiermux/smart` → agent profile (smartest tool-capable).
- Binds to `127.0.0.1:0` (OS-assigned ephemeral port). CORS `*` (loopback
  only).
- 5 min launch timeout in `ocLauncher.ts` covers slow first-run binary
  downloads on poor networks.

### TierMux Router — `src/router/router.ts` (the heart, 648 LOC)

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
  key, etc.) — surfaced to the chat footer.

### Provider adapters — `src/providers/*.ts`

18 OpenAI-compat providers (Groq, Mistral, Cerebras, OpenRouter, etc.) +
bespoke adapters for Google Gemini and Cloudflare Workers AI + Cohere +
arbitrary `custom` OpenAI-compatible endpoints. No file deletion happened
during the v7 migration; adapters are unchanged from prior versions.

### OpenCode integration — `src/backend/`

- `ocBinary.ts` — resolver: `OPENCODE_BIN` env → bundled
  `resources/bin/{os}/{arch}/opencode[.exe]` → cached
  `globalStorage/bin/opencode` → first-run download (10-min timeout) →
  system PATH.
- `ocLauncher.ts` — spawns `opencode serve --port 0 --hostname 127.0.0.1`;
  resolves on stdout regex `opencode server listening on (https?://\S+)`;
  5-min launch timeout; SIGTERM → SIGKILL on shutdown.
- `ocConfig.ts` — builds the JSON injected via `OPENCODE_CONFIG_CONTENT` env:
  one `tiermux` provider using `@ai-sdk/openai-compatible` with `auto`,
  `fast`, `smart` virtual models.
- `ocClient.ts` — raw `fetch` HTTP/SSE client. Centralized `PATHS` map for
  REST endpoints. SSE reader splits on `\n\n` frames, reconnects with 1.5 s
  backoff on transient errors.
- `ocDiagnostics.ts` — `tiermux.testOcBridge` command: probes the proxy
  (`/v1/models`, `/v1/chat/completions`) and OC paths, reports a
  pass/fail summary.
- `engineLog` — Output channel "TierMux Engine" surfaces proxy URL,
  download progress, OC stdout/stderr, startup errors, and (when
  `tiermux.engine.traceOcEvents` is on) raw SSE frames.

### Engine boundary — `src/agent/sdk.ts`

The only file `chatViewProvider` calls for an agent run. Public API
preserved from prior versions: `runChatStream`, `runAgentStream`,
`runPlanStream`, `generateSessionTitle`. All three `run*Stream` functions
funnel through `runViaOc`, which:

- Creates or reuses an OC session keyed by TierMux session id (OC holds
  history server-side).
- Subscribes to `/global/event`, filters by sessionID, maps the event
  stream to `AgentOpts` callbacks.
- Handles `message.part.delta` (streaming), `message.part.updated` (full
  content), `tool.updated`, `todo.updated`, `session.status`,
  `session.error`, `session.idle`.
- On `session.idle` with no accumulated text, fetches session messages as
  a fallback so we always return *something* when OC did produce output.

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
   runChatStream | runAgentStream | runPlanStream (sdk.ts).
4. sdk.ts:runViaOc → OcClient.createSession + OcClient.prompt
   (POST /session/{id}/prompt).
5. Concurrent: OcClient.subscribe connects to GET /global/event (SSE).
6. OC's build/plan agent calls our tiermux provider
   (POST /v1/chat/completions on the Router Proxy).
7. Router Proxy → Router.route() → 1+ provider adapter calls
   (with failover/rotation/cooling).
8. Stream back as SSE chunks through the Router Proxy → OC → SSE bus.
9. sdk.ts maps OC event frames to AgentOpts callbacks
   (onChunk, onTool, onReasoning, onTodos, onStep, onError).
10. on idle: finish with accumulated text. Token usage → UsageTracker
    + UsageStore. Title generation fires in the background.
```

---

## Three modes

| Mode | Profile sent to OC | OC agent | Streaming? | Tools? |
|---|---|---|---|---|
| Ask | `tiermux/fast` | `build` | yes | no |
| Plan | `tiermux/smart` | `plan` | yes | no (read-only) |
| Agent | `tiermux/smart` | `build` | yes | yes |

---

## Async utilities (shipped, no agent involvement)

These bypass OC and call `Router.route` directly:

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
- `tiermux.useOpenCodeEngine` (default `true`, `[EXPERIMENTAL]`) — flip to
  disable OC. With OC off, chat/agent runs do not work in v7 (the built-in
  agent loop was removed).
- `tiermux.engine.traceOcEvents` (default `false`) — log raw OC SSE frames
  to the "TierMux Engine" output channel. Useful for debugging.
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

The v7 in-memory state (`Router.lastGood`, `health` map, `rateTracker`,
`latencyTracker`) is the Phase 1 stand-in.

### Built-in agent loop (v6 and prior)

Removed in v7.0. OpenCode supplies agent prompts, tool definitions
(grep/glob/readFile/writeFile/editFile/runCommand/webSearch/webFetch/
todowrite/askuserquestion/getDiagnostics), and session management. The
legacy `src/agent/{agent,tools,toolSpecs,tiermuxProvider,lspTools,
editLock,templates,textToolProtocol}.ts` files were deleted during the v7
migration.

---

## Key design decisions

1. **OpenCode unmodified** — bundled binary, never fork. Updates = replace
   the binary in `resources/bin/`. Currently pinned to v1.17.11.
2. **Router Proxy is dumb** — no logic, just HTTP translation. The Router
   owns failover, not the proxy.
3. **One engine** — TierMux's built-in agent loop was removed in v7. OC is
   the only agent engine. Disabling it via `tiermux.useOpenCodeEngine =
   false` will leave chat/agent runs non-functional in v7.
4. **Provider is an implementation detail** — the Router only sees
   catalog entries; adapters are pluggable.
5. **OC is session source of truth** — `sdk.ts` keeps a `TierMux sessionId
   → OC sessionId` map; the chat view's `s.history` mirrors what the
   webview persists (user/assistant text), not the full tool rounds.
6. **Local SecretStorage for keys** — keys live in `vscode.SecretStorage`,
   per VS Code install. No account, no cross-device sync, no managed keys
   in v7.
7. **Loopback only** — Router Proxy binds to `127.0.0.1`. There is no
   remote-TierMux option in v7.
8. **Legacy code removed only after parity confirmed** — the v7 migration
   deletes the legacy `src/agent/{agent,tools,…}.ts` and `src/bench/` only
   after the OC bridge is verified end-to-end.
