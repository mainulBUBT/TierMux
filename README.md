<p align="center">
  <img src="media/banner.png" alt="TierMux — Agentic AI Routing" width="560">
</p>

<h3 align="center">Stack free. Route smart. Ship faster.</h3>

---

**TierMux** is a free, open-source AI coding assistant for VS Code. Instead of locking you into a single model or running up an API bill, TierMux automatically routes each message to the best available **free** model across **22+ providers** — and silently switches to another one when a provider is slow, rate-limited, or down.

> **The name:** **Tier** (free provider tiers) + **Mux** (a multiplexer that switches between them).

---

## What Problem Does TierMux Solve?

Most AI coding tools force a trade-off:

- **Pay per token** → bills grow fast, especially with agentic tasks that make dozens of requests.
- **Pick one model** → you're stuck with its rate limits, downtime, and blind spots.
- **Manage keys manually** → juggling 10 dashboards is not how you want to spend your time.

**TierMux eliminates all three.** It runs entirely on the free tiers of 22+ providers, automatically picks the right model for each task, and fails over silently when any one provider has issues. You just type — TierMux handles the rest.

---

## Supported Platforms

TierMux connects to **22+ AI providers** out of the box. Each one is pre-configured — you just add a key (or use it keyless where supported):

| Provider | Key Required |
|---|---|
| **Cerebras** | ✅ Free API key |
| **Cloudflare Workers AI** | ✅ Free (account:token) |
| **Cohere** | ✅ Free API key |
| **GitHub Models** | ✅ GitHub token |
| **Google AI Studio** | ✅ Free API key |
| **Groq** | ✅ Free API key |
| **LLM7** | ✅ Free API key |
| **Mistral** | ✅ Free API key |
| **NVIDIA NIM** | ✅ Free API key |
| **Ollama Cloud** | ✅ API key |
| **OpenCode Zen** | ✅ Free account |
| **OpenRouter** | ✅ Free API key |
| **OVH AI Endpoints** | ⚡ Keyless |
| **Pollinations** | ⚡ Keyless |
| **SambaNova** | ✅ Free API key |
| **Zhipu AI** | ✅ Free API key |
| **ZenMux** | ✅ Free API key |
| **Agnes AI** | ✅ Free API key |
| **Kilo Gateway** | ⚡ Keyless |
| **HuggingFace Router** | ✅ HF token |
| **SiliconFlow** | ✅ Free API key |

> ⚡ **Keyless** means you can use the provider with zero configuration — no account needed.
>
> You can also add **your own OpenAI-compatible endpoint** (vLLM, LiteLLM, Azure OpenAI, Cloudflare AI Gateway, etc.).

---

## How TierMux Learns — What It Understands About Your Work

TierMux isn't just a dumb proxy. It actively learns from your workflow:

### 🔀 Smart Routing — Right Model, Right Task

Every message is classified before it's sent. A quick "what does this function do?" goes to a fast, lightweight model. A "refactor this entire auth system" goes to a deeper reasoning model. You don't need to think about this — TierMux decides automatically when you're on **Auto** mode.

### 🔁 Automatic Failover — Never Gets Stuck

If a provider rate-limits you, times out, or returns an empty/refused response, TierMux silently tries the next best option in your priority list. Background agents keep running. You never see an error unless every provider in the chain fails.

### 🧠 Learns Your Preferences

- Give any reply a **👍 or 👎** — TierMux remembers which models actually work well for your codebase and adjusts future routing.
- Picks up on your **coding style** (indentation, quote style, semicolons) directly from files you edit and instructs the model to match it — no manual config needed.

### 📊 Tracks Your Savings

Every token request is tracked. The footer shows live token usage and an estimate of how much money you've saved compared to paying for a commercial API. Across a day of agentic coding, this can easily reach **$5–$50+**.

---

## What TierMux Can Do For You

### Three Modes

| Mode | What it does |
|---|---|
| **Ask** | Answers questions, explains code, documents functions. Read-only — never touches your files. |
| **Plan** | Reads your code, writes a step-by-step plan, and waits for your approval before doing anything. |
| **Agent** | Does the work end to end — reads files, edits them, runs terminal commands, and tracks progress. |

Leave everything on **Auto** and TierMux reads your message to pick the right mode and the right model automatically.

### Agent Capabilities

