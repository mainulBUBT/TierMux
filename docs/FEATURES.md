# Features & modes

What TierMux ships, mode by mode.
Setup lives in [PROVIDERS.md](PROVIDERS.md); model selection in [ROUTING.md](ROUTING.md).

---

## Modes

Two modes, picked in the composer — Cline's plan and act.

| Mode | What happens |
|---|---|
| **Plan** | Reads and searches; no editor tool, and every shell command asks. The plan comes back as the answer — switch to Agent to carry it out. |
| **Agent** | Cline's full toolset — edits (you approve, or turn confirmation off), terminal (read-only commands auto-run, the rest follow your approval setting), checkpoints, revert. |

### Auto is a *model* choice, not a mode

The model picker sits next to the mode picker and defaults to **Auto**. Auto means "you
pick the model for me" — TierMux classifies the message and routes it (see
[ROUTING.md](ROUTING.md)). Pin a specific model instead and that turn goes to exactly that
model; only `Auto` triggers smart routing.

The two are independent: Plan + Auto, Agent + a pinned model, and every other combination
are all valid. Mode decides *what the agent may do*; the model picker decides *who does it*.

---

## What's inside

- **Self-healing routing** — per-model cooldowns, key rotation, tool-incompatible (400 with
  tools) and deprecated (404) quarantine, honest errors naming exactly which providers failed
  and why.
- **The agent is Cline** — Cline's SDK runs the loop and its tools: `read_files`,
  `search_codebase`, `run_commands`, `fetch_web_content`, `editor`, `skills`, `ask_question`.
  TierMux serves every model request from its router. See [CLINE_AGENT.md](CLINE_AGENT.md).
- **Safety rails** — the tool-approval policy (ask / safe allowlist / shell off; write
  confirmation) and a 60 s per-candidate connect timeout with failover. Cline's tools take
  absolute paths; reads are auto-approved, edits and non-read-only commands go through the
  policy.
- **Checkpoints** — the before-content of every write is captured *before* the mutation, so
  Undo genuinely restores.
- **Rules and skills** — Cline reads `AGENTS.md` and `.clinerules/` as rules and offers skills
  from `.cline/skills/` and `.agents/skills/` to the model. TierMux's `/name` slash skills
  (`.tiermux/skills/`, `.agents/skills/`) insert a skill's prompt yourself; install more with
  `TierMux: Add Skill from GitHub`. Ambient open-editor context is attached each turn.
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

**Plan first for anything that touches several files.** Plan mode reads before it proposes and
asks when the request is ambiguous. When the plan looks right, switch to Agent and tell it to go.

**Keep the prompt small.** Cline compacts older conversation before a request would overflow
the routed model's window (`agent.toolCompaction: auto`); `/compact` does it now. Start a new
chat when the topic changes.

**Use Continue, not "continue".** A turn that stops at the step cap or gets stuck offers a
Continue button with the full transcript in memory. Typing "continue" starts a new turn that
has to re-read.

**Pin a model only when you mean it.** A pinned model runs alone — no failover. Auto walks the
whole chain and tells you what it picked and why in the *Why this model?* popover.

**Approvals.** `agent.commandApproval: allowlist` runs the safe defaults (`npm test`, `git
status`, …) plus your own `agent.commandAllowlist` prefixes without a prompt and asks for the
rest; `never` switches the shell off entirely. `agent.requireWriteConfirmation: false` lets
file edits land without a prompt in agent mode — checkpoints still make every turn undoable.
