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

- **Self-healing routing** — per-model cooldowns, key rotation, tool-incompatible (400 with
  tools) and deprecated (404) quarantine, honest errors naming exactly which providers failed
  and why.
- **Agent tools** — `readFile` (line-boundary paginated), `editFile`, `writeFile`,
  `deleteFile`, `listDir`, `glob`, `grep`, `runCommand`, `getDiagnostics`, `todoWrite`,
  `askUser`, `delegateTask`, `webSearch`, `fetchUrl`, plus `exitPlanMode` in plan mode.
  `webSearch`/`fetchUrl` run on TierMux's own keyless engine (Yahoo + DuckDuckGo +
  Marginalia, with a static-fetch reader) and are offered in **every** mode, so a plain
  factual question is answered instead of deflected.
- **Safety rails** — the tool-approval policy (ask / safe allowlist / shell off; write
  confirmation), every path argument confined to the workspace, a 60 s per-candidate connect
  timeout with failover.
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
- **Chats stay local** — each chat is one JSON file under VS Code's workspace storage for the
  extension (the last 50 per workspace); the panel opens with its transcript before keys and
  MCP servers are checked. Enable *Diagnostic trace* to see the open timing in the
  "TierMux Diag" output.

## Getting good results from free models

Free tiers are slow to first token and quick to rate-limit, and the models behind them are
weaker than the paid frontier. TierMux is built around that; these habits get the most out of it.

**Keys.** Add a free key for two or three providers beyond the keyless four, and add a second
key where a provider allows it. Every key is a separate quota; failover and rotation do the rest.

**Scope each turn.** One feature, one bug, one refactor per message. A weak model given a
five-part task drops parts; given one part it finishes. Name the files (`@src/foo.ts`) when
you know them — that is one fewer search for the model.

**Plan first for anything that touches several files.** Plan mode reads before it proposes,
asks when the request is ambiguous, and hands you a card to edit before anything runs. Execute
from the card and the agent starts with the plan in front of it.

**Let the verify gate work.** With `agent.verifyCommand: auto` the project's own test /
typecheck / build runs after every turn that edits files, and a failure goes back to the agent
for `agent.verifyFixRounds` fixes. Set a specific command if auto-detection picks the wrong one.

**Keep the prompt small.** `agent.toolCompaction: light` (default) stubs old tool output between
steps; `agent.autoCondenseTokenCap` (default 32 000) summarizes older turns so every request
stays bounded on gateways that don't cache prompts. Start a new chat when the topic changes.

**Use Continue, not "continue".** A turn that stops at the step cap or gets stuck offers a
Continue button with the full transcript in memory. Typing "continue" starts a new turn that
has to re-read.

**Pin a model only when you mean it.** A pinned model runs alone — no failover. Auto walks the
whole chain and tells you what it picked and why in the *Why this model?* popover.

**Approvals.** `agent.commandApproval: allowlist` runs the safe defaults (`npm test`, `git
status`, …) plus your own `agent.commandAllowlist` prefixes without a prompt and asks for the
rest; `never` switches the shell off entirely. `agent.requireWriteConfirmation: false` lets
file edits land without a prompt in agent mode — checkpoints still make every turn undoable.
