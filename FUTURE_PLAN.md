# Future Plan / Roadmap

Deferred features, with the **seams already in the code** so each is a small, well-scoped add later.
Nothing here is built yet — this is the "keep in mind" list.

Guiding principles (do not break):
- **Local-first** — the extension works standalone (no required server) and talks to providers
  directly. A backend is on the roadmap (see §1); anything it adds must stay **optional**.
- **Privacy-first** — user content/keys never leave the machine without explicit, off-by-default opt-in.
- **Free-tier aware** — bound the number of network calls; never hammer a provider.

---

## 1. Cross-user telemetry — "which models do users like / what's best"

**Goal:** aggregate the local 👍/👎 model feedback across users to learn, e.g., "which free model is best at debugging."

**Status:** deferred — needs the planned backend (to receive/aggregate) plus opt-in consent.

**Already in place (local):**
- `src/config/modelStats.ts` `ModelStatsStore` records per-`taskKind::platform::modelId` up/down counts in `globalState`.
- `ModelStatsStore.snapshot()` is the **single read point** a sync would use. Nothing phones home today.

**What's needed to ship it:**
1. **Backend endpoint** to receive + aggregate (this is the no-backend tradeoff to decide).
2. **Opt-in consent** — add `freeLlmAgent.telemetry.enabled` (default **false**) and honor `vscode.env.isTelemetryEnabled`. Disclose clearly in the README + first-run.
3. **Anonymized payload** — send ONLY `{ platform, modelId, taskKind, up, down }`. **Never** send prompts, code, file paths, API keys, or anything identifying.
4. A `StatsSync.flush()` that, when enabled, POSTs `aggregate()` (a content-free rollup of `snapshot()`) on a throttle.

**Seam to add later:** a `StatsSync` interface + `ModelStatsStore.aggregate()`; call `flush()` from the existing vote path in `chatViewProvider`'s `vote` handler. ~1 small file + 1 setting + the endpoint.

---

## 2. Dynamic model list from providers

**Goal:** keep the model list current automatically instead of hand-maintaining `media/catalog.json` (model ids drift as providers add/drop models).

**Status:** deferred — **no backend needed** (queries providers directly, like every other call).

**Approach:**
- Add `listModels()` to `src/providers/openai-compat.ts` → `GET <baseUrl>/models` (OpenAI-compatible; most providers support it). Per-provider variance: OpenRouter returns rich metadata (`context_length`, pricing, supported params); most return ids only.
- Merge discovered ids into `Catalog` alongside the curated entries.
- "Refresh models from providers" action in the Manage Models UI; show discovered-vs-curated.

**The one caveat (important):** `/models` gives ids (sometimes context length) but **not** our curated routing metadata (`intelligenceRank`, `speedRank`, `supportsTools`, `supportsReasoning`). So discovered models start with **default metadata** (mid ranks; `supportsTools` optimistic; `contextWindow` from the response or a default). Two existing systems then refine them automatically:
- **Tool-quarantine** (`router.ts` / `secrets.ts`) drops models that reject tools.
- **👍/👎 feedback** (`modelStats.ts`) learns their real quality per task.

Keep `catalog.json` as the **curated seed / override** layer on top of discovery.

**Seams:** `OpenAICompatProvider.listModels()`, `Catalog.merge(discovered)`, Manage Models UI button + message type.

---

## 3. Predictive next-edit — "<PRODUCT_NAME> Tab" (Phase 3)

**Goal:** Cursor-Tab-style suggestion of the *next* edit + where to jump (branded via `PRODUCT_NAME` in `src/shared/branding.ts` — **not** "Cursor").

**Status:** deferred — experimental, highest effort, behind a flag.

**Approach (MVP):** after an accepted edit/completion, run a `predictNextEdit` call (recent changes + surrounding context) that returns the next likely edit **and its location**; surface it as an `InlineCompletionItem` at the predicted `Range` with a "Tab to jump" affordance. Gate behind `freeLlmAgent.completions.nextEdit` (default off) using the existing fast-model path.

**File:** `src/completions/inlineCompletion.ts` (today returns a single ghost-text item at the cursor; no jump-to-next).

---

## Done (for context — not future work)

Auto mode + task-aware routing, trivial fast-path, last-good sticky model, context-fit-aware failover,
rate-limit cooldown + tool-quarantine + tool-manifest budgeting, terminal `runCommand` + approval,
Debug/Orchestrator modes, project grounding, Harmony-token sanitization, centralized branding
(`PRODUCT_NAME` + `npm run rebrand`), local 👍/👎 model feedback. See `README.md` and git history.
