# OpenCode Integration — Status (2026-06-27 00:30)

## What's working

- ✅ Extension builds clean (`npm run build` → no errors)
- ✅ OpenCode 1.2.15 binary downloaded at `bin/darwin/arm64/opencode` (119 MB, executable)
- ✅ OpenCode serves and reports healthy (`{"healthy":true,"version":"1.2.15"}`)
- ✅ OpenCode → Provider (tiermux) → RouterProxy → Mock LLM chain works end-to-end
- ✅ Mock LLM received correct OpenAI-format request:
  ```json
  {
    "model": "tiermux-auto",
    "max_tokens": 32000,
    "messages": [{ "role": "system", "content": "You are opencode..." }, ...]
  }
  ```

## Critical fixes applied this session

| File | Change |
|---|---|
| `src/backend/routerProxy.ts` | 3 fixes: error path, meta-model in /v1/models, honor proxyReq.model |
| `src/backend/opencodeConfig.ts` | Use `model` (singular) instead of `defaultModel` (was unrecognized in 1.2.15) |
| `src/backend/opencodeClient.ts` | Use `{providerID, modelID}` object for model; use `text` (not `content`) in parts; default model + agent; log error response body |
| `~/.config/opencode/config.json` | User-level global config: removed `defaultModel` (was breaking OpenCode startup) |
| `.tiermux/opencode.jsonc` | Same fix applied |
| `package.json` | `tiermux.useOpenCodeEngine` setting added (default: true) |

## 400 error root cause (fixed)

The 400 "Failed to send message" came from wrong OpenCode 1.2.15 message API schema:

| Wrong (old code) | Correct (1.2.15) |
|---|---|
| `parts: [{ type: 'text', content: 'hi', id: '...' }]` | `parts: [{ type: 'text', text: 'hi', id: '...' }]` |
| `model: 'tiermux/tiermux-auto'` (string) | `model: { providerID: 'tiermux', modelID: 'tiermux-auto' }` (object) |
| (no agent) | `agent: 'build'` (string) |

## How to test tomorrow morning

```bash
# 1. Reload window in VS Code
Cmd+Shift+P → "Developer: Reload Window"

# 2. Check Output channel → "Extension Host"
#    Look for: "[TierMux] RouterProxy listening on http://127.0.0.1:XXXXX"
#    And: OpenCode spawn success (no "exited with code 1")

# 3. Open TierMux chat panel
#    Send: "hi" or "what is 2+2"
#    Expected: response from a free-tier model routed through the proxy
```

If still 400, the error message will now show the actual response body (e.g. `Failed to send message: 400 {"error":[...]}`) — paste it back for diagnosis.

## What remains (not blockers, future work)

- **Adaptive Orchestrator** — architecture's "moat" layer (not yet implemented; proxy still calls router directly)
- **PKB** — Performance Knowledge Base (Phase 4 in ARCHITECTURE.md)
- **4 execution policies** — CHAT/AGENT/INLINE/BACKGROUND (not wired; `requireTools: true` hardcoded)
- **Continuation logic** — context-preserving model switch (single-shot only today)
- **50-query bench** — re-run with `a8ef30a` + OpenCode engine to compare latency/KPIs

## Architectural insight (2026-06-27 00:50)

**Adaptive Orchestrator seam identified**: `SettingsStore.enabledByPriority()` returns ordered `FallbackEntry[]`. This is the PKB's reorder target.

**3 PKB primitives** (no new module needed):
1. Reorder — `enabledByPriority()` result re-sorted by `(intent, category, model)` weight
2. Inject — capability filter (CHAT/AGENT/INLINE/BACKGROUND)
3. Observe — per-entry outcome (success/latency/tokens/429) → runtime telemetry

**OpenCode signal**: agent loop context (intent, complexity, attachments) → OpenCode message body → TierMux router → PKB lookup → reordered fallback chain.
