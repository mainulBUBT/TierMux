<p align="center">
  <img src="media/banner.png" alt="TierMux — Agentic AI Routing" width="560">
</p>

<h3 align="center">Stack free. Route smart. Ship faster.</h3>

---

**TierMux** is a free, agentic AI coding assistant for VS Code. It routes every request to the best
free model across **22 providers**, fails over automatically when one is rate-limited, and tracks
how much you've saved so the "free" part is visible.

> The name: **Tier** (free provider tiers) + **Mux** (a multiplexer that routes across them).

---

## Why TierMux

- **22 free providers, one model picker.** Gemini, Groq, Cerebras, OpenRouter, Mistral, NVIDIA,
  GitHub Models, Cohere, Cloudflare, Zhipu, Ollama, Kilo, Pollinations, LLM7, HuggingFace,
  OpenCode Zen, OVH, Agnes, SambaNova, SiliconFlow, ZenMux, OpenInference — plus any
  custom OpenAI-compatible endpoint. More added over time.
- **Auto-routing.** Send a message; the router classifies intent in milliseconds and picks a fast
  tiny model for "hi" or a smart tool-capable one for refactors. Auto learns what worked, so
  repeat tasks skip the failover cascade.
- **Resilient.** Per-provider rate-limit cooldowns, key rotation, automatic failover. One provider
  hiccup doesn't stop you.
- **Yours.** API keys live in VS Code SecretStorage. No backend, no telemetry, no opt-in to
  upload anything. Lifetime usage is stored locally and clearable.

---

## Features

### Three modes, one button

| Mode | What it does |
|---|---|
| **Ask** | Read-only Q&A. Explains code, answers questions, never edits files. |
| **Plan** | Researches the code, proposes a numbered plan, then edits only after you approve. |
| **Agent** | Full agent loop — reads, edits, runs commands, tracks a live task list. |

`Auto` (default) classifies each message and routes it to the best mode + model automatically.

### Agent capabilities

- **Pre-agent research.** Before the first model call, the agent greps the workspace, walks the
  symbol index, and collects diagnostics so it starts with context, not cold.
- **Tools.** Read / list / search the workspace, run diagnostics, create / write / edit / delete
  files (every edit shown as a **diff for approval**), and run terminal commands (gated by an
  approval policy).
- **Checkpoints.** Every turn is snapshotted; restore the workspace to before any message.
- **Quality-based escalation.** If a model returns empty, refuses, or loops on a tool call, the
  router retries with a smarter model automatically.

### Editor integration

- Right-click **Explain / Fix / Refactor / Generate Tests / Generate Docs** on any selection.
- **Fix with AI** on diagnostics, **inline chat** (`Ctrl/Cmd+I`).
- **AI commit messages** in the Source Control toolbar.
- Optional **ghost-text completions** (off by default — high request volume against free tiers).

### Feedback and memory

- **👍 / 👎** each reply. The router learns which model answers *your* tasks best (stored locally).
- **Style memory.** TierMux infers your indent / quote / semicolon style and stays consistent.

### Extensibility

- **Custom OpenAI-compatible endpoints** — vLLM, LiteLLM, Azure OpenAI, Cloudflare AI Gateway, etc.
- **MCP** — connect Model Context Protocol servers for extra tools.

### Usage tracking

- **Session + lifetime tokens** in the chat footer.
- **Estimated $ saved** — reference prices are configurable; set them to `0` to hide the line.
- **Usage data card** in Settings → Others with a one-click reset.

---

## Getting started

1. Install the extension (or run it from source — see [DEVELOPMENT.md](DEVELOPMENT.md)).
2. Open the **TierMux** view in the Activity Bar.
3. Click **⚙ Manage Models & Keys** and **Set key** for at least one provider — or pick a
   **keyless** one (OVH / Pollinations / Kilo).
4. Leave **Mode: Auto** and **Model: Auto**, and just type.

---

## Configuration

Settings live under **TierMux** in VS Code settings. The most useful ones:

| Setting | Default | What it does |
|---|---|---|
| `tiermux.agent.maxIterations` | `25` | Max agent tool steps before pausing to check in. |
| `tiermux.agent.requireWriteConfirmation` | `true` | Show a diff and confirm before file writes. |
| `tiermux.agent.commandApproval` | `always` | `always` / `allowlist` / `never` for `runCommand`. |
| `tiermux.requestTimeoutMs` | `60000` | Per-provider request timeout before failover. |
| `tiermux.rateLimitCooldownMs` | `60000` | How long to skip a rate-limited provider. |
| `tiermux.usage.referencePriceInPer1M` | `5` | Reference price per 1M input tokens (USD) for the "est. $ saved" line. `0` hides it. |
| `tiermux.usage.referencePriceOutPer1M` | `15` | Reference price per 1M output tokens (USD). `0` hides it. |

Model enable/priority, per-provider endpoint overrides, and custom OpenAI-compatible endpoints
are all managed in **⚙ Manage Models & Keys**.

---

## Your data

- **API keys** → VS Code SecretStorage (encrypted by the OS).
- **👍 / 👎 stats and lifetime token counter** → local extension storage.
- **No backend.** TierMux has no server. Nothing leaves your machine.

## License

MIT.
