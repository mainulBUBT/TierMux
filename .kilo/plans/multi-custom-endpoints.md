# Plan — Multiple custom OpenAI-compatible endpoints (each with its own URL + key, named like a provider)

## Problem

Today TierMux has exactly **one** `custom` OpenAI-compatible endpoint slot
(`custom` platform, single base URL stored in `tiermux.endpoints`, single key
in SecretStorage). The provider is built on-demand in
`src/providers/index.ts:62-67` from the user-typed URL.

Two pain points:

1. **Only one slot.** People routinely want to add several:
   - their self-hosted **vLLM** / **LiteLLM** / **llama.cpp** server
   - a second regional endpoint for the same provider
   - an **Azure OpenAI** deployment URL (which is OpenAI-compatible but per-deployment)
   - a **Cloudflare AI Gateway** in front of multiple backends
   - a **LiteLLM proxy** they share with their team
   - an internal corporate gateway

   They all need their own base URL **and** their own API key (and usually a
   different model list). One shared slot forces the user to flip the URL every
   time and re-type the key.

2. **The model picker only ever shows the label "Custom"** for everything
   routed to this platform — even if the user has carefully named their
   vLLM or LiteLLM server. That makes "Auto" feel opaque: the user can't
   tell which endpoint a model actually came from. The assistant turn
   footer reads "Worked for Ns · model · **Custom**" instead of the user's
   own name.

## Goal

The user can add **as many** custom OpenAI-compatible endpoints as they want
from the in-app Providers panel, each with:

