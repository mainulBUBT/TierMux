# TierMux — Project Roadmap

**Last updated:** 2026-07-11

---

## Feature status

### Core features — ✅ Complete
```
[x] Streaming responses
[x] Multi-provider failover
[x] Agent tool calling (OpenCode integration)
[x] Diff approval & Terminal approval gates
[x] Checkpoints & Revert capabilities
[x] Session replay / History
[x] Keyless fallback chain
[x] Custom endpoints
```

### Providers — ✅ 22 Supported
```
Keyless:  kilo · pollinations · ovh
Keyed:    groq · cerebras · nvidia · mistral · openrouter · github · zhipu · huggingface · ollama · llm7 · agnes · sambanova · siliconflow · zenmux · cohere
Native:   google (AI Studio) · cloudflare (Workers AI)
Custom:   user-defined OpenAI-compatible endpoints
```

### UI (Webview) — ✅ Complete
```
[x] Settings panel (providers/mcp/usage/others tabs)
[x] History dropdown + search
[x] Composer: attachments, images, paste, drag-drop
[x] @mention / slash autocomplete
[x] Auto-approve toggle
[x] MCP servers config + registry browse
```

### Architecture — 🚧 Next Steps
```
[x] Headless agent loop integration (OpenCode)
[x] Telemetry profiler (live + noop)
[ ] Test Coverage: Benchmark harness execution
[ ] Technical Debt: Remove @ts-nocheck in webview
```

---

## High-ROI Candidates for Next Phase

| Priority | Area | Goal |
|----------|------|------|
| 🥇 | **Benchmark Automation** | Turn `BENCHMARK_QUERIES.md` into an executable harness to catch regression during routing/model updates. |
| 🥈 | **Context Management** | Improve windowing for huge repositories, reducing token usage without losing grounding. |
| 🥉 | **Webview Tech Debt** | Incrementally migrate the vanilla JS imperative DOM webview to a modern strict TS setup, removing `@ts-nocheck`. |

---

## Principles for Future Development

1. **Measurable Changes:** Any new retrieval logic or model capability must prove itself via benchmarks before merging.
2. **Free-Tier First:** TierMux routes heavily through free LLM tiers. Architecture must remain resilient to sudden rate limits, 500s, and API changes.
3. **No Lock-in:** Ensure the Router Proxy design remains provider-agnostic.

