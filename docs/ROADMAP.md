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

| Priority | Gap | Effort | Value |
|----------|-----|--------|-------|
| 🥇 | **Benchmark harness** — profiler আছে কিন্তু automated runner নেই | মাঝারি | উচ্চ — routing পরিবর্তনে regression ধরবে |
| 🥈 | **Preact spike** — একটা ছোট panel (যেমন ProfilerPanel) দিয়ে validate | মাঝারি | উচ্চ — approach যে কাজ করে তা প্রমাণ |
| 🥉 | **Gradual Preact migration** + @ts-nocheck naturally কমবে | বড় | উচ্চ — component-by-component |
| ✅ | ~~Handler extraction~~ | — | **Closed** — feature-demand না হলে আর নয় |

---

## Priority rationale

১. **Benchmark harness আগে** — ROI সবচেয়ে বেশি। profiler + routing + providers + ৫০-query dataset সব আছে, শুধু runner নেই। হলে ভবিষ্যতের সব কাজ measurable:
   - Router change → latency +X%
   - Prompt change → tool calls +Y%
   - New provider → quality compare
   - Preact migration → rendering impact

২. **Preact spike, পুরো rewrite নয়** — component-by-component:
   ```
   PR1: <ProfilerPanel /> → PR2: <StatusBar /> → PR3: <ToolCard /> → PR4: <Message />
   ```

৩. **`@ts-nocheck` আলাদা project নয়** — Preact-এ প্রতিটা component strict TS, naturally @ts-nocheck shrink করবে।

৪. **Handler extraction officially closed** — feature-demand না হলে আর force-extract নয়।

---

## Pointer
- Details/handoff: [STATUS_HANDOFF.md](STATUS_HANDOFF.md)
- Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)
- OC integration: [OC_INTEGRATION_PLAN.md](OC_INTEGRATION_PLAN.md)
