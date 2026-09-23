# Publishing to GitHub

Before staging/committing anything intended for a push to the public GitHub remote (`mainulBUBT/TierMux`), run the checklist in [PUBLISHING.md](PUBLISHING.md) — secret scan, known-sensitive-path check, personal-info sanity check. This applies on every device this repo is cloned on, not just the one the check was written on.

# The agent is Cline (2026-09-23)

TierMux does not build an agent: the loop, tools, prompt, rules, skills, compaction, MCP and
plan/act modes are Cline's SDK (`@cline/agents`, `@cline/core`). TierMux owns the model router
and providers underneath and the UI on top. Before touching `src/agent/core/cline/`, the
approval policy, or the webview's tool cards, read
[docs/CLINE_AGENT.md](docs/CLINE_AGENT.md) — who owns what, the seams, and how to upgrade
Cline. Do not add agent behavior in TierMux (detectors, nudges, prompt rules, a second tool
set). Verify with `npm run test:e2e:foundation` (THE contract) plus `test:e2e:cline-engine`
and the rest of `test:e2e:*`.
