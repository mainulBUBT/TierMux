# TierMux — Roadmap

**Last updated:** 2026-08-23 · version line: 2.1.x

---

## Status at a glance

| Area | State |
|---|---|
| In-process agent engine (AI SDK `streamText()`, no external CLI) | ✅ Shipped |
| Router: multi-provider failover, key rotation, cooldowns, quarantine | ✅ Shipped |
| Smart Auto scoring engine + per-turn *"Why this model?"* rationale | ✅ Shipped |
| Plan mode runner: per-step verify → bounded retry → read-only plan repair, resumable across reloads | ✅ Shipped |
| Step engine shared by auto-continue / headless runs / plan runner | ✅ Shipped |
| Sub-agent tool `delegate` (read-only research + git-worktree code workers) | ✅ Shipped |
| Turn watchdog (~45 s warn / ~90 s actionable), session auto-compaction, handoff notes | ✅ Shipped |
| Checkpoints & revert, diff/command approval gates, secrets read guard | ✅ Shipped |
| Providers: **30 built-in platforms** (4 keyless) + unlimited custom endpoints, remote catalog auto-update | ✅ Shipped |
| Benchmark harnesses: routing latency + agent-quality merge gate | ✅ Shipped |
| Zero-token testing: mock-fixture scenarios, recorded cassettes, fake model | ✅ Shipped |
| MCP servers, custom skills (`.tiermux/skills/`), embeddings auto-context | ✅ Shipped |
| Webview tech debt: remove `@ts-nocheck` | 🚧 In progress |
| Browser verification tool (agent can see a rendered page) | 🔬 Design phase ([docs/BROWSER_VERIFY_TOOL.md](BROWSER_VERIFY_TOOL.md)) |

---

## Feature checklists

### Core — ✅ Complete
```
[x] Streaming responses (Ask streams token-by-token; tool turns buffer cleanly)
[x] Multi-provider failover with silent key rotation
[x] Agent tool calling — in-process on the AI SDK (OpenCode fully removed 2026-07)
[x] Diff approval & Terminal approval gates
[x] Checkpoints & revert
[x] Session replay / history / search
[x] Keyless fallback chain (works with zero configuration)
[x] Custom OpenAI-compatible endpoints
```

### Reliability & agent-loop hardening — ✅ Complete
```
[x] .env/secrets read guard — deny/prompt reads of .env*, *.pem, id_rsa*, .npmrc,
    .aws/, .ssh/, *credentials* (src/agent/core/policies/permission.ts)
[x] Shell-strategy prompt — no &&-chains, no pagers, no -i flags, one command per step
    (src/agent/promptBuilder.ts)
[x] Handoff prompt — tiermux.generateHandoff copies a goal/done/next/open-decisions note
[x] Plan annotation — model-structured steps feed the per-step accept/reject/edit UI,
    posted non-blocking so the plan card renders instantly and upgrades in place
[x] Self-correct retry — one bounded retry when an edit's own diagnostic check finds a
    NEW error the agent just introduced (src/agent/core/loop.ts runTurn)
[x] Mode guard — Ask/Plan cannot run mutating shell commands; mode switches announced
```

### Providers — ✅ 30 built-in platforms, 145+ catalog models
```
Keyless (zero setup, 4):   kilo · pollinations · ovh · opencode zen
Free-key tiers (24):       groq · cerebras · nvidia · mistral · openrouter · zhipu ·
                           huggingface · ollama cloud · llm7 · agnes · sambanova ·
                           siliconflow · zenmux · kenari · llmgateway · poolside ·
                           nararouter · aionlabs · chatanywhere · openadapter ·
                           orcarouter · requesty · router9 · cohere
Native adapters (2):       google (AI Studio) · cloudflare (Workers AI)
Custom:                    any OpenAI-compatible endpoint (vLLM, LiteLLM, LM Studio,
                           local Ollama, llama.cpp, Azure OpenAI…)

GitHub Models retired upstream 2026-07-30 and was removed from the registry;
catalog validation now checks live provider APIs and drops retired models automatically.
```

### UI (webview) — ✅ Complete, polish ongoing
```
[x] Settings panel (providers / mcp / usage / others tabs)
[x] History dropdown + search
[x] Composer: attachments, images, paste, drag-drop
[x] @mention / slash autocomplete
[x] Auto-approve toggle
[x] MCP servers config + registry browse
[x] Model & agent pickers, result cards, popover primitives
[ ] Strict-TS migration of remaining imperative webview code (@ts-nocheck removal)
```

---

## Next up — prioritized

| Priority | Area | Goal |
|----------|------|------|
| 🥇 | **Benchmark automation** | Grow the seeded dataset toward the full 50-query target and run the quality merge gate on every routing/model change. |
| 🥈 | **Context management** | Better windowing for huge repositories — cut token usage without losing grounding. |
| 🥉 | **Webview tech debt** | Incrementally migrate the imperative vanilla-JS webview to strict TS, removing `@ts-nocheck`. |
| 4 | **Browser verification** | Let the agent screenshot/console-inspect a running page (localhost-capable, no paid backend — see [docs/BROWSER_VERIFY_TOOL.md](BROWSER_VERIFY_TOOL.md)). |
| 5 | **Adaptive Orchestrator** | Single typed entry point for every model call (CHAT/AGENT/INLINE/BACKGROUND) — design preserved in [docs/ARCHITECTURE.md](ARCHITECTURE.md#roadmap-phase-3--not-yet-implemented). |
| 6 | **Capability resolver** | Consume `CatalogModel` capability bits (CODING/REASONING/VISION/TOOLS/LONG_CTX/CHEAP/FAST) as real routing filters via `Router.capabilities(needs)`. |

---

## Principles for future development

1. **Measurable changes.** Any new retrieval logic or model capability must prove itself via the benchmark before merging.
2. **Free-tier first.** TierMux routes heavily through free LLM tiers; the architecture must stay resilient to sudden rate limits, 500s, and API changes by design, not by luck.
3. **No lock-in.** The Router stays provider-agnostic and AI-SDK-agnostic — it exposes `route()` and knows nothing about `LanguageModel`/`Tool`/`streamText`.
4. **More capacity is always additive.** New providers, new keys, new models must slot in without config migrations — the remote catalog exists precisely so users gain headroom without updating the extension.
