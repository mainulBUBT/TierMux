# TierMux — Project Roadmap

**Last updated:** 2026-07-05
**Source:** codebase audit (file-cited, not guessed)

---

## Feature status

### Core chat — ✅ complete (১১/১১)
```
[x] Streaming          assistantChunk · sdk.ts SSE
[x] Tool calling       toolStatus · toolStatus.ts
[x] Todos              todos.ts
[x] Approvals (cmd)    commandApproval
[x] Approvals (edit)   editApproval
[x] Clarifying Q       clarifyingQuestions · clarify.ts
[x] Plans              planProposed (OC planx agent)
[x] Session history    switchSession / sessionList
[x] Failover notices   router onFailover
[x] Key rotation       onKeyRotated
[x] Checkpoints/revert CheckpointManager
```

### Providers — ✅ ২২ wired
```
Keyless:  kilo · pollinations · ovh   (default fallback chain)
Keyed:    groq · cerebras · nvidia · mistral · openrouter · github ·
          zhipu · huggingface · ollama · llm7 · opencode · agnes ·
          sambanova · siliconflow · zenmux · openference · cohere
Native:   google (AI Studio) · cloudflare (Workers AI)
Custom:   user-defined OpenAI-compatible endpoints
```
Routing: `src/router/router.ts` (auto-failover, keyless-first, cooldowns)।

### UI (webview) — ✅ সব surface আছে
```
[x] Settings panel (providers/mcp/usage/others tabs)
[x] History dropdown + search
[x] Composer: attachments, images, paste, drag-drop
[x] @mention / /slash autocomplete
[x] Model picker · mode picker · reasoning effort
[x] Auto-approve toggle
[x] Custom endpoints (with model discovery)
[x] MCP servers config + registry browse
```

### Architecture
```
[x] Phase D2 handler extraction (4/4 lifecycle handlers)
[x] Telemetry profiler (live + noop, factory-selected)
[ ] Preact rendering migration          ← NOT STARTED
[ ] Remove @ts-nocheck from main.ts     ← type-safety debt
```

### Performance
```
[x] Profiler (live + noop)
[x] Profiler smoke test (scripts/profilerSmoke.ts)
[ ] Benchmark harness                    ← spec only, no runner
```
`docs/BENCHMARK.md` + `BENCHMARK_QUERIES.md` (৫০ queries) আছে, কিন্তু executable harness নেই, `.benchmarks/` খালি।

### OpenCode integration — ✅ complete
OC একমাত্র agent engine (Vercel AI SDK সরানো হয়েছে)। `src/agent/sdk.ts` (১১৫২ লাইন) session/prompt lifecycle, mode→agent mapping (chat/planx/build), tool/todo/streaming events, fallback chain, watchdog timers, profiler hooks wire করা। Backend: `ocLauncher` (spawns `opencode serve`), `routerProxy` (OC → TierMux router)।

---

## বাস্তব gaps (high-ROI কাজের candidate)

| # | Gap | Effort | Value |
|---|-----|--------|-------|
| ১ | **Benchmark harness** — profiler আছে কিন্তু automated runner নেই | মাঝারি | উচ্চ — routing পরিবর্তনে regression ধরবে |
| ২ | **`@ts-nocheck` সরানো** main.ts থেকে | বড় | উচ্চ — কিন্তু Preact-এর সাথে একসাথে করলে সস্তা |
| ৩ | **Preact migration** | বড় (সপ্তাহ) | উচ্চ — rendering layer পরিষ্কার হবে, @ts-nocheck ও সরবে |
| ৪ | বাকি inline handlers extract (force-extract নিষেধ — feature-driven হবে) | — | কম |

---

## সিদ্ধান্তের ভিত্তি

Phase D2 (handler extraction) শেষ। Features সব আছে। এখন **"কী refactor করব"** নয়, বরং **"কোন বড় কাজটা next"** —
১. **Benchmark harness** করলে routing/perf পরিমাপযোগ্য হবে (ছোট-মাঝারি effort, high value, Preact-independent)।
২. **Preact migration** করলে rendering + type-safety একসাথে ঠিক হবে (বড় effort)।

বাকি handler-extract process-driven, feature নয় — skip।

---

## Pointer
- Details/handoff: [STATUS_HANDOFF.md](STATUS_HANDOFF.md)
- Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)
- OC integration: [OC_INTEGRATION_PLAN.md](OC_INTEGRATION_PLAN.md)
