# TierMux

**One agent. ~18 free LLM providers. Zero backend.**

TierMux is an agentic AI coding assistant for VS Code that multiplexes the **free tiers of ~18 LLM
providers** and routes each request to the best available model — automatically failing over when
one is rate-limited or down. It runs **entirely inside the extension**: no server, no telemetry,
no account. You add your own keys (some providers are keyless) and start coding.

> The name: **Tier** (free provider tiers) + **Mux** (a multiplexer that routes across them).

> Provider adapters, the model catalog, and routing are adapted from the author's MIT-licensed
> [`freellmapi`](https://github.com/tashfeenahmed/freellmapi) and run in-process here.

---

## Why TierMux

- **Free first.** Stacks the free tiers of Gemini, Groq, Cerebras, OpenRouter, Mistral, NVIDIA,
  GitHub Models, Cohere, Cloudflare, Zhipu, Ollama, Kilo, Pollinations, LLM7, HuggingFace,
  OpenCode Zen, OVH, Agnes — plus any custom OpenAI-compatible endpoint.
- **Smart routing.** It picks the right *kind* of model per task and remembers what worked, so a
  quick "hi" stays cheap and a refactor gets a capable tool model.
- **Resilient.** Automatic failover with rate-limit cooldowns and tool-compatibility quarantine —
  one provider hiccup doesn't stop you.
- **Private by design.** No backend; keys live in VS Code SecretStorage; nothing leaves your machine.

---

## Features

- **Auto mode (default).** Classifies each message and picks the behavior **and** the best free
  model — no mode-picking needed. A greeting gets a one-line reply on a fast model (no tools, no
  token burn); an edit request runs the full agent on a smart tool-capable model.
- **Explicit modes** (for power users):
  - **Chat** — read-only Q&A.
  - **Agent** — autonomous tool loop that reads/searches/edits files and **runs terminal commands**.
  - **Plan** — proposes a numbered plan → you approve → it executes.
  - **Debug** — reproduce → isolate root cause → fix → re-verify.
  - **Orchestrator** — breaks a big task into subtasks and runs them in sequence.
- **Agent tools** — read/list/search the workspace, diagnostics, create/write/edit/delete files
  (every edit shown as a **diff for approval**), and **run commands** (gated by an approval policy).
- **Checkpoints** — each turn is snapshotted; restore the workspace to before any message.
- **Per-task model feedback** — 👍/👎 a reply and the router learns which model answers *your*
  tasks best (stored locally).
- **Context-aware** — project grounding (knows your project's name/type/structure), ambient editor
  context, `@file`/`@folder`/`@symbol` mentions, and optional semantic codebase search.
- **Reasoning effort** (Off → Very High) for reasoning-capable models, with a collapsible thinking view.
- **Editor integration** — right-click Explain/Fix/Refactor/Tests/Docs, **Fix with AI** on
  diagnostics, **inline chat** (`Ctrl/Cmd+I`), ghost-text completions (off by default), and
  **AI commit messages** in the Source Control toolbar.
- **MCP** — connect Model Context Protocol servers for extra tools.

---

## Getting started (users)

1. Install the extension (or run it from source — see [DEVELOPMENT.md](DEVELOPMENT.md)).
2. Open the **TierMux** view in the Activity Bar.
3. Click **⚙ Manage Models & Keys** and **Set key** for at least one provider — or pick a
   **keyless** one (OVH / Pollinations / Kilo).
4. Leave **Mode: Auto** and **Model: Auto**, and just type. Ask a question, or ask it to build or
   fix something — Auto routes the rest.

---

## Configuration

Settings live under **TierMux** in VS Code settings (IDs keep the `freeLlmAgent.*` prefix):

| Setting | Default | What it does |
|---|---|---|
| `freeLlmAgent.agent.maxIterations` | `25` | Max agent tool steps before pausing to check in. |
| `freeLlmAgent.agent.requireWriteConfirmation` | `true` | Show a diff and confirm before file writes. |
| `freeLlmAgent.agent.commandApproval` | `always` | `always` / `allowlist` / `never` for `runCommand`. |
| `freeLlmAgent.agent.commandTimeoutMs` | `120000` | Max time a single command may run. |
| `freeLlmAgent.requestTimeoutMs` | `60000` | Per-provider request timeout before failover. |
| `freeLlmAgent.rateLimitCooldownMs` | `60000` | How long to skip a rate-limited provider. |
| `freeLlmAgent.completions.enabled` | `false` | Ghost-text inline completions. |

Model enable/priority and per-provider endpoint overrides are managed in **⚙ Manage Models & Keys**.

---

## Privacy

TierMux has **no backend**. It runs in the VS Code extension host and talks directly to each
provider you configure. API keys are stored in VS Code SecretStorage. The 👍/👎 model-quality
stats stay in local extension storage — nothing is sent anywhere. See [FUTURE_PLAN.md](FUTURE_PLAN.md)
for how an *optional, opt-in* telemetry feature could work later without changing this default.

---

## Development

See **[DEVELOPMENT.md](DEVELOPMENT.md)** to build and run TierMux from source (clone → `npm install`
→ **F5**), the project layout, and the one-command rebrand workflow.

## License

MIT.
