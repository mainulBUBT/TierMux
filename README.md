<p align="center">
  <img src="media/banner.png" alt="TierMux — Agentic AI Routing" width="560">
</p>

<h3 align="center">Stack free. Route smart. Ship faster.</h3>

<p align="center">
  A free, open-source AI coding assistant for VS Code that pools <b>30+ free-tier LLM
  providers</b> into one self-healing surface — auto-routing, auto-failing-over, learning
  your codebase. No subscription. No per-token bill.
</p>

---

## Why one free provider is never enough

Free LLM tiers are powerful in 2026 — but every single one of them rate-limits, caps out, or goes down eventually. Tools built around **one** provider inherit exactly that reliability. TierMux pools them all:

```
 Without TierMux                          With TierMux

 ┌──────────────┐    429 💥                your message
 │ ONE provider │ ───────────► dead            │
 └──────────────┘   you wait                  ▼
                                          ┌────────┐   ──▶ Groq       ✓
                                          │ ROUTER │─────▶ Cerebras   ✓  (Groq cooling)
                                          └────────┘   ──▶ Google      ✓
                                                       ──▶ OpenRouter  ✓
```

One flaky endpoint = flaky assistant. Ten pooled endpoints ≈ an assistant that just doesn't go down — at $0/month.

## How a request flows

```
 message ─▶ CLASSIFY ─▶ RANK ─▶ SEND ─▶ FAIL-OVER ─▶ LEARN
             │           │       │         │           │
        question? edit?  score   straight  next key,   your 👍👎 +
        agent run? image candidates  to the  then next   live latency /
                                 provider  provider    success stats
```

**The routing, briefly:** capable models are filtered for the task (tools? vision? context size?), then scored as `capability × live-reliability × your-votes`. Reliability is a Wilson-bounded success rate plus latency health — so a model that went 3-for-3 doesn't outrank one that went 194-for-200, and a suddenly slow model gets demoted fast. Best score wins; any failure (429, timeout, dead key) walks down the list silently. Toggle off for plain fixed-priority order.

**Token optimization, briefly:** every prompt is **fitted to the target model's context window** before sending (per-model trimming, not one-size); long sessions **auto-compact** older turns into summaries; ambient editor context is sliced to a char budget; sub-agents return only their report, so the main conversation stays small.

## Under the hood

Named techniques powering the flows above — all implemented natively by TierMux, no external routing service involved:

| Technique | Role |
|---|---|
| Wilson lower-bound success scoring | ranks reliability without letting small lucky streaks win |
| Dual-window EWMA tracking + drift detection | demotes suddenly slow/failing models fast, restores them gradually |
| Baseline-relative slow marking | "slow" is judged against each model's own history, not one fixed timeout |
| Margin-gated exploration | occasionally tries runners-up so fresh models can prove themselves |
| RTK-style head+tail compaction | huge tool outputs enter history as head+tail only; file reads/edits stay verbatim |
| Caveman-style terse replies | opt-in brevity prompt (`tiermux.agent.terseReplies`) cutting padded output tokens |
| Task-pattern sub-agents (`delegate`) | research/git-worktree workers — only their reports reach the main context |
| Cassette record/replay + scripted mock fixtures | test real agent loops with zero API tokens |

## More providers + more keys = fewer walls

This is the single biggest quality dial in TierMux:

```
 1 key .............. works, but you'll meet its rate limit
 3–5 providers ...... solid — one cools, another serves
 8+ providers ....... rain-or-shine
 + extra keys ....... TierMux rotates keys WITHIN a provider and cools
   per provider       each key independently before touching the platform
```

Every enabled provider adds its own independent quota. Every added key per provider adds headroom on that provider. Adding keys takes seconds (**⚙ Manage Models & Keys**) and there is no downside — unused keys just rest.

## Modes

| Mode | What happens |
|---|---|
| **Ask** | Q&A only — streams answers, touches nothing. |
| **Plan** | Reads code read-only, proposes step-by-step plan, waits for approval. |
| **Agent** | Full loop — diffs (you approve), terminal (you approve), checkpoints, revert. |
| **Auto** | Picks mode *and* model per message. Default. |

## What's inside

- **Self-healing routing** — per-key + per-platform cooldowns, tool-incompatible/deprecated quarantine, cached preflight health checks, honest errors naming exactly which providers failed and why.
- **Plan runner** — approved plans execute step-by-step, each step verified; failing steps get bounded retries and read-only repair; progress survives reloads.
- **Sub-agents (`delegate`)** — research agents, or code workers in disposable git worktrees that commit and merge back.
- **Safety rails** — diff/command approval gates, `.env`/key-material read guards, stall watchdog (~45s warn, ~90s actionable).
- **Codebase-aware** — learns your formatting style, ambient open-editor context, optional embeddings index, project memory in `.tiermux/`.
- **Editor-wide** — inline chat (`Cmd/Ctrl+I`), selection explain/fix/refactor/tests/docs, commit-message generation, inline autocomplete, searchable history, MCP servers, custom slash skills.
- **Explainable** — *"Why this model?"* rationale per turn (scores, confidence, who else was considered).

