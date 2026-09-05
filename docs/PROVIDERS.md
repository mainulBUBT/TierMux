# Providers & keys

How to add providers, keys, and your own OpenAI-compatible endpoints.
For how TierMux *chooses* between them, see [ROUTING.md](ROUTING.md).

---

## Setting up providers

Everything provider-related lives in one place: **⚙ Manage Models & Keys**
(Command Palette → `TierMux: Manage Models & Keys`, or the gear in the chat header).

### 1. Keyless providers — nothing to do

| Provider | Why it's keyless |
|---|---|
| **Kilo Gateway** | anonymous free gateway |
| **OpenCode Zen** | free tier works without auth (a key unlocks more) |
| **Pollinations** | fully anonymous |
| **OVH AI Endpoints** | anonymous free tier |

They show a **keyless** badge and a green dot the moment TierMux activates. If you never
open the settings panel, these are what serve your turns.

### 2. Adding an API key

1. Open **⚙ Manage Models & Keys**.
2. Find the provider card (they're sorted: enabled first, then configured, then alphabetical).
3. Click **Set key** in the card header.
4. Paste the key. Most cards link straight to the provider's key page (`keyUrl`).

The status dot tells you where you stand:

| Dot | Meaning |
|---|---|
| ⚪ grey | no key stored |
| 🟢 green | key stored, provider healthy |
| 🟡 amber | rate-limited right now (cooling down) |
| 🔴 red | key rejected (401/403) — replace it |

Keys go into **VS Code's encrypted secret storage**, never into `settings.json` and never
into the repo.

### 3. More keys per provider = more headroom

This is the single biggest quality dial in TierMux. Click **Add key** on a provider that
already has one and TierMux keeps a *pool*:

```
 1 key .............. works, but you'll meet its rate limit
 3–5 providers ...... solid — one cools, another serves
 8+ providers ....... rain-or-shine
 + extra keys ....... TierMux rotates keys WITHIN a provider and cools
   per provider       each key independently before touching the platform
```

The header then reads `3 keys · rotating`. Mechanically:

- Each request takes the **first key not in per-key cooldown**.
- A 429/401 on one key cools **that key only** and the request retries on the next key.
- Only when **every** key in the pool is cooled does the whole platform go into cooldown
  and failover moves to the next provider.

There is no downside to adding keys — unused ones just rest.

### 4. Turning providers on and off

Every card has a switch that enables/disables **all** models of that provider at once.
Disabling is honoured by routing (a switched-off provider is skipped even if its key is
still stored) and the reason shows up in the [“Why this model?”](ROUTING.md#why-this-model) popover
as *“provider switched off in Manage Models & Keys”*.

Inside a card, each model has its own checkbox for finer control.

### 5. Overriding a base URL

Every provider card has an editable **base URL** with **Save URL** / **Reset**. Use it
when an upstream moves endpoints or you front a provider through your own proxy. It must
start with `http://` or `https://`.

### 6. Cloudflare Workers AI — two fields

Cloudflare is the one provider that needs **two** values, because its wire format is
`accountId:apiToken`:

1. **Account ID** — its own field in the card.
2. **API token** — the normal *Set key* button.

If the Account ID is missing, TierMux treats the platform as unavailable and routes around
it rather than sending a request that is guaranteed to fail.

### 7. Providers that arrive by themselves

The model catalog is fetched from `tiermux.catalog.url` in the background. That payload can
carry **provider definitions**, not just models — so a brand-new upstream becomes a
registered OpenAI-compatible provider (with its base URL, display name, key page and
keyless flag) **without an extension update**. Existing providers get their base URL
refreshed the same way when an upstream moves. Providers with dedicated implementations
(Google, Cloudflare) are never overwritten.

Force a refresh any time with `TierMux: Refresh Model Catalog`.

---

## Adding an OpenAI-compatible endpoint

Anything that speaks the OpenAI `/chat/completions` wire format works: **vLLM, LiteLLM,
LM Studio, Ollama, llama.cpp / llama-server, KoboldCpp, SGLang, TGI, LocalAI, Azure
OpenAI, your own gateway** — local or remote.

### Steps

1. **⚙ Manage Models & Keys** → scroll to **Custom endpoints (OpenAI-compatible)**.
2. **+ Add custom endpoint** → fill in:
   - **Name** — anything, e.g. `My LiteLLM`, `vLLM box`
   - **Base URL** — the path that has `/chat/completions` under it, e.g.
     `http://localhost:8000/v1`
3. **Set key** if the endpoint wants one. Local servers usually don't — leave it empty.
4. Add models, either way:
   - **⟳ Fetch models from API** — TierMux reads `<baseUrl>/models` and renders the
     result as clickable chips; click the ones you want.
   - **+ Add model** — type the upstream model id by hand (e.g.
     `llama-3.1-8b-instruct`) when the server has no `/models` route.
5. Tick the models you want in the fallback chain. Done — they're routable like any
   built-in.

Common base URLs:

| Server | Base URL |
|---|---|
| LM Studio | `http://localhost:1234/v1` |
| Ollama (local) | `http://localhost:11434/v1` |
| llama.cpp / llama-server / llamafile | `http://localhost:8080/v1` |
| KoboldCpp | `http://localhost:5001/v1` |
| vLLM / Lemonade | `http://localhost:8000/v1` |
| LiteLLM proxy | `http://localhost:4000/v1` |

### What TierMux does differently for custom endpoints

- **No request timeout, no TTFT gate.** A local model takes as long as it takes — cold
  VRAM load, prefill, then generation. Cloud failover math doesn't apply when there is no
  faster pool to fail over *to*. Your **Stop** button is the brake.
- **No preflight ping.** Unvetted upstreams fail a 1-token health check for reasons that
  have nothing to do with health.
- **Real context window detection.** A custom endpoint has no catalog entry, so its
  context window would default to 32 768 tokens — while LM Studio and Ollama commonly load
  a model at **4 096**. TierMux asks the server directly, per server type:

  | Server | Probe |
  |---|---|
  | LM Studio | `GET /api/v0/models` → `loaded_context_length` |
  | Ollama | `POST /api/show` → `model_info["<arch>.context_length"]` |
  | llama.cpp | `GET /props` → `default_generation_settings.n_ctx` |
  | KoboldCpp | `GET /api/v1/config/max_context_length` |
  | vLLM | `GET /v1/models` → `max_model_len` |

  Nothing is inferred from a port number — only a server that actually answers is
  believed. A server that answers nothing simply leaves the window unknown.

  This is the single reason a model that chats fine in LM Studio's own UI can look broken
  through an agent: that UI sends ten tokens, an agent sends thousands.

- **Endpoints are editable in place** — Rename, Save URL, Update/Clear key, remove
  individual models, or remove the endpoint (which removes its models and key too).

---

## Settings reference

The ones worth knowing (`Settings → Extensions → TierMux`, or `tiermux.*` in `settings.json`):

| Setting | Default | What it does |
|---|---|---|
| `tiermux.catalog.url` | TierMux worker | where the model + provider catalog comes from |
| `tiermux.models.autoEnableNew` | `true` | auto-enable models newly discovered in the catalog |
| `tiermux.agent.autoCompactThreshold` | `0.8` | compact the conversation past this fraction of the window (`0` disables) |
| `tiermux.agent.toolCompaction` | `light` | `light` = head+tail of large command output; `aggressive` reaches further |
| `tiermux.agent.commandApproval` | `always` | how `runCommand` is gated |
| `tiermux.agent.commandAllowlist` | `[]` | commands that skip the approval prompt |
| `tiermux.classifierModel` | `auto` | model the task classifier uses (`auto` prefers keyless: OpenCode → Kilo → OVH) |
| `tiermux.utilityModel` | `auto` | model for chat titles and commit messages |
| `tiermux.index.enabled` | — | symbol + dependency index |
| `tiermux.mcpServers` | `{}` | MCP server definitions |
| `tiermux.completions.enabled` | — | inline completions |
