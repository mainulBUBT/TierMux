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

## 4. Usage tracking, cost & free-tier quota — "you burned X tokens" (Phase 1)

**Goal:** show users what they've consumed (like `ccusage`/OpenRouter Activity) — tokens & cost
per day/model, and **how close each free model is to its rate limit**. The most useful number for a
free-tier product.

**Status:** ready to build — **local only, no backend, works at N=1.** Highest value-per-effort.

**Why local-first works here:** every user already has their own signal on-machine. This delivers
~80% of the "which model is good *for me*" value with **zero** privacy/infra cost.

**Already in place:**
- `src/config/usage.ts` `UsageTracker` — session token totals (in-memory; resets on new chat). The
  **single write point** (`add()`) everything else hangs off.
- `media/catalog.json` already carries `rpmLimit` / `rpdLimit` / `monthlyTokenBudget` per model — the
  quota denominators. No pricing field yet.
- `src/config/modelStats.ts` already records local 👍/👎 per `taskKind::platform::modelId`.

**What to build:**
1. **`UsageHistoryStore`** — mirror `ModelStatsStore`: `globalState`, keyed `date::platform::modelId`
   → `{ requests, promptTokens, completionTokens, costMicros }`. Write from `UsageTracker.add(usage,
   platform, model)` (extend its signature). **Use a server-ready shape now** so §1's `flush()` can
   read it unchanged later.
2. **Footer additions** (preserve existing layout — minimal): append `$0.00` to the per-message and
   session footers; append `today: 31/250 req` (from `rpdLimit`) to the session footer.
3. **Usage tab** next to `Providers · MCP · Context`: per-model rows with a **quota bar**
   (`requests / rpdLimit`, amber >80%), tokens, cost; `Today · 7d · 30d` ranges; `usageHistory`
   message type.
4. **Personal "good for me" badge** in the model list (`main.js:829` meta line): `you: 👍5 · used 40×`
   from `modelStats` + `usageHistory`.
5. **Optional** `pricing: { inPerM, outPerM }` in catalog (omit ⇒ free) for the cost line — secondary,
   mostly `$0.00`.

**Seams:** `UsageHistoryStore` (new file), `UsageTracker.add` signature, one `usageHistory` message,
one settings tab. No router changes required for display.

---

## 5. Model leaderboard — volume + quality (Phase 2, extends §1)

**Goal:** rank models so users see **which is actually good**, replacing the hand-typed `sizeLabel`
("Frontier/Large/…") with data-driven labels. Two distinct boards:
- **Volume** ("most-used") — like **OpenRouter Rankings**; fed by §4's `usage[]` rows.
- **Quality** ("best, per task") — like **LMArena/Chatbot Arena** crowd votes; fed by `modelStats`
  `votes[]`. **Per-task** ("best free model for *debugging*") is the differentiator no public board has.

**Status:** deferred — needs §1's backend + opt-in consent. **Do not block Phase 1 on it.**

**The cold-start rule (important):** a new extension's board is empty at launch (N=1 looks broken).
So **seed it with the editorial `intelligenceRank`/`speedRank`** as the default ordering, and let
crowd data *earn its way in* and replace the seed as opt-in telemetry flows — the path LMArena took
(seeded → vote-driven).

**Pipeline (same as §1):** `globalState` → `StatsSync.flush()` (consent-gated) → anonymized POST to
your endpoint → server aggregates `approval = Σup/(Σup+Σdown)`, `samples`, `bestFor`, token volume →
`GET /insights` → `Catalog.merge(insights)` → data-driven badge in the model list. **Never** send
prompts/code/paths/keys — only `{ platform, modelId, taskKind, up, down, requests }` + a random
`installId`.

**Seams:** `StatsSync` + `ModelStatsStore.aggregate()` + `Catalog.merge()` + the endpoint (server).

---

## Done (for context — not future work)

Auto mode + task-aware routing, trivial fast-path, last-good sticky model, context-fit-aware failover,
rate-limit cooldown + tool-quarantine + tool-manifest budgeting, terminal `runCommand` + approval,
Debug/Orchestrator modes, project grounding, Harmony-token sanitization, centralized branding
(`PRODUCT_NAME` + `npm run rebrand`), local 👍/👎 model feedback. See `README.md` and git history.
