# TierMux Architecture

## Identity

**TierMux** = VS Code extension providing free LLM access with intelligent routing.  
Agent execution is delegated to **OpenCode** (bundled binary, unmodified).  
TierMux's unique value = **Adaptive Orchestrator** — smart, seamless, free-tier optimized.

```
OpenCode → Router Proxy → Adaptive Orchestrator → TierMux Router → 26+ Free Providers
```

---

## Layer Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                    TierMux VS Code Extension                     │
│                                                                  │
│  ┌──────────────┐  ┌────────────────┐  ┌────────────────────┐   │
│  │ TierMux UI   │  │ OpenCodeClient │  │ Router Proxy       │   │
│  │ (webview)    │──│ (HTTP + SSE)   │──│ (dumb HTTP bridge) │   │
│  └──────────────┘  └───────┬────────┘  └─────────┬──────────┘   │
│                            │                     │               │
│  ┌─────────────────────────▼─────────────────────▼────────────┐  │
│  │              Adaptive Orchestrator                         │  │
│  │  TierMux's moat — all execution decisions                 │  │
│  │                                                           │  │
│  │  execute(request: ExecuteRequest)                         │  │
│  │    → AsyncIterable<ExecutionEvent>                        │  │
│  │                                                           │  │
│  │  ┌─────────────┐  ┌──────────────────┐  ┌─────────────┐  │  │
│  │  │ Need        │  │ Execution        │  │ Execution   │  │  │
│  │  │ Analysis    │  │ Session          │  │ Policy      │  │  │
│  │  └──────┬──────┘  └──────────────────┘  └─────────────┘  │  │
│  │         │                                                  │  │
│  │  ┌──────▼─────────────────────────────────────────┐       │  │
│  │  │ Capability → Candidate Generation               │       │  │
│  │  │ (need → eligible models → PKB sort → select)    │       │  │
│  │  └──────┬─────────────────────────────────────────┘       │  │
│  │         │                                                  │  │
│  │  ┌──────▼─────────────────────────────────────────┐       │  │
│  │  │ Provider Selection Loop                        │       │  │
│  │  │ (try, monitor, continue with next on failure)   │       │  │
│  │  └────────────────────────────────────────────────┘       │  │
│  └────────────────────────────────────────────────────────────┘  │
│                           │                                      │
│  ┌────────────────────────▼────────────────────────────────────┐ │
│  │  TierMux Router — Capability Resolver                       │ │
│  │  capabilities(needs: Need[]) → EligibleModel[]              │ │
│  │  Answers: "these models can do this"                        │ │
│  │  No ordering decisions. No failover logic. Pure capability. │ │
│  └────────────────────────┬────────────────────────────────────┘ │
│                           │                                      │
│  ┌────────────────────────▼────────────────────────────────────┐ │
│  │  26+ Provider Adapters (unchanged from existing codebase)   │ │
│  │  Gemini, Groq, Mistral, Cerebras, OpenRouter, etc.         │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
                            │ HTTP
┌───────────────────────────▼──────────────────────────────────────┐
│  OpenCode serve (bundled binary, unmodified upstream)           │
│  Agent loop │ Tool execution │ Context building │ Session mgmt  │
│  Provider: http://localhost:{proxyPort}/v1/chat/completions     │
└──────────────────────────────────────────────────────────────────┘
```

---

## Components

### Router Proxy (`src/backend/routerProxy.ts`) ~70 loc

**Dumb HTTP bridge. No logic.**

- `GET /v1/models` → returns catalog models in OpenAI format
- `POST /v1/chat/completions` → calls `AdaptiveOrchestrator.execute()`, streams response
- NO session management
- NO telemetry
- NO retry logic
- NO SSE mapping
- Pure protocol translation

### Adaptive Orchestrator (`src/engine/adaptiveExecutionEngine.ts`) ~800 loc

**TierMux's moat. All execution decisions live here.**

Public API (frozen):

```typescript
interface ExecuteRequest {
  messages: ChatMessage[];
  mode: ExecutionMode;   // 'CHAT' | 'AGENT' | 'INLINE' | 'BACKGROUND'
  model?: string;
  policy?: Partial<ExecutionPolicy>;
  signal?: AbortSignal;
}

type ExecutionEvent =
  | { type: 'model_chosen'; platform: string; model: string; reason: string }
  | { type: 'provider_switch'; from: string; to: string; reason: string }
  | { type: 'streaming_chunk'; text: string }
  | { type: 'streaming_end'; usage?: TokenUsage }
  | { type: 'error'; fatal: boolean; message: string; recoverable?: boolean }
  | { type: 'quota_update'; platform: string; remaining: number };

