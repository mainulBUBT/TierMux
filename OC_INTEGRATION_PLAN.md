# OpenCode Integration Plan

## Goal

Make **OpenCode (OC)** the agent engine for Plan and Agent modes (native tool loop,
diffs-for-approval, checkpoints, context windowing), while TierMux keeps its UI and
owns **model routing** — exposed as a single OpenAI-compatible endpoint OC calls.

```
TierMux webview (media/main.js)            ← TierMux UI (kept)
      │  drives OC over its REST/SSE SDK
      ▼
OpenCode `serve` (bundled binary)          ← NATIVE plan/agent loop, tools, sessions
      │  thinks it's calling one OpenAI-compatible provider
      ▼
TierMux Router Proxy (src/backend/routerProxy.ts)   ← /v1/models + /v1/chat/completions
      ▼
TierMux Router                              ← picks real free model, failover, cooldowns, cost
      ▼
22+ free provider adapters
```

Division of labor: **OC owns the *how*** (agent loop, tools), **TierMux owns the *who***
(model selection + failover behind one provider). This is `ARCHITECTURE.md` Phase 1–2.

## Three product pillars

Each = an OC agent × a TierMux routing profile.

| Pillar | OC agent | Routing profile | Router behavior |
|---|---|---|---|
| ⚡ Fast | `build` | `tiermux/fast` | speed-first (`orderForTask` trivial/chat branch), short timeout |
| 📋 Plan | `plan` (read-only) | `tiermux/smart` | intelligence-first, reasoning, long context |
| 🧠 Agent | `build` | `tiermux/smart` | intelligence-first, tools, quality escalation |

OC only ever sees two agents (`build`, `plan`) and three virtual models
(`tiermux/auto`, `tiermux/fast`, `tiermux/smart`). The UI composes them into the three
buttons. `Ask` = OC `plan` + `tiermux/fast`, or keep TierMux's lightweight built-in path.

## Status

**OpenCode is now the SOLE agent engine. The built-in agent and the entire Vercel AI SDK
(`ai`, `@ai-sdk/openai`, `@ai-sdk/*`, `zod`) have been removed.** No second engine, no
fallback — when OC isn't connected, runs surface a clear "engine not running" error.

- ✅ **Router proxy** — `src/backend/routerProxy.ts`. `/v1/models` + `/v1/chat/completions`.
- ✅ **OC binary resolver / config / launcher** — `ocBinary.ts`, `ocConfig.ts`, `ocLauncher.ts`.
  Spawns `opencode serve`, injects the `tiermux` provider via `OPENCODE_CONFIG_CONTENT`.
- ✅ **OC client** — `src/backend/ocClient.ts`. REST/SSE over OC (createSession, prompt,
  abort, messages, subscribe to `/global/event`).
- ✅ **Engine boundary rewritten** — `src/agent/sdk.ts` is now OC-only (no AI SDK).
  `runChatStream/runAgentStream/runPlanStream` drive OC and relay SSE events into the
  unchanged `AgentOpts` callback contract. `chatViewProvider` is logic-unchanged.
- ✅ **Legacy agent deleted** — `agent.ts`, `tools.ts`, `tiermuxProvider.ts`, `lspTools.ts`,
  `toolSpecs.ts`, `textToolProtocol.ts`, `editLock.ts`, `templates.ts`, and `src/bench/`
  removed. `Mode` → `shared/types.ts`, `splitReasoning` → `agent/content.ts`.
- ✅ **ToolCache shim** — `src/agent/toolCache.ts` keeps the cache UI alive as no-ops.
- ✅ **Deps dropped** — `ai`, `@ai-sdk/openai`, `zod` removed; bundle 2.45MB → 1.21MB.
- ✅ **Packaging** — `scripts/fetch-opencode.mjs` + npm `fetch:binaries` / `package:full`. Pinned to OpenCode v1.17.11.
- ✅ **Diagnostics** — `tiermux.testOcBridge` exercises proxy + OC paths.
- ✅ **End-to-end verified** against the pinned v1.17.11 build (binary bundled at `resources/bin/macos/arm64/opencode`):
  - `GET /v1/models` → 200 (proxy lists virtual `tiermux/auto|fast|smart` + every enabled catalog model)
  - `POST /v1/chat/completions` → 200 (routed completion through TierMux)
  - OC `POST /session` → 200 (session created; agent + model pinned via the request body)
  - OC `GET /app/agents`, `/agents`, `/global/event` → 200
  - OC SSE event stream feeds `sdk.ts:runViaOc` for `chat`, `agent`, and `plan` modes.

## OC provider config (the wire-up)

OC supports custom OpenAI-compatible providers natively
([ref: opencode `src/config/provider.ts`](https://github.com/paviko/opencode-ide-plugin/blob/main/packages/opencode/src/config/provider.ts)).
Generate this at runtime with the proxy's chosen port:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "tiermux": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "TierMux",
      "options": { "baseURL": "http://127.0.0.1:<PROXY_PORT>/v1", "apiKey": "local" },
      "models": {
        "auto":  { "name": "Auto",  "limit": { "context": 128000, "output": 8000 } },
        "fast":  { "name": "Fast",  "limit": { "context": 128000 } },
        "smart": { "name": "Smart", "limit": { "context": 200000 } }
      }
    }
  }
}
```

## Reference: paviko/opencode-ide-plugin patterns to port

- **Binary bundling** — `resources/bin/{windows,macos,linux}/{amd64,arm64}/opencode[.exe]`
- **`ResourceExtractor`** — detect OS/arch, copy binary to a stable tmp dir, `chmod 0o755`,
  wipe stale copies. Resolution: `OPENCODE_BIN` env → bundled → system PATH.
- **`BackendLauncher`** — spawn `<bin> serve`, parse stdout for
  `opencode server listening on http://...` to get the URL; SIGTERM→SIGKILL on shutdown.
- **Two vsix variants** — "full" (binary bundled) and "gui-only" (system OC), via a
  package.json/.vscodeignore swap-and-restore in the publish script.

## Open questions

1. Does "Fast" keep TierMux's built-in agent for sub-100ms latency, or route through OC
   for consistency? (OC adds process + HTTP overhead.)
2. Plan-mode output — still save a markdown file to `.tiermux/plans` (current behavior)?
3. Usage/cost reporting — drive from OC's session/token events (like paviko's webgui) into
   TierMux's existing footer, or from the router proxy?
