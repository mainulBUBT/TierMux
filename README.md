<p align="center">
  <img src="media/banner.png" alt="TierMux — Agentic AI Routing" width="560">
</p>

<h3 align="center">Stack free. Route smart. Ship faster.</h3>

---

**TierMux** is a free AI coding assistant for VS Code. Instead of locking you into one model, it
routes each message to the best **free** model out of 22 providers, automatically switches to
another one if a provider is slow or rate-limited, and shows you how much money that's saving you.

> The name: **Tier** (free provider tiers) + **Mux** (a multiplexer that switches between them).

---

## Why use TierMux

- **No API bills.** Works entirely on free tiers across 22 providers — Gemini, Groq, Cerebras,
  OpenRouter, Mistral, NVIDIA, GitHub Models, Cohere, Cloudflare, Zhipu, Ollama, Kilo,
  Pollinations, LLM7, HuggingFace, OpenCode Zen, OVH, Agnes, SambaNova, SiliconFlow, ZenMux,
  and OpenInference. You can also plug in your own OpenAI-compatible endpoint.
- **Just works — no picking a model.** Leave it on `Auto` and TierMux figures out per message
  whether you need a quick answer or a serious coding model, and which provider to send it to.
- **Doesn't get stuck.** If a provider is rate-limited, down, or just slow, TierMux quietly
  retries with the next best option. You keep typing; it handles the rest.
- **Private by design.** There's no backend server. Your API keys stay in VS Code's built-in
  secret storage, and nothing you type is sent anywhere except directly to the model provider.

---

## What it can do

### Three modes

| Mode | What it does |
|---|---|
| **Ask** | Answers questions and explains code. Read-only — it never touches your files. |
| **Plan** | Looks at your code, writes a step-by-step plan, and waits for your OK before doing anything. |
| **Agent** | Does the work end to end — reads files, edits them, runs commands, and tracks progress as it goes. |

If you're not sure which one to use, leave it on **Auto** — TierMux reads your message and picks
the right mode and model for you.

### What the agent can do

- Looks around your project first (greps, checks types, reads diagnostics) so it's not guessing.
- Reads, writes, edits, and deletes files — every change shows up as a diff you approve first.
- Runs terminal commands, with a safety setting for how much confirmation you want.
- Saves a checkpoint every turn, so you can undo back to before any message.
- If a model gives a bad answer (empty, refuses, gets stuck), TierMux tries again with a smarter one.
- Multiple chat tabs can run their own agent at the same time — switching tabs never stops or
  hides what a background agent is doing, up to a configurable concurrency limit.

### Right in your editor

- Right-click any selection for **Explain / Fix / Refactor / Generate Tests / Generate Docs**.
- **Fix with AI** on red squiggly errors, or **Ctrl/Cmd+I** for inline chat anywhere.
- Writes your **git commit messages** for you.
- Optional inline autocomplete (off by default, since free tiers have limited quota).

### Learns your style

- Thumbs up / down on any reply — TierMux remembers which models actually work well for you.
- Picks up on how you write code (indentation, quotes, semicolons) and matches it.

### Extra tools

- Bring your own OpenAI-compatible server — vLLM, LiteLLM, Azure OpenAI, Cloudflare AI Gateway, etc.
- Connect **MCP** servers to give the agent more tools.

### Keeping track of usage

- See how many tokens you've used this session and in total, right in the chat footer.
- An estimate of how much money you've saved by not paying for those tokens.
- A full usage breakdown (and a reset button) under Settings → Others.

---

## Getting started

1. Install the extension (or build it from source — see [DEVELOPMENT.md](docs/DEVELOPMENT.md)).
2. Open the **TierMux** icon in the Activity Bar.
3. Click **⚙ Manage Models & Keys** and add a key for at least one provider — or skip this and
   use a **keyless** one like OVH, Pollinations, or Kilo.
4. Leave everything on **Auto** and start typing.

---

## Settings

Most day-to-day settings — which providers/models are enabled, their priority, custom endpoints —
live in **⚙ Manage Models & Keys**, right in the TierMux panel.

Everything else (agent behavior, completions, context, memory, timeouts, etc.) can be changed
from the **Others** tab in the same panel — no need to dig through VS Code's `settings.json`.
A few of the more useful ones:

| Setting | Default | What it does |
|---|---|---|
| Max iterations | `25` | How many steps the agent can take before checking in with you. |
| Max concurrent runs | `3` | How many chat tabs can have an agent running at the same time. |
| Require write confirmation | `on` | Show a diff and ask before the agent writes to a file. |
| Command approval | `always` | How careful the agent is before running a terminal command. |
| Request timeout | `60s` | How long to wait on a provider before trying the next one. |
| Rate-limit cooldown | `60s` | How long to skip a provider after it rate-limits you. |
| Reference price (in / out per 1M tokens) | `$5 / $15` | Used to estimate your savings. Set to `0` to hide it. |

---

## Your data

- **API keys** stay in VS Code's encrypted secret storage — never in a config file.
- **Feedback and usage stats** are stored locally on your machine only.
- **No backend.** TierMux doesn't have a server. Nothing you do here leaves your computer,
  except requests going straight to whichever model provider you're using.

## License

MIT.
