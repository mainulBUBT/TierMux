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
| **OpenCode Zen** | free-tier models answer anonymously, but a stored key is the reliable path |
| **Pollinations** | fully anonymous |
| **OVH AI Endpoints** | anonymous free tier |

They show a **keyless** badge and a green dot the moment TierMux activates. If you never
open the settings panel, these are what serve your turns.

**OpenCode Zen is the exception, and it is worth knowing why.** Zen's *free-tier* chat models are
served **only to OpenCode's own client** — their docs say it plainly: *"Free-tier chat models require
OpenCode; use paid models or Go from other clients."* Since Zen v2 the gate answers everyone else
with `429 Free usage limit reached — Free models work in OpenCode; subscribe to OpenCode Go` (the
older spelling was `403 FreeTierError`). **That 429 is not your quota and a key does not unlock
these models.** It is the gate judging the *client*: retrying spends nothing down, and switching to
another free model on the same provider only earns the same answer. TierMux knows this, so one
refusal quarantines the whole free lane for 30 minutes and the turn carries on with your other
providers instead of burning a round-trip per model.

The gate has been measured (2026-11-10) to check **two layers**:

1. **The request body.** The first system message must carry a substantial prefix of the official
   client's agent prompt followed by an `<env>`-shaped block, and the 4-tool quartet
   (`bash`/`glob`/`grep`/`read`) must ride in `tools` — names suffice, schemas are not inspected.
   TierMux's free lane (`src/providers/opencodeLane.ts`, `opencodePrompt.ts`) sends exactly this
   costume: the decoy system message leads the messages, the caller's own system prompt follows it
   and stays in charge, and the quartet rides along pinned off (`tool_choice: "none"`) when the
   turn has no tools of its own.
2. **The TLS/HTTP stack.** Even a byte-perfect body is refused unless it arrives over the official
   client's network family (bun/BoringSSL). Node — the extension host — curl and python are all
   refused with the same 429, and no header or body change can fix that. **TierMux's answer is the
   bun shim**: every keyless lane request is executed by a short-lived `bun -e` child whose fetch
   speaks the admitted network family, and the response — status, headers, streamed body — is
   folded back into the provider's normal path (`src/providers/bunTransport.ts`). The bun comes
   from wherever it is found: one already on the PATH, `TIERMUX_BUN` (a full path), or — when
   neither is there — the one-time offer: a notification asks whether TierMux may download bun
   (~40 MB from the official GitHub release, ~90 MB on disk, kept in this extension's own storage —
   nothing system-wide, no PATH change, removed with the extension). "Not now" is remembered for a
   week, "Never ask" (or the *Offer to install bun* setting) forever — and the **TierMux: Install
   bun** command always works. Keyed requests never use the shim. `npm run test:e2e:bun-shim`
   covers the transport, `test:e2e:bun-install` the zip reader and offer flow, and a live
   `LIVE=1 npm run test:e2e:opencode-lane` proves the whole path from Node.

**What actually works from TierMux**, in order of cost:

| Route | Free models | Paid models | Notes |
|---|---|---|---|
| No key, bun (own, PATH, or auto-installed) | ✓ via the shim | ✗ | one `bun -e` child per request |
| No key, bun declined | ✗ refused (TLS layer) | ✗ | quarantined after one refusal; the offer returns weekly |
| Zen/Console key | ✓ — a keyed refusal falls to the lane automatically | ✓ with credits | pay-as-you-go, per-token; a dead key (401) still errors honestly |
| [OpenCode Go](https://opencode.ai/go) | ◐ only Go's own free rows (`beam-free`, …) | ✓ | subscription with included usage |
| OpenCode itself, locally | ✓ | ✓ | the real client |

A **stored key no longer blocks the free models**: the key sends requests keyed and direct, and the
gate refuses free-tier models for any third-party client — key or no key — so a keyed free-model
request drew the same 429 while the working lane sat unused beside it. TierMux now retries that
refusal once on the anonymous lane (costume + bun) and remembers the model, so later free-model
requests go straight there; models the key can actually serve — paid ones — stay keyed.

Where the line sits: TierMux dresses the *body* honestly around your real conversation (decoy prompt
leading, your system prompt and tools intact) and borrows the bun runtime — yours if you have one,
or one downloaded with your explicit OK into extension storage. It does not bundle a runtime in the
package, run a proxy daemon, or impersonate a browser. The `muse-spark-*` models answer only on
Zen's `/responses` endpoint (500 on `/chat/completions`), so TierMux sends those there and reads the
reply back as a normal chat stream.

**Refreshing the decoy prompt** (when Zen stops accepting the snapshot and the bun-live e2e turns
red): install the current opencode CLI, point its provider at a local capture server by dropping
this into `$XDG_CONFIG_HOME/opencode/opencode/opencode.json` —

```json
{ "provider": { "opencode": { "options": { "baseURL": "http://127.0.0.1:4599/v1" } } } }
```

— run `opencode run --model opencode/<free-model> "hi"` with `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/
`XDG_CACHE_HOME` pointed at throwaway dirs, and copy the first request's system message up to the
closing `</example>` (the static official part — everything past it is machine-specific) into
`OC_SYSTEM_PROMPT_PREFIX` in `src/providers/opencodePrompt.ts`. Bump `OC_VERSION` in
`opencodeLane.ts` to the CLI version you captured from. That is exactly how the 1.19.5 snapshot in
there was taken.

#### OpenCode Go — the route that *is* meant for agents like this one

Go is the opposite of the free gate. Its docs say it is "designed for OpenCode and other coding
agents that produce similar types of requests", and list what a client must do: send normal coding
traffic, identify itself "with its own user agent, such as `my-coding-agent/1.0`", and "send a
stable session ID in `x-opencode-session` for each conversation". TierMux already sends its own
`tiermux/x.y.z` UA, and now sends the session header to any `opencode.ai` endpoint. Nothing is
disguised — that is the whole point.

Wire it up as a **custom endpoint** (Go has no built-in card yet):

| Field | Value |
|---|---|
| Base URL | `https://opencode.ai/inference/go/openai/v1` |
| Key | your Console API key (`https://opencode.ai/console`) — **Go or Go Plus required** |
| Models | IDs from `https://opencode.ai/inference/go/v1/models`, e.g. `glm-5.3-flash`, `kimi-k3`, `deepseek-v4.1-flash`, `qwen3.8-flash`, `mimo-v2.6-flash` |

Plans are Go $10/mo, Go Plus $40/mo, Go Teams $20/member. Every text model is reachable over the
OpenAI-compatible route (Console translates), so one endpoint covers the catalog. The Go catalog
also carries rows with an unlimited allowance — `beam-free`, `iceman-contributor-free`,
`longcat-2.5-free` — which is the closest thing to a working "free model" from a third-party client.

A Zen key does **not** include Go entitlement: same credential infrastructure, separate subscription.

Also, before you tick a free-period model, read Zen's § Privacy: **Muse Spark 1.3 Contributor
Free** is "heavily discounted token pricing in exchange for permission to use your prompts and
completions to train future Meta models"; **Big Pickle / MiMo-V2.5 Free / Ling 3.0 Flash Fin
Free** may use collected data to improve the model; the **NVIDIA** trial rows say not to submit
personal or confidential data. Treat those as opt-in, not as a default route for your code.

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
| `tiermux.utilityModel` | `auto` | model for chat titles and commit messages |
| `tiermux.mcpServers` | `{}` | MCP server definitions |
| `tiermux.completions.enabled` | — | inline completions |
