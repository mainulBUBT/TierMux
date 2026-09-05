<p align="center">
  <img src="media/banner.png" alt="TierMux" width="520">
</p>

<h3 align="center">Stack free. Route smart. Ship faster.</h3>

<p align="center">
  A free, open-source AI coding agent for VS Code that pools <b>30+ free-tier LLM
  providers</b> into one self-healing surface.<br>
  Works with zero setup. No subscription. No per-token bill.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=mainul-islam.tiermux"><img alt="VS Marketplace" src="https://vsmarketplacebadges.dev/version-short/mainul-islam.tiermux.svg?style=flat-square&color=2e7d32&label=VS%20Marketplace"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=mainul-islam.tiermux"><img alt="VS Marketplace downloads" src="https://vsmarketplacebadges.dev/downloads-short/mainul-islam.tiermux.svg?style=flat-square&color=2e7d32&label=downloads"></a>
  <a href="https://open-vsx.org/extension/mainul-islam/tiermux"><img alt="Open VSX" src="https://img.shields.io/open-vsx/v/mainul-islam/tiermux?style=flat-square&color=2e7d32&label=Open%20VSX"></a>
  <a href="https://open-vsx.org/extension/mainul-islam/tiermux"><img alt="Open VSX downloads" src="https://img.shields.io/open-vsx/dt/mainul-islam/tiermux?style=flat-square&color=2e7d32&label=downloads"></a>
  <a href="docs/PROVIDERS.md"><img alt="providers" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Ftiermux.mainulislam3057.workers.dev%2F&query=%24.providers.length&style=flat-square&color=2e7d32&label=providers"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
</p>

---

Every free LLM tier rate-limits, caps out, or goes down. An assistant built on **one**
provider inherits exactly that. TierMux pools them — one 429 and your turn quietly
continues on the next provider, mid-sentence, without asking you anything.

## Install

