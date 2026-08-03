<p align="center">
  <img src="media/banner.png" alt="TierMux — Agentic AI Routing" width="560">
</p>

<h3 align="center">Stack free. Route smart. Ship faster.</h3>

<p align="center">
  A free, open-source VS Code AI assistant that multiplexes 22+ free-tier LLM providers — auto-routing, auto-failing-over, learning your codebase.
</p>

---

## Why TierMux

Free LLM tiers (Groq, Cerebras, Google AI Studio, Mistral, NVIDIA NIM, OpenRouter…) are powerful but unreliable on their own — rate limits, downtime, blind spots. TierMux pools them into one self-healing surface. No middleman, no API bill, no babysitting.

**What you get:**

- **Zero setup cost** — most providers work without a paid API bill; some need no key at all.
- **Auto-failover** — rate-limited or down provider? TierMux silently moves to the next. You see no errors, feel no delay.
- **Auto-routing** — every message is classified and sent to the best model for the job: quick questions, code edits, full agent runs, images.
- **Code-aware** — silently picks up your style (indentation, quotes, semicolons) and instructs models to match.
- **It improves over time** — your 👍 / 👎 feedback tunes future routing.

---

## Quick Start

1. **Install** from the VS Code Marketplace (search **TierMux**) or [from source](#from-source).
2. Open the **TierMux** icon in the Activity Bar → **⚙ Manage Models & Keys** → enable providers, add keys, set priority.
3. Leave everything on **Auto** and start typing.

> No `settings.json` editing — everything is point-and-click in the panel.

### From source
```bash
git clone https://github.com/mainulBUBT/TierMux.git
cd TierMux
npm install
npm run package          # produces tiermux-*.vsix
code --install-extension tiermux-*.vsix
```

---

## How It Works

```
your message ──▶ Classify ──▶ Rank ──▶ Send ──▶ Fail-over ──▶ Learn
```

1. **Classify** — decides what kind of task it is and which model class it needs.
2. **Rank** — orders your enabled providers by priority, skipping rate-limited ones and filtering out models that can't handle the task.
3. **Send** — your message goes directly from VS Code to the provider's API. No TierMux server in between.
4. **Fail-over** — if a provider rate-limits, times out, or refuses, it silently retries the next one.
5. **Learn** — 👍 / 👎 feedback and your edited files tune future routing and style.

## Modes

| Mode | Behavior |
|---|---|
| **Ask** | Read-only — answers and explains, never touches your files. |
| **Plan** | Reads your code, proposes a step-by-step plan, waits for approval. |
| **Agent** | Full loop — reads files, applies diffs, runs terminal commands, checkpoints for undo. |

**Auto** mode picks the right mode and model for each message automatically.

---

## Providers

22 pre-configured providers, 121+ models out of the box — Groq, Cerebras, Google AI Studio, Mistral, NVIDIA NIM, OpenRouter, Cohere, GitHub Models, SambaNova, SiliconFlow, and more.

**Keyless (zero setup):** Kilo Gateway · OVH AI Endpoints · Pollinations  
**Custom endpoints:** any OpenAI-compatible URL (vLLM, LiteLLM, Azure OpenAI, Cloudflare AI Gateway…).

---

## Privacy

- **Keys** — stored in VS Code's encrypted secret storage. Never written to disk, never synced, never logged.
- **No TierMux backend** — every request goes VS Code → provider API directly.
- **Feedback & stats** — local extension storage only, never uploaded.
- **Nothing you type is sent to TierMux** — only to the provider you (or Auto) selected.

Contributing? Read [PUBLISHING.md](PUBLISHING.md) before pushing.

---

## License

MIT — free to use, modify, distribute. See [LICENSE](LICENSE).
