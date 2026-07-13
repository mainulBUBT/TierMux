# Smart Auto Routing Engine — Implementation Steps

> **Status (2026-07-14):** Steps 1–6, 8, 9 complete and verified (typecheck clean, `npm run build` clean, `npm run test:e2e:scoring` → 8/8 pass). Step 7: the dev-facing **TierMux Router** output channel + per-model rationale is live; the in-chat webview "Why this model?" card is the remaining optional follow-up (the `onSelectionRationale` callback is already plumbed in `RouteOptions` for it).

Reference design: see the approved plan (Capability × Runtime × Preference, learned per-task metrics, Wilson confidence, typed failures, dual baselines, provider+model levels, explainable, configurable, bounded storage).

This file is the execution checklist. Each step is self-contained and testable. Do them in order — later steps depend on earlier ones.

---

## Phase 1 — Foundations (no behavior change yet)

### Step 1 — `src/router/wilson.ts`
Small stats util, pure functions, no VS Code deps. Export:
- `wilsonLowerBound(successes, total, z)` → number in [0,1]
- `betaMean(successes, total)` → number in [0,1] (Bayesian posterior mean, Beta(1,1) prior)
- `shrinkageFactor(n, k)` → confidence in [0,1] (n-driven, saturates around `k` samples)
- `lerp(prior, observed, confidence)` → `prior + confidence*(observed-prior)`

**Verify:** quick `scripts/selftest`-style assertions — `wilsonLowerBound(3,3)` < `wilsonLowerBound(194,200)`; `shrinkageFactor(0,..)`≈0, grows with n.

### Step 2 — `src/router/metricsStore.ts`
Persisted aggregates (`Agg` shape from plan). globalState key `tiermux.metrics`.
- Two key spaces: `${platform}::${modelId}::${taskKind}` and `${platform}` (provider aggregate).
- `record(platform, modelId, taskKind, sample)` updates **both** rings via EWMA (long alpha + fast alpha from `SCORING_CONFIG`), bumps counts.
- Getters: `successRate` (Wilson), `ttftShort/Long`, `totalShort/Long`, `drift()`, `failureBreakdown`, `rateLimitFrequency`, `sampleCount`, `confidence`.
- Pruning: drop keys where `n` < floor or `lastTs` older than TTL on load + periodically.
- `FailureType` union lives here (exported).

**Verify:** seed synthetic samples, assert EWMA moves, drift fires when fast≫slow, Wilson < raw mean for small n.

### Step 3 — `SCORING_CONFIG` + `TASK_WEIGHTS` (top of `src/router/scoring.ts`)
One exported, documented config object — every constant lives here:
EWMA alphas (long/fast), Wilson `z`, `K` min samples, exploration margin, drift multiplier, speed-floor ratio, shrinkage curve params, provider-multiplier curve, half-life, per-`FailureType` severity, balance-rule cap, and `TASK_WEIGHTS` per `TaskKind`.

**Verify:** no other file defines these magic numbers (grep).

---

## Phase 2 — Scoring engine (still not wired into Router)