- a **name** (user-chosen; e.g. "vLLM", "My LiteLLM", "Azure prod", "CF
  Gateway") — this name is shown everywhere a provider is named, exactly like
  built-in providers ("Google", "Groq", …).
- a **base URL** (validated to look like `https://…`)
- an **API key** (stored in SecretStorage, masked in the input)
- a list of **model IDs** the user can enable per endpoint

The settings panel replaces the single "Custom" card with an **"Add custom
endpoint"** button that grows a list. Each row is collapsible, has edit/remove,
and the user can flip individual models enabled/disabled exactly like built-in
providers.

The new endpoints appear in **the model picker with their own group header
using the user's chosen name** — so models from "vLLM" and "My LiteLLM" are
visually distinct, the disabled/healthy status dot uses the same colors as
built-in providers, the model row's "platform" badge reads the user-chosen
name, and the assistant's footer line ("Worked for Ns · model · vLLM")
displays the user-chosen name. They are first-class providers from the user's
point of view.

End-state behavior for **the new endpoints**:

- Auth: `Authorization: Bearer <key>` (matching the existing
  `OpenAICompatProvider.authHeader`).
- Per-endpoint model list, default-enabled = false.
- Routing/failover/cooldown/model-key overrides all work the same as built-ins.
- The router's existing `requireTools` / `isDeprecated` /
  `markToolIncompatible` paths all already key off `platform::modelId`, so they
  work for free.
- The remote-catalog fetch path stays untouched (this is purely about user-added
  endpoints).
- A future-readiness note: a small `supportsVision` / `supportsTools` /
  `supportsReasoning` toggle on the model row would be nice but is out of scope
  for v1; the router already defaults to "unknown = permissive" so a brand-new
  custom model can still be routed to. The model picker caps ("T", "V", "R")
  just show nothing for these rows.

## Design

### Data model

Persisted in `globalState` (workspace-global, same scope as
`tiermux.fallback` and `tiermux.endpoints` today):

```ts
// src/shared/types.ts
export interface CustomEndpoint {
  /** Stable id used everywhere (catalog keys, settings lookup, UI). */
  id: string;            // e.g. "c_3k91q4x" — short, url-safe, generated on add
  /**
   * User-chosen display name. Shown everywhere a provider is named:
   *  - the providers panel card header
   *  - the model picker group header (e.g. "── vLLM ──")
   *  - the model row's platform badge
   *  - the assistant turn footer ("Worked for Ns · llama-3.1-8b · vLLM")
   *  - the failover notice
   * Must be unique among custom endpoints (validated on save).
   */
  name: string;          // user-facing label
  baseUrl: string;       // https://..., validated, trailing slash stripped
  /** Optional default headers (e.g. for a Cloudflare AI Gateway custom header). */
  extraHeaders?: Record<string, string>;
  /** Models the user wants to expose under this endpoint. */
  models: CustomModel[];
  /** Unix-ms when created. */
  createdAt: number;
}

export interface CustomModel {
  modelId: string;       // upstream model id the provider's /v1/chat/completions expects
  /** User-visible label. Falls back to modelId when empty. */
  displayName?: string;
}
```

Stored as `tiermux.customEndpoints: CustomEndpoint[]` in `globalState` — same
Memento used by `SettingsStore`. Existing `tiermux.endpoints` (for the legacy
single `custom` URL) is **kept and read as a fallback** for one release so a
user upgrading from 0.1.0 doesn't lose their setup; new entries go to
`tiermux.customEndpoints`.

`SecretStore` gets a parallel store: `tiermux.key.custom.<id>` (and
`tiermux.modelKey.custom.<id>::<modelId>` for per-model overrides, mirroring
the existing `tiermux.modelKey.<platform>::<modelId>` scheme).

### Wire identity

The trick is the `Platform` union is closed (literal type). Adding
`custom` already worked because `custom` is a literal. To add *many* custom
endpoints we have two options:

1. Widen `Platform` to include `custom_<id>` strings and generate one literal
   per endpoint (won't compile because the union must be known).
2. **Keep `Platform` closed** and add a parallel `provider` string on
   `FallbackEntry` and the runtime model identity. Use `'custom' + '::' + id`
   as the catalog key everywhere.

Option 2 is far less invasive: `catalog.key('custom', 'c_3k91q4x::llama-3.1-8b')`
becomes `custom::c_3k91q4x::llama-3.1-8b`. Every existing site that does
`${e.platform}::${e.modelId}` keeps working — we just need to make
`e.platform = 'custom'` and `e.modelId = '<endpointId>::<upstreamId>'`.

The model id includes a separator (`::`) which is already used in
`SettingsStore.reconcile` etc. for the same purpose.

### "Provider name" plumbing

The user-chosen name is the *only* thing shown to the user in provider-labeled
contexts. Internally we keep using the literal `'custom'` for routing —
nothing else changes. The mapping happens at exactly three sites:

1. **The model picker group header** (`media/main.js:rebuildModelPicker`).
   Today it groups by `m.platform` using `PLATFORM_NAMES[m.platform] || m.platform`.
   Extend the lookup to first check the built-in `PLATFORM_NAMES` map, then
   the `customEndpoints` map (by parsing `modelId` to recover the endpoint
   id, then looking up `endpointsById[id]?.name`).

2. **The model row's "platform" badge** — same lookup.

3. **The assistant turn footer** (`renderAssistantStatic`,
   `Worked for Ns · model · platform`). The `platform` string comes from
   `result.platform` on `AgentResult`, which is set by the provider. Today
   `OpenAICompatProvider` exposes `this.platform === 'custom'` (a literal);
   we change the provider to expose a runtime name and a runtime platform
   *separately*:
   - `this.platform: Platform` (still `'custom'`, used by the router for key
     lookups, model-key overrides, deprecation, etc.)
   - `this.runtimeName: string` (user-chosen name, used by
     `AgentResult.platform` and surfaced to the UI).

   The `Router.route` method already calls
   `_routed_via: { platform, model }` and the
   `ChatViewProvider.pushAssistantTurn` line is
   `model: result.model ? `${result.platform}/${result.model}` : undefined`
   — we just need `result.platform` to carry the user-chosen name here.

4. **Failover notices** and **assistantStart** — same path: the UI gets the
   `runtimeName` for display; the router uses the literal `'custom'`.

The wire-level `Platform` literal stays unchanged. The catalog's
`CatalogModel.platform` stays `'custom'`. The fallback entry's
`FallbackEntry.platform` stays `'custom'`. Only the *display name* changes.

### Provider resolution

`resolveProvider(platform, baseUrlOverride)` becomes
`resolveProvider(platform, modelId, baseUrlOverride)` for `'custom'`:

- Parse `<endpointId>` out of `modelId` (everything before the first `::`).
- Look up the endpoint by id.
- Build an `OpenAICompatProvider` with that endpoint's `baseUrl`,
  `extraHeaders`, `name` (= endpoint.name, the user-chosen display name),
  and the resolved key.
- Cache the built provider in a `Map<customEndpointId, OpenAICompatProvider>`
  for the session so we don't re-construct on every call.
- Pass the user-chosen name through to the provider's `runtimeName` field so
  the agent result carries it.

`baseUrlOverride` in `CompletionOptions` keeps its meaning (per-platform
override of a default URL); for `'custom'` it stays unused because the URL
lives on the endpoint itself.

### `Router` — no real changes

The router's candidate list, failover, cooldown, requireTools, and
`isDeprecated` paths already work off `FallbackEntry` + `catalog.find`. A
fallback entry `{ platform: 'custom', modelId: '<id>::llama-3.1-8b', enabled, priority }`
is treated like any other. `catalog.find` returns `undefined` for these
entries (the bundled `media/catalog.json` doesn't know about them) and the
router's existing null-tolerant code (`a.m?.intelligenceRank ?? 5`,
`a.m?.contextWindow ?? 32768`, `supportsTools !== false` short-circuit) handles
that gracefully.

The one thing the router does that depends on the catalog: vision-aware
routing uses `supportsVision`. Since custom models have no catalog entry, they
default to non-vision. The `vision` task kind's comparator
`orderForTask` would rank them last. That's fine — the user explicitly
enabled a non-vision model. If the user later wants vision routing for a
custom model, the v2 add-model row will let them flip `supportsVision` (out of
scope for this plan, called out in the "Future" section).

### `SettingsStore`

- Add `getCustomEndpoints(): CustomEndpoint[]` / `setCustomEndpoints(list)`.
- Drop the now-only-used-by-the-legacy-`custom`-platform
  `tiermux.endpoints['custom']` read into a single legacy `CustomEndpoint`
  shape on the first call to `getCustomEndpoints` (one-time migration; only
  fires when `tiermux.customEndpoints` is empty AND the legacy slot is
  populated, and the resulting endpoint is named "Custom (legacy)" and
  pre-disabled so the user has to opt in).
- `reconcile(fallback)` currently only keeps entries whose key is in the
  catalog. Extend it to also keep entries whose `platform === 'custom'` and
  whose `<endpointId>` is in the custom-endpoints list. Re-append any
  user-added models that disappeared (e.g. because the user removed the
  endpoint then added it back).
- New `setCustomEndpoint(endpoint)` / `removeCustomEndpoint(id)` mutators that
  fire `onDidChange`.

### `SecretStore`

- `getCustomKey(endpointId)` / `setCustomKey(id, key)` / `clearCustomKey(id)`
  → SecretStorage at `tiermux.key.custom.<id>`.
- `getCustomModelKey(endpointId, modelId)` / `set...` / `clear...`
  → `tiermux.modelKey.custom.<id>::<modelId>`.
- `resolveKey(platform, modelId?)` gets a new branch for `platform === 'custom'`:
  try the model key, then the endpoint key, return `''` if keyless
  (an endpoint with an empty key is allowed — useful for local vLLM).
- `snapshot()` (used by the providers panel) skips per-endpoint keys (no need
  to expose N rows for a single conceptual provider); instead we surface a
  per-endpoint status in a new field.

### `ConfigPayload` (extension → webview)

Add a `customEndpoints: CustomEndpointSummary[]` field where
`CustomEndpointSummary = { id, name, baseUrl, keyless, configured, modelCount }`.
The webview needs the **`name`** here because it's used to label model-picker
group headers and badges (see "Provider name" plumbing). The full model list
isn't pushed to the webview — the webview reads the fallback chain for that
(it already does).

### UI — providers panel (`media/main.js:renderProviders`)

Replace the single "Custom" provider card with a **Custom Endpoints** section:

```
+ Add custom endpoint
────────────────────────────────────
[vLLM]  ● key set  ▾
   URL:   https://my-vllm.example.com/v1   [Save] [Reset]
   Key:   sk-…***********  [Update]   [Remove key]
   Models:
   ☑ llama-3.1-8b-instruct  · "Llama 3.1 8B"
   ☐ qwen2.5-coder-7b       · "Qwen 2.5 Coder 7B"
   [+ Add model]
   [Remove endpoint]
────────────────────────────────────
[LiteLLM]  ● missing  ▸
   [expand to edit]
```

State:

- `pendingAdds` — list of new endpoints the user is building but hasn't saved.
- `pendingModels` per endpoint — model id + display name rows.
- Each card tracks `dirty: boolean` so we can show "Save changes" when
  the user types in the URL/key field.

Adding an endpoint flow:

1. User clicks **+ Add custom endpoint** → a new "new endpoint" card appears
   with empty URL/key and a generated default name ("Custom endpoint N").
2. User fills in name + URL + (optional) key, clicks **Save**. On save:
   - Validate URL starts with `http(s)://` and is well-formed.
   - If key was entered, store in SecretStorage.
   - Generate `id` (`c_` + 6 random base36 chars).
   - Persist the endpoint via `setCustomEndpoint`.
   - Send `{ type: 'addCustomEndpoint', endpoint }` to the host.
3. Host validates, persists, and pushes updated `config.customEndpoints`.

Editing a model flow:

- The user clicks **+ Add model** under an endpoint, types a model id (free
  text — they're typing what the upstream actually serves), gives it an
  optional display name, and the model is appended to the endpoint's
  `models[]` *and* a corresponding `FallbackEntry` is added (enabled=false by
  default, priority = max+1) to the fallback chain. They tick the checkbox to
  enable.
- Toggling the checkbox updates the fallback entry's `enabled` flag
  (`setFallback`).
- **Remove model** removes the fallback entry and the model from the
  endpoint's `models[]`.

Removing an endpoint:

- Confirmation modal.
- Host: removes the endpoint from `customEndpoints`, removes all its
  fallback entries, removes the endpoint key + all per-model keys from
  SecretStorage, fires `onDidChange`.

Key updates:

- An empty key field on a saved endpoint means "no key" (e.g. local vLLM).
  We never store the empty string — we just don't call `setCustomKey`.
- A non-empty key is stored. The input shows a "Set" / "Update" button; we
  don't render the existing key (it's secret).

### Host message protocol

Add to `InMessage` (extension/webview protocol):

```ts
| { type: 'addCustomEndpoint'; endpoint: CustomEndpoint }
| { type: 'updateCustomEndpoint'; endpoint: CustomEndpoint }
| { type: 'removeCustomEndpoint'; id: string }
| { type: 'setCustomEndpointKey'; id: string; key: string | null }
| { type: 'addCustomModel'; endpointId: string; model: { modelId: string; displayName?: string } }
| { type: 'removeCustomModel'; endpointId: string; modelId: string }
```

Host handlers live in `ChatViewProvider.onMessage`, mirror the
`setKey` / `setEndpoint` / `setFallback` flow: validate, persist via
`SecretStore` / `SettingsStore`, fire `_onChange`, then `void this.sendConfig()`
to refresh the webview.

### Validation rules (host)

- `name`: 1..40 chars, trimmed, not empty. **Must be unique** among custom
  endpoints (case-insensitive). The UI prevents duplicates by checking
  `customEndpoints` before enabling Save.
- `baseUrl`: must match `^https?://.+`, no trailing slash, well-formed URL.
- `modelId`: 1..200 chars, no `::` (we use that as the inner separator) and
  no whitespace.
- Reject duplicates by id.
- A custom endpoint may not be named exactly like a built-in platform
  (`google`, `groq`, …) — we don't enforce the conflict in v1 because the
  UI's name field is free text and the `platform` literal stays `custom`.

### Edge cases / future-readiness

- **Renaming a built-in platform breaks an old config**: nothing in this
  plan changes the literal `Platform` union, so this stays safe.
- **Catalog CSV override** still applies. The user can put their custom
  models in the published-sheet CSV too, in which case the catalog finds
  them and they get caps in the model picker. Both paths are additive.
- **Settings export/import**: out of scope.
- **Per-model `supportsVision` toggle**: out of scope for v1. Documented in
  the plan's "Future" section.

## File touch list

| File | Change |
|---|---|
| `src/shared/types.ts` | `+ CustomEndpoint`, `+ CustomModel`; `+ customEndpoints: CustomEndpointSummary[]` on `ConfigPayload` |
| `src/config/secrets.ts` | `+ getCustomKey` / `setCustomKey` / `clearCustomKey` / per-model variants; `resolveKey(platform, modelId?)` honors them |
| `src/config/settingsStore.ts` | `+ getCustomEndpoints` / `setCustomEndpoint` / `removeCustomEndpoint`; extend `reconcile` to keep custom entries; legacy one-time migration |
| `src/providers/base.ts` | `+ runtimeName?: string` on `BaseProvider` (used by `AgentResult.platform` so the UI can show the user-chosen name) |
| `src/providers/openai-compat.ts` | accept `name` from `OpenAICompatOpts` and expose it as `runtimeName` on the base class |
| `src/providers/index.ts` | extend `resolveProvider(platform, modelId?, baseUrlOverride?)` to build from custom endpoint; cache built providers; propagate `runtimeName` from the endpoint's user-chosen name |
| `src/router/router.ts` | forward `baseUrlOverride: this.settings.getEndpoint(entry.platform)` (unchanged) — the provider carries the runtime name back via `result.platform` so the UI shows the user-chosen name in the assistant footer / failover notice |
| `src/agent/agent.ts` | when reading `result.platform` / `result.model` for the assistant footer, prefer the provider's `runtimeName` (so the footer reads "Worked for Ns · llama-3.1-8b · vLLM") |
| `src/messages.ts` | `+ addCustomEndpoint` / `updateCustomEndpoint` / `removeCustomEndpoint` / `setCustomEndpointKey` / `addCustomModel` / `removeCustomModel` |
| `src/chatViewProvider.ts` | `+ onMessage` cases for the six new messages; `+ sendConfig` includes `customEndpoints`; `+ migrateLegacyCustom()` runs once on activation |
| `media/main.js` | `renderProviders()` gets a new "Custom endpoints" section: add/edit/remove cards, model list rows, key input (masked) |
| `media/main.css` | `+ .custom-endpoints`, `+ .endpoint-card` styles (consistent with `.provider-card`) |
| `README.md` | new paragraph under "Configuration" documenting the multi-endpoint UI |

No new dependencies. No new providers. No changes to the wire format for
non-custom models.

## Implementation order

1. Types (`shared/types.ts`, `messages.ts`).
2. `SettingsStore` + `SecretStore` extensions.
3. `providers/index.ts` resolveProvider for custom endpoints.
4. `chatViewProvider.ts` handlers + `sendConfig` + legacy migration.
5. `media/main.js` renderProviders + add/edit/remove.
6. `media/main.css` styles.
7. README paragraph.
8. `npm run typecheck` + `npm run build` clean.

## Testing (smoke)

- `npm run typecheck` clean.
- `npm run build` produces a dist.
- Manual:
  1. Open Providers panel → click **+ Add custom endpoint**.
  2. Type name "vLLM", URL `http://localhost:8000/v1`, leave key empty.
  3. Save → card appears with `● missing` (keyless).
  4. Add model `llama-3.1-8b-instruct`, tick enable.
  5. Model picker shows `── vLLM ──` group (not "Custom") with `Llama 3.1 8B`
     and the platform badge reads "vLLM".
  6. Type "hello" → routes to vLLM (the existing preflight ping + chat
     completion should work end-to-end through `OpenAICompatProvider`).
  7. The assistant turn footer reads e.g. "Worked for 2s · llama-3.1-8b · **vLLM**"
     (user-chosen name, not "Custom"). The `_routed_via.platform` debug line
     still shows `custom` (the wire-level literal), and the failover notice
     shows `vLLM` (user-chosen name).
  8. Rename the endpoint to "My vLLM Box" → the model picker group header
     updates without a reload, the footer updates on the next turn.
  9. Add a second endpoint "LiteLLM" with model `gpt-4o-mini` — both groups
     appear in the picker; Auto routing falls through them independently.
  10. Remove an endpoint → its fallback chain entries drop, its key +
      per-model keys clear, its row in the providers panel disappears.
  11. Restart VS Code → all of the above persists in `globalState`.
- Edge: legacy user with a `tiermux.endpoints.custom` value upgrades →
  one-time migration creates a disabled "Custom (legacy)" card. User can
  re-enable and add models.

## Future (not in this plan)

- Per-model `supportsVision` / `supportsTools` / `supportsReasoning` toggles
  on custom model rows so vision-aware routing works for them.
- A "Test connection" button on each card that does a one-token ping and
  surfaces a green/red badge.
- Auth schemes other than `Bearer` (Azure uses `api-key` header; some
  gateways want a custom header). Tracked for v2.
- Sharing/importing custom endpoint configs across machines.
- A dedicated "Custom" group in the model picker that *also* lists the
  user-chosen name as a header on the fallback chain entry, so the picker
  shows both the platform and the name (e.g. `custom / vLLM`). v1 shows
  just the user-chosen name.
