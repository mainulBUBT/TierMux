<p align="center">
  <img src="media/banner.png" alt="TierMux — Agentic AI Routing" width="560">
</p>

<h3 align="center">Stack free. Route smart. Ship faster.</h3>

<p align="center">
  A free, open-source VS Code AI coding assistant that multiplexes 22+ free-tier LLM providers — auto-routing, auto-failing-over, learning your codebase.
</p>

---

## Why TierMux

Free LLM tiers (Groq, Cerebras, Google AI Studio, Mistral, NVIDIA NIM, OpenRouter…) are powerful but unreliable individually — rate limits, downtime, blind spots. TierMux pools them into one self-healing surface. No middleman, no API bill, no babysitting.

---

## How It Works

When you send a message, TierMux runs it through a 5-step pipeline — all invisible to you:

```
your message ──▶ Classify ──▶ Rank ──▶ Send ──▶ Fail-over ──▶ Learn
```

**1. Classify** — TierMux reads your message and decides what kind of task it is: a quick question, a code edit, a debugging session, a full agent run, an image, a long document, etc. This determines which kind of model is needed.

**2. Rank** — From your enabled providers, TierMux builds an ordered shortlist. Providers you placed higher in your priority list come first. Any provider that recently rate-limited you is temporarily skipped. Models that can't handle the task type (e.g. no vision support for an image message) are filtered out.

**3. Send** — Your message goes directly from VS Code to the top-ranked provider's API. There is no TierMux server between you and them.

**4. Fail-over** — If the provider rate-limits you, times out, sends back nothing, or refuses the request, TierMux silently moves to the next one on the list and retries. You see no error and feel no delay — unless every provider in the list fails, which is the only time an error message appears.

**5. Learn** — After each reply, your 👍 or 👎 nudges future routing. TierMux also silently reads the files you edit to pick up your indentation style, quote preference, and semicolon usage, then instructs models to match — no config needed.

---

## Under the Hood — How the Agent Runs

When you send a message in Agent or Plan mode, TierMux's internal engine takes over:

```
Your message (VS Code panel)
      │
      ▼
Task classifier       reads your message → assigns a speed/capability tier (fast | smart | auto)
      │
      ▼
Agent engine          drives the tool loop — reads files, runs commands, streams results back to you
      │
      ▼
Routing layer         internal OpenAI-compatible endpoint; every model call goes through here
      │
      ▼
Provider router       failover chain across 22+ providers
```

### Smart routing options (all configurable in the panel)

| Option | Default | What it does |
|---|---|---|
| **Quality gate** | On | If a model gives a weak answer, TierMux automatically retries with a smarter model instead of showing you a bad reply |
| **Hot standby** | On | The next fallback model is pre-warmed in the background — so escalating to it feels instant, not slow |
| **Chat hedging** | On | Short messages are sent to a fast and a smart model at the same time; whichever answers well first wins |

---

## Providers & Models

22 pre-configured providers, 121+ models out of the box:

> Agnes AI · Cerebras · Cloudflare Workers AI · Cohere · GitHub Models · Google AI Studio · Groq · HuggingFace Router · Kilo Gateway · LLM7 · LLM Gateway · Mistral · NVIDIA NIM · Ollama Cloud · OpenCode Zen · OpenRouter · OVH AI Endpoints · Pollinations · SambaNova · SiliconFlow · ZenMux · Zhipu AI

**Keyless (zero setup):** Kilo Gateway · OVH AI Endpoints · Pollinations  
**Custom endpoints:** any OpenAI-compatible URL — vLLM, LiteLLM, Azure OpenAI, Cloudflare AI Gateway, etc.

---

## Modes & Capabilities

| Mode | Behavior |
|---|---|
| **Ask** | Read-only — explains, documents, answers. Never touches your files. |
| **Plan** | Reads your code, produces a step-by-step plan, waits for approval before acting. |
| **Agent** | Full loop — reads files, applies diffs, runs terminal commands, tracks progress with checkpoints. |

**Auto** mode classifies your message and picks the right mode + model automatically.

**Agent also gives you:** checkpoints (undo any turn) · parallel tabs · diff review before writes · configurable terminal approval · session replay on failure

**Editor:** right-click → Explain / Fix / Refactor / Generate Tests / Docs · Fix with AI on squiggles · inline chat `Ctrl/Cmd+I` · git commit messages · optional autocomplete (off by default)

### Skills (slash commands)

Drop a Markdown file into `.tiermux/skills/<name>.md` (or `.agents/skills/<name>/SKILL.md`). Invoke as `/<name>`. Only the one-line name + description loads up front; the full prompt reaches the model only on invocation — no context bloat.

### MCP servers

Register any MCP server in the TierMux panel. TierMux connects, discovers tools, and exposes them to the agent as native capabilities.

---

## Install & First Run

**Requirements:** VS Code `1.90+` · internet connection · at least one enabled provider.

### From Marketplace
Extensions view (`Ctrl/Cmd+Shift+X`) → search **TierMux** → Install.

### From source
```bash
git clone https://github.com/mainulBUBT/TierMux.git
cd TierMux
npm install
npm run package          # produces tiermux-*.vsix
code --install-extension tiermux-*.vsix
```

### First run
1. Click the **TierMux** icon in the Activity Bar.
2. **⚙ Manage Models & Keys** → enable providers, add API keys, set priority order.
3. Leave everything on **Auto** and start typing.

> No `settings.json` editing needed — everything is point-and-click in the panel.

---

## Settings

All settings live in the TierMux panel (`Manage Models & Keys` for providers; `Others` for behavior). Changes apply immediately.

| Setting | Default | Keep on? | What it does |
|---|---|---|---|
| Quality gate | On | ✅ Yes | Auto-retries with a smarter model if the first answer is weak |
| Hot standby | On | ✅ Yes | Pre-warms the next fallback so escalation feels instant |
| Chat hedging | On | ✅ Yes | Races fast + smart models on short turns; takes the better answer |
| Require write confirmation | On | ✅ Yes | Shows a diff before writing to any file |
| Command approval | Always | ✅ Yes (start here) | Confirms before running terminal commands — switch to auto-approve once you trust it |
| Max iterations | `25` | — | Agent steps before it pauses and checks in with you |
| Max concurrent runs | `3` | — | How many chat tabs can run agents simultaneously |
| Request timeout | `60s` | — | How long to wait on a provider before trying the next |
| Rate-limit cooldown | `60s` | — | How long a rate-limited provider is skipped |
| Reference price | Per-model | — | Used to calculate your savings estimate (`0` to hide) |

---

## Privacy

- **Keys** — stored in VS Code's encrypted secret storage. Never written to disk, never synced, never logged.
- **No TierMux backend.** Every request goes VS Code → provider API directly.
- **Feedback & stats** — local extension storage only, never uploaded.
- **Nothing you type is sent to TierMux** — only to the provider you (or Auto) selected.

Contributing? Read [PUBLISHING.md](PUBLISHING.md) before pushing — checklist for keeping local secrets out of the repo.

---

## License

MIT — free to use, modify, distribute. See [LICENSE](LICENSE).