- **Reads your project first** — greps files, checks types, reads diagnostics — so it's not guessing about your codebase.
- **File editing with diffs** — every change shows up as a diff you review and approve before it's applied.
- **Terminal commands** — runs commands with configurable confirmation levels (always / auto-approve safe / fully autonomous).
- **Checkpoint system** — saves a snapshot every turn so you can undo back to before any message.
- **Fallback on bad answers** — if a model returns empty output, refuses, or loops, TierMux automatically retries with a smarter model.
- **Parallel agents** — multiple chat tabs can each run their own agent simultaneously (up to your configured limit).

### Editor Integration

- **Right-click menu** → Explain / Fix / Refactor / Generate Tests / Generate Docs on any selected code.
- **Fix with AI** on red squiggly errors directly from the Problems panel.
- **Inline chat** → `Ctrl/Cmd+I` anywhere in the editor for instant in-place edits.
- **Git commit messages** — TierMux writes them for you based on your staged diff.
- **Optional inline autocomplete** — off by default to preserve free-tier quota, but available to enable.

### MCP Server Support

Connect **Model Context Protocol (MCP)** servers to give the agent additional tools — databases, APIs, file systems, custom scripts, and more.

---

## Getting Started

### Step 1 — Open TierMux

Click the **TierMux** icon in the VS Code Activity Bar (sidebar).

### Step 2 — Configure Providers (UI-Based)

Click **⚙ Manage Models & Keys** inside the TierMux panel.

The configuration UI lets you:
- **Enable / disable** individual providers with a toggle
- **Add API keys** for each provider in a secure input field
- **Set priority order** — drag providers up/down to control which ones TierMux tries first
- **Add custom endpoints** — paste any OpenAI-compatible base URL
- **Set custom headers** for enterprise endpoints that require them

> **No `settings.json` editing required.** Everything is point-and-click inside the extension panel.

### Step 3 — Start Coding

Leave everything on **Auto** and start typing. If you have no keys yet, start with a keyless provider like **OVH**, **Pollinations**, or **Kilo** — no account required.

---

## Settings

All settings live inside the TierMux panel — no need to open VS Code's `settings.json`.

- **Providers & Models** → `⚙ Manage Models & Keys` tab
- **Agent behavior, context, memory, timeouts** → `Others` tab in the same panel

| Setting | Default | What it does |
|---|---|---|
| Max iterations | `25` | Agent steps before it checks in with you |
| Max concurrent runs | `3` | How many chat tabs can run an agent simultaneously |
| Require write confirmation | `on` | Show a diff and ask before writing to any file |
| Command approval | `always` | How cautious the agent is before running terminal commands |
| Request timeout | `60s` | How long to wait on a provider before trying the next |
| Rate-limit cooldown | `60s` | How long to skip a provider after it rate-limits you |
| Reference price (per 1M tokens) | Per-model (pre-configured) | Used to estimate your savings. Override per model, or set to `0` to hide. |

---

## 🔒 Your Privacy & Credentials

**Your API keys never leave your machine.**

- **Keys are stored in VS Code's encrypted secret storage** — the same secure vault VS Code uses for Git credentials. They are never written to any config file, never logged, and never synced to the cloud.
- **No TierMux backend server exists.** There is no middleman. Every request goes directly from your VS Code instance to the model provider's API.
- **Feedback and usage stats are stored locally only** — in your VS Code extension storage folder on your own machine.
- **Nothing you type, paste, or ask is ever sent to TierMux** — only to the provider you've selected (or that TierMux auto-selected for that message).

> You are always in control of which providers are active, which models are used, and how your keys are stored. TierMux is a routing layer — not a service.

Contributing from a fork or clone? See [PUBLISHING.md](PUBLISHING.md) before pushing — it's a checklist for keeping local secrets/config out of the public repo.

---

## About TierMux

TierMux was built to answer a simple question: *why should writing code with AI cost money when so many excellent models are free?*

The free tiers of modern LLM providers — Groq, Cerebras, Google AI Studio, OpenRouter, Mistral, NVIDIA NIM, and many more — are genuinely powerful. The problem is that no single free tier is reliable enough on its own: rate limits hit, providers go down, and different models are better at different things.

TierMux solves this by treating all those free tiers as a single, unified, self-healing pool. It routes intelligently, fails over automatically, and learns what works best for your specific codebase and style. The result is a coding assistant that costs nothing, improves over time, and never leaves you staring at a rate-limit error.

---

## License

MIT — free to use, modify, and distribute.
