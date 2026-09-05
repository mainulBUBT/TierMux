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
provider inherits exactly that. TierMux pools them — one 429 and your turn quietly continues
on the next provider, mid-sentence.

## Install

1. Extensions (`Ctrl+Shift+X`) → **TierMux** → **Install**
   *(VSCodium / Cursor: the `.vsix` is on [open-vsx.org](https://open-vsx.org/extension/mainul-islam/tiermux))*
2. Activity Bar → **TierMux** → type.

Four providers ship keyless — your first message works with **no key, no account, no
config**. Add free keys later for more headroom → [Providers & keys](docs/PROVIDERS.md).

## Why people use it

| | |
|---|---|
| **It keeps going** | A 429, a dead key, a 5xx, a removed model or an *empty* reply all fail over to the next provider silently. Failing models are cooled down; ones that 404 or reject tools are quarantined. Several keys per provider, rotated. |
| **It finishes** | A turn that hits its step cap or gets stuck stops *visibly* and offers **Continue** with full memory — nothing is redone. After it edits files, your own test/typecheck/build command runs and failures go back to the agent for bounded fix rounds. |
| **Three modes** | **Ask** answers from evidence (reads, greps, `git log`) and never edits. **Plan** investigates and hands you a plan to approve, edit or discuss. **Agent** edits and runs commands behind approvals. |
| **Tools that work on weak models** | ripgrep `grep` (files-only, context, case-insensitive), paged `readFile`, `editFile` with exact failure diagnostics, a shell that Stop really kills, keyless `webSearch`/`fetchUrl`, `askUser`, and every tool from your **MCP servers**. Old tool output is aged out of the prompt so long turns stay fast. |
| **You stay in control** | Command approval: ask, safe allowlist, or shell off. Diff approval for writes. Paths can't escape the workspace. Checkpoints with real undo. A **Why this model?** popover on every reply. |
| **Bring your own** | Any OpenAI-compatible endpoint — vLLM, LiteLLM, LM Studio, Ollama, llama.cpp, Azure. Local servers are probed for their real context window. |

## How a turn is routed

Your message is classified (chat · coding · debug · plan · agent · vision — regex, no model
call), then a chain is built: your pinned model if any, else the task table's pick, then
every enabled model strongest-first — **one model per provider first**, so the chain spans
providers instead of burning one provider's whole list.

| the provider did this | TierMux does this |
|---|---|
| `429` | cools that key → next key → next provider |
| `401 / 402 / 403` | tries your other keys, then skips the platform for this turn |
| `404` model removed | next provider; skipped for 24 h |
| `400` with tools offered | next provider; marked tool-incompatible for 10 min |
| `5xx`, timeout, headers then silence | next provider |
| `200` but **empty** | next provider — a blank reply is not an answer |

Details: [Routing](docs/ROUTING.md).

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

More keys = fewer walls. Unused keys just rest → [Providers & keys](docs/PROVIDERS.md).

## How it compares

| | **TierMux** | Copilot | Cursor | Cline / Kilo |
|---|:-:|:-:|:-:|:-:|
| Usable every day at $0 | ✓ | ✗ <sup>1</sup> | ✗ <sup>2</sup> | ✗ <sup>3</sup> |
| Works with zero keys or accounts | ✓ | ✗ | ✗ | ✗ |
| Pools many providers' free tiers, auto-failover | ✓ | ✗ | ✗ | ✗ |
| Many keys per provider, auto-rotated | ✓ | ✗ | ✗ | ✗ |
| Any OpenAI-compatible endpoint | ✓ | ~ | ~ | ✓ |
| Agent + plan modes, MCP | ✓ | ~ | ✓ | ✓ |
| Open source, direct to provider | ✓ MIT | ✗ | ✗ | ✓ |

<sub>1. Copilot Free caps at 50 chat requests/month; usage-based billing since June 2026. 2. Proprietary fork; real usage sits behind paid tiers. 3. Free software, but every request bills your own API tokens.</sub>

## Docs

[Providers & keys](docs/PROVIDERS.md) · [Routing](docs/ROUTING.md) · [Features & modes](docs/FEATURES.md) · [Tips for free models](docs/FEATURES.md#getting-good-results-from-free-models) · [Contributing](CONTRIBUTING.md)

## Use as a library

```sh
npm install tiermux
```

```ts
import { runAgentStream, setModelSources } from 'tiermux';

setModelSources({ catalog, settings, secrets });
await runAgentStream({
  messages: [{ role: 'user', content: 'Refactor the router' }],
  mode: 'agent', effort: 'medium',
  onChunk: (t) => process.stdout.write(t),
});
```

Sub-paths: `tiermux/router`, `tiermux/agent`, `tiermux/providers`, `tiermux/shared`. Headless
use needs a small `vscode` shim — [`scripts/vscodeMock.cjs`](scripts/vscodeMock.cjs) is the reference.

## Privacy

Keys live in VS Code's encrypted secret storage. Requests go **VS Code → provider, directly** —
no TierMux server in the path. Nothing leaves your machine but the request itself.

---

MIT — [LICENSE](LICENSE) · [NOTICE](NOTICE)