interface AdaptiveOrchestrator {
  execute(request: ExecuteRequest): AsyncIterable<ExecutionEvent>;
}
```

Pipeline:
1. **Need Analysis** — classify task → capability requirements
2. **Capability Matching** — Router.capabilities(needs) → eligible models
3. **PKB Sort** — performance.db → sort by success_rate, latency, cooldown
4. **Selection Loop** — try → monitor → on failure: try next, seamless continuation
5. **Stream** — forward streaming chunks through events

### TierMux Router — Capability Resolver (`src/router/router.ts`, modified) ~500 loc

**Answers: "which models can do this task?"**

- Receives `Need[]` (capability requirements)
- Returns `EligibleModel[]` (filtered by capability bits)
- No ordering decisions
- No failover logic
- `orderForTask()` becomes `capabilities(needs)` — pure capability-based filtering

### Provider Adapters (`src/providers/*.ts`) — unchanged

26+ free provider implementations. No changes needed.

---

## Execution Policies (4 modes)

```typescript
type ExecutionPolicy = {
  maxRetries: number;
  maxLatencyMs: number;
  allowProviderSwitch: boolean;
  allowContextTrim: boolean;
  allowReasoningFallback: boolean;
  preferCheap: boolean;
  preferFast: boolean;
  telemetryLevel: 'minimal' | 'normal' | 'full';
};

const POLICIES = {
  CHAT:       { maxRetries: 3, maxLatencyMs: 30000, allowProviderSwitch: true,  /* ... */ },
  AGENT:      { maxRetries: 2, maxLatencyMs: 60000, allowProviderSwitch: false, /* ... */ },
  INLINE:     { maxRetries: 1, maxLatencyMs: 5000,  allowProviderSwitch: false, /* ... */ },
  BACKGROUND: { maxRetries: 1, maxLatencyMs: 10000, allowProviderSwitch: true,  /* ... */ },
};
```

All execution goes through Orchestrator with appropriate policy:
- **CHAT** — sidebar chat, user-facing
- **AGENT** — tool-using coding sessions, needs stability
- **INLINE** — quick edits at cursor, needs speed
- **BACKGROUND** — title gen, commit messages, compact, metadata

---

## Performance Knowledge Base (Phase 4+)

Three SQLite tables, built after real usage patterns emerge:

| Table | Purpose | Written by |
|-------|---------|-----------|
| `models` | Static metadata, capability_bits | Catalog import |
| `runtime_health` | cooldown, latency, success_rate, 429 count | Router on every call |
| `benchmark_scores` | Offline eval scores | Bench command |

Not built in Phase 1. In-memory state suffices for initial Orchestrator development.

---

## Data Flow (End to End)

```
1. User types message in TierMux webview
2. Extension → OpenCodeClient.sendMessage()
3. OpenCodeClient → HTTP POST to OpenCode serve
4. OpenCode serve → POST /v1/chat/completions to Router Proxy
5. Router Proxy → AdaptiveOrchestrator.execute()
6. Orchestrator:
   a. Need Analysis: classify task, extract capability requirements
   b. Router.capabilities(needs) → eligible models
   c. PKB sort + policy filter → ordered candidate list
   d. Selection loop: try best candidate
      - Success → stream response
      - 429/timeout/error → try next (seamless continuation)
7. Streaming chunk → Router Proxy → OpenCode → OpenCodeClient → Webview
8. OpenCode handles tool execution, edits, context
9. Webview renders streaming response (same as today)
```

---

## Migration Plan

| Phase | What | Duration | No file deletion |
|-------|------|----------|------------------|
| **P1** | Router Proxy + OpenCode binary download + spawn | 1 week | ❌ |
| **P2** | Adaptive Orchestrator v1 (in-memory PKB) | 1 week | ❌ |
| **P3** | All extension-host calls through Orchestrator with BACKGROUND policy | 2 days | ❌ |
| **P4** | Performance DB (SQLite) + Telemetry + Bench | 1 week | ❌ |
| **P5** | Parity check → move legacy files to `src/legacy/` | 1 week | ✅ move |
| **Cleanup** | Wait 2 releases → delete `src/legacy/` | — | ✅ delete |

Legacy files moved (never deleted before parity confirmed):
- `src/agent/` → `src/legacy/agent/`
- `src/context/` → `src/legacy/context/`
- `src/index/` → `src/legacy/index/`
- `src/edits/` → `src/legacy/edits/`

---

## Model Catalog

Remote CSV (existing approach, enhanced):

```csv
platform,modelId,displayName,intelligenceRank,speedRank,contextWindow,capability_bits,tags
groq,llama-4-scout-17b,Llama 4 Scout,5,1,16384,39,code"fast"cheap
```

`capability_bits` bitmask:
- 1 = CODING, 2 = REASONING, 4 = VISION, 8 = TOOLS, 16 = LONG_CTX (≥128K), 32 = CHEAP, 64 = FAST

---

## Key Design Decisions

1. **OpenCode unmodified** — binary bundle, never fork. Updates = replace binary.
2. **Router Proxy is dumb** — no logic, just HTTP translation.
3. **Adaptive Orchestrator is the moat** — all intelligence in one place.
4. **Provider is an implementation detail** — Orchestrator only sees capabilities.
5. **All execution through Orchestrator** — CHAT, AGENT, INLINE, BACKGROUND — same engine.
6. **No dual session state** — OpenCode is session source of truth.
7. **Continuation, not failover** — preserve context, seamless model switching.
8. **PKB after real data** — in-memory first, SQLite when patterns emerge.
9. **Legacy preserved until parity confirmed** — compare, then migrate.
10. **Everything can be remote-hosted** — catalog, routing, telemetry, config.
