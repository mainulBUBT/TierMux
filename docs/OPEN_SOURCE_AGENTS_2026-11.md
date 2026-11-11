# Open-source agents, compared — 2026-11

Why TierMux's 3.0.6 capability wave added what it added. Every competitor claim below was
re-verified against the named source on **2026-11-12** (links inline); the TierMux columns
reflect the code as of this release.

## The comparison

| | Claude Code | OpenCode | aider | Cline | Gemini CLI | Codex CLI | TierMux (3.0.6) |
|---|---|---|---|---|---|---|---|
| Subagents / delegation | ✅ custom subagents w/ own context | ✅ subagents, per-agent permissions | ➖ single loop | ➖ | ➖ (Jules is a separate async agent) | ➖ | ✅ read-only delegate + agent registry |
| Background processes | ✅ background tasks + `/tasks` | ✅ | ✅ watch mode | ➖ | ✅ | ✅ | ✅ **new** — `runCommand {background}` + `taskOutput` |
| Browser verification | ✅ (desktop) | ✅ | ➖ | ➖ | ➖ | ➖ | ✅ **new** — `browserVerify`, zero-dep CDP |
| Repo map / symbols | ➖ (relies on search) | ➖ | ✅ tree-sitter repo map | ➖ | ➖ | ➖ | ✅ **new** — regex symbol sketch, mtime-ordered |
| Plan / act separation | ✅ plan mode | ✅ build/plan agents | ✅ architect mode | ✅ Plan/Act | ➖ | ➖ | ✅ plan mode + exitPlanMode contract |
| Checkpoints / undo | ✅ | ✅ | git auto-commit | ✅ checkpoints | ➖ | ✅ | ✅ pre-write checkpoints |
| Hooks / deterministic automation | ✅ hooks | ✅ | ✅ lint+test auto-loop | ➖ | ➖ | ➖ | ➖ (deliberately — see notes) |
| Skills / commands | ✅ skills + slash commands | ✅ custom commands | ✅ custom commands | ➖ | ✅ 150+ extensions | ✅ | ✅ markdown skills (`/name`) |
| MCP | ✅ | ✅ | ➖ | ✅ marketplace | ✅ | ✅ | ✅ |
| Free-tier / multi-provider model access | ➖ subscription | ✅ 200+ providers | ✅ BYO keys | ✅ BYO keys | ✅ generous free tier | ➖ subscription | ✅ **core identity** — keyless free lanes + failover |

### Notes per agent (verified 2026-11-12)

- **Claude Code** — the de-facto feature bar: subagents with isolated context, lifecycle
  hooks, skills, custom slash commands, background tasks with `/tasks` management
  ([hooks](https://code.claude.com/docs/en/hooks),
  [subagents](https://code.claude.com/docs/en/sub-agents),
  [guide](https://www.marktechpost.com/2026/06/14/claude-code-guide-2026-25-features-with-examples-demo)).
- **OpenCode** ([docs](https://opencode.ai/docs/agents), [repo](https://github.com/opencode-ai/opencode)) —
  subagents in foreground/background child sessions with per-agent permission scoping; LSP
  diagnostics surfaced as a tool; 200+ providers. The Zen free lane's anonymous tier is
  locked to the official client (2026-09-16) — the gate TierMux's lane costumes past.
- **aider** ([repomap](https://aider.chat/docs/repomap.html), [features](https://aider.chat)) —
  the tree-sitter repo map remains the reference implementation of "give the model the
  codebase's shape cheaply"; automatic lint-and-test loop after each edit.
- **Cline** ([Plan & Act](https://docs.cline.bot/core-workflows/plan-and-act)) — two-mode
  workflow (separate models per mode allowed), checkpoints, MCP marketplace, now also a CLI
  and desktop app. **Roo Code shut down 2026-05-15**; its users largely moved to Cline/Kilo
  ([comparison](https://agentscamp.com/guides/comparisons/cline-vs-kilo-code-vs-roo-code)).
- **Gemini CLI** — sandboxed execution plus the distinctive extension directory
  (150+ extensions, incl. Jules orchestration) ([extensions](https://geminicli.com/extensions),
  [comparison](https://www.deployhq.com/blog/comparing-claude-code-openai-codex-and-google-gemini-cli-which-ai-coding-assistant-is-right-for-your-deployment-workflow)).
- **Codex CLI** — safest defaults: sandbox on by default with network disabled, three-tier
  permission model ([comparison](https://nektony.com/reviews/claude-code-vs-codex-cli-vs-antigravity-cli)).
- MCP has converged everywhere and is no longer a differentiator
  ([analysis](https://pub.towardsai.net/claude-code-vs-codex-cli-vs-gemini-cli-vs-opencode-the-real-differences-after-convergence-fe71401f3f8e)).

## The gap list this wave closed (3.0.6)

Ranked by how much they cost a working turn, from the 2026-11-11 gap analysis:

1. **No background processes** — `runCommand` blocked for its whole (≤10 min) timeout; the
   agent literally could not keep a dev server alive while editing. *Closed: background tasks
   (§Stage 1)* — the foundation the browser tool stands on.
2. **No browser verification** — `fetchUrl` is static jsdom; the design doc
   (`BROWSER_VERIFY_TOOL.md`) had existed since 2026-08-12 unimplemented. *Closed: `browserVerify`
   over the user's own Chrome via the DevTools pipe — zero dependencies.*
3. **No symbol awareness outside plan mode** — every agent/ask turn re-derived the codebase's
   shape through grep. *Closed: the symbol sketch (aider's repo-map idea, regex-grade).*
4. **Raw PDFs silently dropped** — scanned PDFs the webview could not render vanished at the
   engine door. *Closed: file-part passthrough + explicit not-delivered notes.*

## What we deliberately did NOT copy

- **Hooks** — deterministic lifecycle automation is a real Claude Code/OpenCode strength, but
  it is a config surface with security implications (shell commands fired by tool events).
  Deferred until there is a design pass of the same rigor as the permission policy.
- **Write-capable subagents / parallel fan-out** — TierMux's free-lane rate limits punish
  parallel model calls (the `/explore` batch was serialized for exactly that,
  CHANGELOG 3.0.5), and unsupervised writers under weak free models are how codebases get
  mulched. The read-only delegate with a report-back stays the safe default.
- **Bundled/embedded browsers** (Playwright Chromium, Obscura's Rust engine, cloud browsers
  like Kitesurf) — rejected for the dev-server use case: no browser reaches `localhost` from
  a cloud, a 70 MB+ binary fights the extension's size, and an approximate renderer answers
  the wrong question ("does it render like MY Chrome?"). The user's own Chrome is free,
  present, and pixel-exact. (Obscura was evaluated 2026-11-11 and kept out of scope;
  re-look if a scraping — not verifying — use case emerges.)
- **LSP write-side tools** (rename, format) — navigation-only code intel keeps the loop
  honest; edits flow through the checkpointed write tools.
