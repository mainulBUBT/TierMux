# TierMux — Project Roadmap

**Last updated:** 2026-07-27

---

## Feature status

### Core features — ✅ Complete
```
[x] Streaming responses
[x] Multi-provider failover
[x] Agent tool calling (in-process, built on the AI SDK — OpenCode fully removed 2026-07)
[x] Diff approval & Terminal approval gates
[x] Checkpoints & Revert capabilities
[x] Session replay / History
[x] Keyless fallback chain
[x] Custom endpoints
```

### Reliability/agent-loop features (adopted from an awesome-opencode review) — ✅ Complete
```
[x] .env/secrets read guard — deny/prompt readFile/glob on .env*, *.pem, id_rsa*, .npmrc,
    .aws/, .ssh/, *credentials* (src/agent/core/policies/permission.ts)
[x] Shell-strategy prompt — no &&-chains, no pagers, no -i flags, one command per step
    (src/agent/promptBuilder.ts)
[x] Handoff prompt — tiermux.generateHandoff command, goal/done/next/open-decisions note
    (src/agent/condense.ts generateHandoff, src/agent/prompts.ts HANDOFF_SYSTEM)
[x] Plan annotation — structurePlanSteps() wired into Plan mode's turn completion, feeding
    the existing per-step accept/reject/edit UI (media/src/ui/components/Plan.ts) cleaner,
    model-structured steps instead of only a regex bullet/number parse; posted non-blocking
    (plan card shows instantly, upgrades in place) — chatViewProvider.ts upgradePlanSteps()
[x] Self-correct retry (Ralph-Wiggum-style) — one bounded retry when an edit/write tool's
    own post-edit diagnostic check finds a NEW error, nudging the model to fix it instead of
    silently finishing on a broken file (src/agent/core/loop.ts runTurn)
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
[x] Headless agent loop (AI SDK `streamText()` + a custom Router-backed provider — see docs/ARCHITECTURE.md)
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
| — | **Brainstorm → Plan → Implement mode** | An explicit 3-phase mode switch (no code tools in brainstorm → structured plan → full tools in implement) with session continuity. Not started; mostly prompt + mode-flag wiring on top of the existing plan/agent/ask `AgentMode`. |

---

## Principles for Future Development

1. **Measurable Changes:** Any new retrieval logic or model capability must prove itself via benchmarks before merging.
2. **Free-Tier First:** TierMux routes heavily through free LLM tiers. Architecture must remain resilient to sudden rate limits, 500s, and API changes.
3. **No Lock-in:** Ensure the Router stays provider-agnostic and AI-SDK-agnostic — it exposes `route()` and knows nothing about `LanguageModel`/`Tool`/`streamText`.

