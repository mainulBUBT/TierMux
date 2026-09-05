# Features & modes

What TierMux ships, mode by mode.
Setup lives in [PROVIDERS.md](PROVIDERS.md); model selection in [ROUTING.md](ROUTING.md).

---

## Modes

Three modes, picked in the composer. **Ask** is the default.

| Mode | What happens |
|---|---|
| **Ask** | Q&A only — streams answers, strictly read-only tools, touches nothing. |
| **Plan** | Reads and searches read-only. `runCommand` is offered but every call is gated by an ask. Mutating tools are absent *and* policy-denied. The model ends the turn by calling `exitPlanMode` with a structured plan; you approve or reject the card. |
| **Agent** | Full tool set — diffs (you approve), terminal (you approve), checkpoints, revert. |

### Auto is a *model* choice, not a mode

The model picker sits next to the mode picker and defaults to **Auto**. Auto means "you
pick the model for me" — TierMux classifies the message and routes it (see
[ROUTING.md](ROUTING.md)). Pin a specific model instead and that turn goes to exactly that
model; only `Auto` triggers smart routing.

The two are independent: Ask + Auto, Agent + a pinned model, and every other combination
are all valid. Mode decides *what the agent may do*; the model picker decides *who does it*.

An approved plan executes as one agent turn with its steps enumerated in the prompt; the
model works the list with its tools and progress survives a reload (there's a Resume
button). Step-level pause/resume is not implemented — see
[PLAN_MODE_TOOL_BOUNDARY_2026-08-31.md](PLAN_MODE_TOOL_BOUNDARY_2026-08-31.md).

---

## What's inside

- **Self-healing routing** — per-key and per-platform cooldowns, tool-incompatible and
  deprecated quarantine, cached preflight health checks, honest errors naming exactly which
  providers failed and why.
- **Agent tools** — `readFile` (line-boundary paginated), `editFile`, `writeFile`,
  `deleteFile`, `listDir`, `glob`, `grep`, `runCommand`, `getDiagnostics`, `todoWrite`,
  `askUser`, `delegateTask`, `webSearch`, `fetchUrl`, plus `exitPlanMode` in plan mode.
  `webSearch`/`fetchUrl` run on TierMux's own keyless engine (Yahoo + DuckDuckGo +
  Marginalia, with a static-fetch reader) and are offered in **every** mode, so a plain
  factual question is answered instead of deflected.
- **Safety rails** — diff and command approval gates, a configurable command allowlist,
  `.env`/key-material read guards, a 60 s per-candidate connect timeout with failover.
- **Checkpoints** — the before-content of every write is captured *before* the mutation, so
  Undo genuinely restores.
- **Codebase-aware** — ripgrep-backed `grep`/`glob` (files-only, context and case options),
  ambient open-editor context, project rules and memory in `.tiermux/`.
- **Skills** — Markdown skills from `.tiermux/skills/` and the cross-tool
  `.agents/skills/<name>/SKILL.md` convention, invoked by `/name`. Install more with
  `TierMux: Add Skill from GitHub`.
- **MCP servers** — configure in `tiermux.mcpServers`, browse a registry, reconnect on demand.
- **Editor-wide** — inline chat (`Cmd/Ctrl+I`), selection explain/fix/refactor/tests/docs,
  commit-message generation, inline completions, searchable history, handoff notes.
- **Explainable** — [“Why this model?”](ROUTING.md#why-this-model) on every turn.