### Step 4 — `src/router/scoring.ts` — `ScoringEngine.rank(ctx)`
Compute, per candidate:
- `CapabilityScore` — reuse `orderForTask()` ([agent/routing.ts](../src/agent/routing.ts)) rank position normalized. Leave the `// TODO: extract CapabilityProfile` note.
- `RuntimeMultiplier` — fuse reliability(Wilson, capped) × health × availability × speed(TTFT-dominant, dual-baseline) × providerHealth, each shrunk toward 1.0 by confidence.
- `UserPreference` — from `ModelStatsStore.score`.
- `final = Capability × Runtime × Preference`.
- Apply balance rule (TTFT > floor → can't beat fast-enough model).
- Margin-gated exploration: only perturb order if top-2 within exploration margin.
- Return `{ ordered: FallbackEntry[]; rationale: RationaleEntry[] }` — rationale for **every** model with score, per-signal contributions, confidence, and a "why selected / why not selected" string.

**Verify:** `scripts/scoring.e2e.ts` (or selftest) covers all 7 unit cases from the plan:
1. n=3@100% does not outrank n=200@97%.
2. 98%-but-45s loses to 95%-but-5s (balance rule).
3. Short-window TTFT spike → demoted fast.
4. Provider all-failing → its models sink below healthy-gateway models.
5. `tool_unsupported` excludes for `coding` only.
6. Cold start → order equals `orderForTask`.
7. Exploration fires only when top-2 within margin.

---

## Phase 3 — Wire into Router

### Step 5 — Router DI + metric capture (`src/router/router.ts`)
- Add optional ctor params `metrics?: MetricsStore`, `scoring?: ScoringEngine`.
- In `candidates()` (~L387): when `smartScoring` on, `this.scoring.rank(ctx)` replaces the raw `orderForTask` call.
- Capture loop (the learning): success path (~L674) records `{ok:true, ttftMs, totalMs}`; failure path (~L742) records `{ok:false, failureType, totalMs, rateLimited}`. Map existing error classification → `FailureType`.
- TTFT: instrument first-streamed-chunk time in the streaming branch; pass into the success record.
- Keep all hard availability gates (circuit `bad`, rate-limit, no-key) unchanged.
- Fire `onSelectionRationale` once per `route()` with the rationale.

### Step 6 — Baseline-relative slow (`src/config/slowModel.ts`)
Replace the fixed `SLOW_LATENCY_MS = 8_000` trigger: a model is marked slow only when its short-window TTFT/total exceeds its own long baseline × drift (with ≥K samples). `SlowModelStore` API unchanged; only what calls `markSlow` changes. Cold start → no slow flag.

---

## Phase 4 — Explainability surface

### Step 7 — Messages + webview
- `src/messages.ts`: add `onSelectionRationale?` to `RouteOptions`; add `SelectionRationale` message type (carries per-signal breakdown + confidence).
- `src/chatViewProvider.ts`: post `selectionRationale` (mirror `failoverNotice` ~L1997).
- `media/src/main.ts` (+ rebuild `media/main.js`): collapsible "Why this model?" line — chosen model, score breakdown, confidence, considered/skipped list with reasons.
- New lazy OutputChannel `'TierMux Router'` (engineLog pattern) for the dev trace.

---

## Phase 5 — Settings + glue

### Step 8 — Toggles + construction
- `package.json` → `contributes.configuration.tiermux.agent`: `smartScoring` (default **on**), `scoringTrace` (default off).
- `src/settingsMeta.ts`: two `SETTINGS_META` rows.
- `src/extension.ts`: construct `MetricsStore` + `ScoringEngine`, pass to `new Router(...)`; init + `onDidChangeConfiguration` wiring (chatHedging template, L295-303 / L384-391).
- No new hedging (sequential default; agent-layer hedging already exists).

---

## Phase 6 — Verify end-to-end

### Step 9 — Verify
1. Run the unit/selftest cases from Step 4.
2. **Run the extension** (F5): send chat turns, open the **TierMux Router** output channel — confirm per-turn rationale (chosen + why-not for others, with values). 4xx-spam a model → watch reliability/health fall and get named in rationale.
3. `scripts/scoring.e2e.ts` — fake providers returning slow/fail/429; assert demotion + provider collapse + rationale fires.
4. Toggle `smartScoring` off → today's `orderForTask` behavior restored unchanged.

---

## Definition of done
- All 7 scoring unit cases pass.
- Extension runs; TierMux Router channel shows a correct rationale per turn.
- 4xx-spam demotes a model and it's named in "why not selected".
- `smartScoring` off = byte-for-byte today's behavior.
- No magic constants outside `SCORING_CONFIG`; no hardcoded provider names/ms anywhere.
- globalState stays bounded (aggregates only, pruning works).