1. Extensions (`Ctrl+Shift+X`) → search **TierMux** → **Install**
   *(VSCodium / Cursor / Antigravity: grab the `.vsix` from [open-vsx.org](https://open-vsx.org/extension/mainul-islam/tiermux))*
2. Activity Bar → **TierMux** → type.

Four providers ship keyless, so your first message works with **no key, no account, no
config**. Add keys later for more headroom → [Providers & keys](docs/PROVIDERS.md).

## What you get

**An agent that keeps going.**
- **Auto-routing** — every message is classified (chat, coding, debug, plan, vision…) and
  gets a model suited to it, from a self-updating catalog of hundreds of free models.
- **Auto-failover** — a 429, a dead key, a 5xx, a removed model, or an *empty* answer all
  move to the next provider silently. A model that fails is cooled down and skipped; one that
  rejects tools or returns 404 is quarantined so it never wastes your next turn.
- **Key rotation** — several keys per provider, each cooled independently.
- **Continue, not restart** — a turn that hits its step cap or gets stuck stops *visibly*
  and offers **Continue** with full memory. Nothing is repeated.
- **Verified work** — after the agent edits files, your project's own test/typecheck/build
  command runs; a failure goes back to the agent for bounded fix rounds before it reports.

**Three modes, one transcript.**
- **Ask** answers from real evidence — it reads files, greps, runs `git log` — but never edits.
- **Plan** investigates, then hands you a structured plan to approve, edit, or discuss.
- **Agent** edits and runs commands behind approvals you control.

**Tools built for weak free models.**
- ripgrep-backed `grep` (files-only, context lines, case-insensitive), paged `readFile`,
  search/replace `editFile` with precise failure diagnostics, a real shell with tree-kill on
  Stop, `webSearch` + `fetchUrl` with no API key, `askUser` for mid-task questions, and every
  tool from your **MCP servers**.
- Old tool output is aged out of the prompt between steps, so long turns stay fast on
  gateways that don't cache prompts.

**Under your control.**
- Command approval modes: ask every time, auto-run a safe allowlist, or disable the shell.
- Diff-approval for file writes, `../`-proof paths, checkpoints with real undo.
- A **Why this model?** popover on every reply: what was picked, what lost, and why.
- Any OpenAI-compatible endpoint: vLLM, LiteLLM, LM Studio, Ollama, llama.cpp, Azure OpenAI —
  local servers are probed for their real context window.

## How it works

```
  your message
       │
       ▼
 ┌────────────┐   what kind of turn is this?
 │  CLASSIFY  │   trivial · chat · coding · debug · plan · agent · longContext · vision
 └─────┬──────┘   regex-first, English + Banglish, no model call
       │
       ▼
 ┌────────────┐   1. the model you pinned      — if you pinned one, it runs alone
 │   CHAIN    │   2. the task table's pick     — curated best for that kind
 │            │   3. everything else enabled   — strongest model first
 └─────┬──────┘   one model per provider first, so the chain spans PROVIDERS
       │
       ▼
 ┌─────────────────── candidate 1 · Groq ─────────────────────┐
 │   key 1 ──429──▶ key 2 ──✓──▶ streaming ────────▶ ANSWERED │
 │            └─ cools that ONE key, not the provider         │
 └──────────────────────────┬─────────────────────────────────┘
                            │ request failed, or every key is cooled
                            ▼
 ┌─────────────── candidate 2 · Cerebras (next provider) ─────┐
 └──────────────────────────┬─────────────────────────────────┘
                            ▼
        Google ─▶ OpenRouter ─▶ Kilo ─▶ …   up to 20 candidates
```

| the provider did this | TierMux does this |
|---|---|
| `429` rate limit | cools that key → next key → next provider |
| `401 / 402 / 403` dead key, no credit | rotates your other keys first; then skips the whole platform for this turn |
| `404` model removed | next provider; the model is skipped for 24 h |
| `400` while tools were offered | next provider; the model is marked tool-incompatible for 10 min |
| `5xx`, timeout, headers then silence | next provider |
| `200 OK` but **empty** | next provider — a blank reply is a failure, not an answer |
| answered | done; that model's failure streak resets |

Full detail in [Routing](docs/ROUTING.md).

## Providers

<!-- catalog:start -->
**382 models** across **32 providers**, and the catalog updates itself —
new free models and whole new providers appear without an extension update.

| | |
|---|---|
| **Keyless — zero setup** | Kilo Gateway · OpenCode Zen · OVH AI Endpoints · Pollinations |
| **With a free API key** | Agnes AI · Aion Labs · Api.Airforce · Cerebras · ChatAnywhere · Cloudflare Workers AI · Cohere · Google AI Studio · Groq · Kenari · LLM7 · Mistral · ModelScope · Nara Router · NVIDIA NIM · Ollama Cloud · OpenAdapter · OpenRouter · OrcaRouter · Poolside · Requesty · Router9 · SambaNova · Token Router · xKiro · Zhipu AI |
| **Your own** | any OpenAI-compatible URL — vLLM, LiteLLM, LM Studio, Ollama, llama.cpp, Azure OpenAI |
<!-- catalog:end -->

More providers + more keys = fewer walls. Adding a key takes seconds and unused keys just
rest → [Providers & keys](docs/PROVIDERS.md).

## How it compares

| | **TierMux** | Copilot | Cursor | Cline | Kilo Code |
|---|:-:|:-:|:-:|:-:|:-:|
| Usable every day at $0 | ✓ | ✗ <sup>1</sup> | ✗ <sup>2</sup> | ✗ <sup>3</sup> | ✗ <sup>3</sup> |
| Works with zero keys or accounts | ✓ | ✗ | ✗ | ✗ | ✗ |
| Pools many providers' free tiers | ✓ | ✗ | ✗ | ✗ | ✗ |
| Auto-failover when a provider dies | ✓ | ✗ | ✗ | ✗ | ✗ |
| Many keys per provider, auto-rotated | ✓ | ✗ | ✗ | ✗ | ✗ |
| Any OpenAI-compatible endpoint | ✓ | ~ <sup>4</sup> | ~ <sup>5</sup> | ✓ | ✓ |
| Agent mode behind approvals | ✓ | ~ | ~ | ✓ | ✓ |
| Plan-then-execute | ✓ | ~ | ✓ | ✓ | ✓ |
| MCP servers | ✓ | ✓ | ✓ | ✓ | ✓ |
| Open source | ✓ MIT | ✗ | ✗ | ✓ <sup>6</sup> | ✓ <sup>6</sup> |
| Direct to provider, no vendor backend | ✓ | ✗ | ✗ | ✓ | ✓ |

<sub>
1. Copilot Free caps at 2,000 completions + 50 chat requests/month; Copilot moved to usage-based billing on 1 June 2026.
2. Cursor is a proprietary VS Code fork; real usage sits behind its paid tiers.
3. The software is free, but every request bills your own API tokens at provider rates — the cost moves, it doesn't disappear.
4. Copilot added BYOK in June 2026 — your own provider, including any OpenAI-compatible endpoint, for chat and agent sessions. It does not cover code completions.
5. Cursor accepts a custom OpenAI base URL on every plan, but Agent/Composer reject custom keys — BYOK is chat-only in practice.
6. Cline is Apache-2.0; Kilo Code is MIT (acquired by Anaconda, July 2026).
</sub>

Paid assistants rent you one vendor's stack. BYOK clients hand you a great UI and the
reliability problem. TierMux attacks the reliability problem itself, on the free tier.

## Docs

| | |
|---|---|
| [Providers & keys](docs/PROVIDERS.md) | keys, key rotation, custom OpenAI-compatible endpoints, settings |
| [Routing](docs/ROUTING.md) | how a model is chosen, failover, "Why this model?" |
| [Features & modes](docs/FEATURES.md) | every mode and every tool |
| [Architecture](docs/ARCHITECTURE.md) | how the engine is put together |

## Use as a library

The same engine, embeddable in Node 18+ — routing, failover, agent turns.

```sh
npm install tiermux
```

```ts
import { runAgentStream, setModelSources } from 'tiermux';

setModelSources({ catalog, settings, secrets });

await runAgentStream({
  messages: [{ role: 'user', content: 'Refactor the router' }],
  mode: 'agent',
  effort: 'medium',
  onChunk: (t) => process.stdout.write(t),
});
```

Sub-paths `tiermux/router`, `tiermux/agent`, `tiermux/providers`, `tiermux/shared`.
Headless consumers need a small `vscode` shim — [`scripts/vscodeMock.cjs`](scripts/vscodeMock.cjs)
is the reference.

## Privacy

Keys live in VS Code's encrypted secret storage. Requests go **VS Code → provider,
directly** — there is no TierMux server in the request path. Usage stats never leave your
machine.

---

MIT — [LICENSE](LICENSE) · [NOTICE](NOTICE) · [Contributing](CONTRIBUTING.md)
