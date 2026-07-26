# TierMux — Ideas to Adopt from `awesome-opencode`

**Source list:** https://github.com/xenitV1/awesome-opencode
**Scope note:** awesome-opencode is a list of **OpenCode CLI** plugins/agents/configs.
TierMux is a standalone VS Code extension with its own agent loop ([`src/agent/core/loop.ts`](../src/agent/core/loop.ts)) and router — it does **not** run the OpenCode plugin runtime. So we adopt **ideas and prompt content**, not code. OpenCode plugin code depends on APIs (`opencode.plugin.*`, `ctx`, `session.on`…) that don't exist in TierMux, so direct copy-paste breaks.

This doc splits items into: **what we already have**, **what's worth building**, and **what to skip**.

---

## ✅ Already native in TierMux (no work needed)

| awesome-opencode idea | TierMux equivalent |
|---|---|
| Plan / spec agents (OpenSpec, Micode, Roadmap) | [`planStructurer.ts`](../src/agent/planStructurer.ts) + [`clarify.ts`](../src/agent/clarify.ts) |
| Skills (Agent Skills, Openskills) | `tiermux.addSkill` command |
| Memory (Opencode Mem, Simple Memory) | `tiermux.editMemory` + memory store |
| CC Safety Net / destructive-command gate | [`commandGate.ts`](../src/edits/commandGate.ts) (`isDangerous`: `rm -rf`, `git push --force`, `git reset --hard`) + [`permission.ts`](../src/agent/core/policies/permission.ts) |
| Dynamic Context Pruning | [`condense.ts`](../src/agent/condense.ts) (`KEEP_TAIL` + re-cap) |
| Smart Title | [`session/titles.ts`](../src/session/titles.ts) |
| Auth provider rotation | Router already multiplexes keyless + keyed providers — no OpenCode auth plugin needed |
| Themes / TUI notifications / token toasts | N/A — TierMux is a VS Code extension, not a TUI |

---

## 🔨 Worth building in TierMux (high value, fits our architecture)

These are **real gaps**. Listed by effort/value.

### 1. `.env` / secrets read guard (Envsitter Guard pattern)
**Why:** Our `commandGate` blocks *destructive commands*, but a model can still `readFile` an `.env`, `id_rsa`, or secrets dir and leak it into chat/webFetch. There's no read-side guard today.
**Do:** In [`permission.ts`](../src/agent/core/policies/permission.ts), deny (or prompt) `readFile`/`glob` reads of `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.aws/`, `.ssh/`, `*credentials*`. Allow a "fingerprint" preview (filename + redacted) like Envsitter if user wants.
**Effort:** Small — one function + pattern list, hook into the existing `toolApproval`.

### 2. Stronger context-pruning knobs (Dynamic Context Pruning)
**Why:** We prune the tail on compaction only. Obsolete *mid-history* tool outputs still cost tokens.
**Do:** Add a "drop already-acted-on tool results older than N turns" pass before compaction in [`condense.ts`](../src/agent/condense.ts). Optionally expose a `/ctx`-style summary (Context Analysis).
**Effort:** Medium.

### 3. Structured plan annotation (open-plan-annotator / Plannotator)
**Why:** Our `planStructurer` produces a plan; there's no UI to strikethrough/edit/approve lines.
**Do:** Surface the structured plan in the webview with per-line accept/reject/edit. Reuses existing plan data — UI work only.
**Effort:** Medium (webview).

### 4. Brainstorm → Plan → Implement workflow (Micode / Agentic)
**Why:** TierMux has plan + clarify but not an explicit 3-phase mode switch with session continuity.
**Do:** Add a mode that enforces: no code tools in brainstorm, structured plan in plan phase, full tools in implement. Mostly prompt + mode flag wiring.
**Effort:** Small–medium.

### 5. Shell-strategy instructions (Shell Strategy)
**Why:** Models emit `&&` chains, pager commands, and interactive flags that hang in non-TTY child processes.
**Do:** Add a short instructions block to [`prompts.ts`](../src/agent/prompts.ts): avoid `&&`-chains, no pagers (`less`/`more`), no `-i` interactive flags, one command per step. Pure text — cheapest win.
**Effort:** Tiny.

### 6. Handoff prompt (Handoff)
**Why:** When a session hits context limits, there's no clean "continue here" summary.
**Do:** A command that emits a focused handoff prompt (goal, done, next, open decisions) from current session state. We already compute summaries in `condense`.
**Effort:** Small.

### 7. Ralph-Wiggum self-correct loop (Ralph Wiggum)
**Why:** Tighten `verifyGrounding`-style loop into an iterative self-correct pass for edits.
**Do:** After an edit tool call, optionally run a cheap verify step that checks the edit against its stated intent and re-opens if wrong. Guard with budget.
**Effort:** Medium.

---

## 🟡 Big / borderline — only if we commit

### 8. Background subagents (Pocket Universe, hcom, Oh My Opencode)
**Why:** TierMux is single-threaded; no parallel subagents, no inter-agent messaging.
**Reality:** This is a **core architecture change**, not a plugin port. Would need: subagent spawn/queue, isolated context, result fan-in to the main loop. High value but high cost — should be its own design doc, not folded in here.
**Decision:** Defer unless we make subagents a strategic priority.

### 9. OpenTelemetry export (opencode-plugin-otel)
We already have `src/profiler` + `showTelemetry`. OTLP export is a nice-to-have if external dashboards matter. Low priority.

---

## ⛔ Skip (not applicable)

- **All TUI/theme/notification plugins** — TierMux is a VS Code extension; VS Code themes & notifications cover this.
- **OpenCode auth plugins** (Antigravity, Codex OAuth, Gemini Auth) — our router handles provider access differently; these don't map.
- **`opencode` config/command plugins** (Subtask2, Openskills-as-config) — depend on OpenCode's config loader.
- **tmux/Zellij plugins** — terminal multiplexer concepts, irrelevant in an extension.

---

## Suggested build order

1. **Shell-strategy prompt** — tiny, immediate reliability win. (item 5)
2. **`.env`/secrets read guard** — small, real safety gap. (item 1)
3. **Handoff prompt** — small, high daily value. (item 6)
4. **Mid-history context pruning** — medium, cost reducer. (item 2)
5. **Brainstorm→Plan→Implement mode** — medium, makes "more agentic" tangible. (item 4)
6. **Plan annotation UI** — medium, polish. (item 3)
7. **Self-correct verify loop** — medium, quality. (item 7)

Subagents (item 8) only as a separate strategic decision.