## Providers — 145+ models, 30 platforms

| Category | Providers |
|---|---|
| **Keyless — zero setup** | Kilo Gateway · OVH AI Endpoints · Pollinations · OpenCode Zen |
| **Free API key** | Groq · Cerebras · Google AI Studio · Mistral · NVIDIA NIM · OpenRouter (`:free`) · Cloudflare Workers AI · Cohere · SambaNova · SiliconFlow · Zhipu · HuggingFace · LLM7 · Agnes · … |
| **Gateway tiers** | Kenari · Nara Router · Aion Labs · ChatAnywhere · OpenAdapter · OrcaRouter · Requesty · Router9 · LLM Gateway · ZenMux · Poolside · Ollama Cloud |
| **Your own endpoints** | Any OpenAI-compatible URL — vLLM, LiteLLM, LM Studio, local Ollama, llama.cpp, Azure OpenAI… |

The model catalog auto-updates from remote, so new free models appear without updating the extension.

## Existing assistants vs TierMux

Feature-by-feature, based on each product's current documentation (see footnotes):

| Feature | **TierMux** | GitHub Copilot | Cursor | Cline | Continue |
|---|:-:|:-:|:-:|:-:|:-:|
| Usable every day at $0 | ✓ | ✗ <sup>1</sup> | ✗ <sup>2</sup> | ✗ <sup>3</sup> | ✗ <sup>3</sup> |
| Works instantly with zero keys/accounts | ✓ | ✗ | ✗ | ✗ | ✗ |
| Pools many providers' free tiers together | ✓ | ✗ | ✗ | ✗ | ✗ |
| Auto-failover when a provider rate-limits or dies | ✓ | ✗ | ✗ | ✗ | ✗ |
| Multiple keys per provider, rotated & cooled automatically | ✓ | ✗ | ✗ | ✗ | ✗ |
| Bring your own API key / any OpenAI-compatible endpoint | ✓ | ✗ <sup>4</sup> | ✗ <sup>5</sup> | ✓ | ✓ |
| Agent mode (edits + terminal behind approvals) | ✓ | ~ <sup>1</sup> | ~ <sup>2</sup> | ✓ | ✓ |
| Plan-then-execute workflow | ✓ | ~ | ✓ | ✓ | ✓ |
| MCP servers | ✓ | ✓ | ✓ | ✓ | ✓ |
| Open source | ✓ MIT | ✗ | ✗ | ✓ Apache-2.0 | ✓ Apache-2.0 <sup>6</sup> |
| Requests go direct VS Code → provider (no vendor backend) | ✓ | ✗ | ✗ | ✓ | ✓ |

<sub>
1. Copilot Free caps at ~2,000 completions/month with limited agents and automatic model selection only; full agents/models need Pro ($10/mo) through Max ($100/mo).
2. Cursor is a proprietary VS Code fork; real usage sits behind its paid tiers.
3. The software is free, but every request bills your own API tokens — the cost moves, it doesn't disappear.
4. Copilot's model list is curated per subscription tier; external provider keys aren't supported.
5. Cursor's custom-API-key option has been restricted for current plans.
6. Continue's repo is read-only — no longer actively maintained as of 2026.
</sub>

Paid assistants rent you one vendor's stack; BYOK clients hand you a great UI and the reliability problem. TierMux attacks exactly that reliability problem, for the free tier.

## Install

**VS Code** (Microsoft Marketplace)
1. Extensions view (`Ctrl+Shift+X`) → search **TierMux** → **Install**
2. or on [marketplace.visualstudio.com](https://marketplace.visualstudio.com/search?term=TierMux) → open the TierMux page → **Install**, which launches your editor

**VS Code forks — VSCodium · Cursor · Google Antigravity** ([open-vsx.org](https://open-vsx.org))
1. Search **TierMux** on open-vsx.org → download the `.vsix`
2. In the editor: Command Palette → `Extensions: Install from VSIX…`

Then: Activity Bar → **TierMux** icon → start typing. Keyless providers need nothing at all; add keys in **⚙ Manage Models & Keys** whenever you want more headroom.

## Privacy

Keys live in VS Code's encrypted secret storage. Requests go **VS Code → provider, directly** — there is no TierMux server. Votes, stats, and learned routing data never leave your machine.

---

MIT — see [LICENSE](LICENSE). Contributing? Start with [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and [PUBLISHING.md](PUBLISHING.md). Architecture deep-dive: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
