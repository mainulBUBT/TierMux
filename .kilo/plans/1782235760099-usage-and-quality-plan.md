# Plan — Show user usage (tokens + est. $ saved)

## Goal

Surface the user's token consumption and an estimated dollar amount they would have spent on a paid reference model, so the "free tiers" value prop is visible at a glance. Extend the existing chat footer with a single line that shows both the current session totals and lifetime totals (persisted).

## Decisions (locked)

- **UI:** extend the existing footer (`media/main.js:164`, `updateFooter` at `:2917`). No new tab, no new icon, no new chrome.
- **Scope:** session totals (in-memory) + lifetime totals (persisted to `globalState`). Per-model breakdown deferred.
- **Reset:** add a "Clear usage data" button to the existing **Others** settings tab (`media/main.js:1386` `renderOthersSection`).
- **Reference price:** hardcode GPT-4o list price for now — `$5 / $15 per 1M tokens in/out` — exposed as two new settings (`tiermux.usage.referencePriceInPer1M`, `tiermux.usage.referencePriceOutPer1M`) so advanced users can tune. Designed so a per-model `costPerMillion` can be added later (catalog change, deferred).
- **Out of scope:** quality leaderboard, implicit signals, per-provider free-quota tracking, per-model breakdown, new topbar icon, new settings tab, router behavior changes, backend sync, disk logs.

## Footer line format

```
Session: 12 req · 8.4k tokens · Saved $0.12 · ctx 12%   ·   Lifetime: 42k tokens · $0.58 saved
```

`Saved` = current-session tokens × reference price.
`Lifetime` = persisted totals in `globalState`.

## Affected files

- **New:** `src/config/usageStore.ts` — `UsageStore` class wrapping `globalState` with `addRequest(platform, modelId, promptTokens, completionTokens)`, `getLifetime()`, `clear()`. Stores `{ totalPromptTokens, totalCompletionTokens, totalRequests, totalSavingsUsd, firstRecordedAt }`. On every write recomputes `totalSavingsUsd` from the reference-price settings (so a user changing the price retroactively updates the display).
- **Modify:** `src/config/usage.ts` — keep the in-memory `UsageTracker` exactly as is. It remains the session detail source. No breaking change to callers.
- **Modify:** `src/messages.ts` — extend `UsageTotals` (`:36`) with `lifetime: { totalTokens, totalRequests, estimatedSavingsUsd, firstRecordedAt }`. `OutMessage.usageTotals` already exists at `:261`.
- **Modify:** `src/chatViewProvider.ts` — in `sendConfig` (`:1825`) and at each `usageTotals` post (`:1113, :1257, :1470, :1682`), include `lifetime: this.deps.usageStore.getLifetime()`. Add a `handleClearUsage` method for the new webview message. The existing `this.deps.usage` is unchanged.
- **Modify:** `src/extension.ts` — construct `UsageStore` from `globalState` (next to the other config stores), pass it into `ChatDeps` and `Router`. `Router` does **not** need a new dependency (recording happens in the chat path, not the router).
- **Modify:** `media/main.js`:
  - `updateFooter` (`:2917`) — accept the new `lifetime` field; render the two-segment line described above.
  - `renderOthersSection` (`:1386`) — add a "Usage data" section with a `Clear usage data` button that posts `{ type: 'clearUsage' }`.
  - Inbound message handler — add a `case 'clearUsage'` (no-op on the host side, just a confirmation toast).
- **Modify:** `media/main.css` — only if the new line wraps on narrow viewports; verify `.footer` (`:663`) handles two segments. No new design.
- **Modify:** `package.json` — add `tiermux.usage.referencePriceInPer1M` (default `5`, min `0`) and `tiermux.usage.referencePriceOutPer1M` (default `15`, min `0`) under `contributes.configuration.properties`. Description notes these are reference prices used to estimate savings.

## Task list (execution order)

1. Create `src/config/usageStore.ts` with the `UsageStore` class. `addRequest` reads the two reference-price settings via `vscode.workspace.getConfiguration('tiermux.usage')`, increments the persisted totals, recomputes `totalSavingsUsd`, persists via `mem.update`. `clear()` zeros the entry. `getLifetime()` returns a plain object copy. No external dependencies beyond `vscode.Memento`.
2. Extend `UsageTotals` in `src/messages.ts` with the `lifetime` field (re-export the type from `usageStore.ts`).
3. Add the two new settings to `package.json` `contributes.configuration.properties` under `tiermux.usage.*`.
4. In `src/extension.ts`, instantiate `UsageStore` and inject it into `ChatDeps.usageStore` and `Router` (Router only needs to call `usageStore.addRequest` per successful completion).
5. In `src/router/router.ts`, after each successful `chatCompletion` or `streamChatCompletion` (the lines around `this.usage.add(response.usage)` at `:448`), also call `this.usageStore.addRequest(entry.platform, entry.modelId, usage.prompt_tokens, usage.completion_tokens)`. One-line addition.
6. In `src/chatViewProvider.ts` `sendConfig` and every `usageTotals` post site, attach `lifetime: this.deps.usageStore.getLifetime()` to the payload. Add a `case 'clearUsage':` in `onMessage` that calls `this.deps.usageStore.clear()` and re-sends config.
7. In `media/main.js` `updateFooter`, render the two-segment line. Read `fmtTokens` (existing helper, `:100`) for token formatting. For the dollar value, use a small helper `fmtUsd(n) => '$' + n.toFixed(2)` (or `.toFixed(3)` if sub-cent is common).
8. In `media/main.js` `renderOthersSection`, add a `Usage data` card with one button: "Clear usage data" → `vscode.postMessage({ type: 'clearUsage' })`.
9. In `media/main.js` inbound handler, add `case 'clearUsage':` — show a small inline confirmation (e.g., flash the button label to "Cleared" for 1.5s) and re-render the Others tab. The actual clear happens in the host (step 6), which then re-sends config and the footer updates.
10. Build + typecheck.

## Validation

- `npm run typecheck` and `npm run build` pass.
- Manual smoke: open chat, send 3 messages, confirm footer reads `Session: 3 req · Nk tokens · Saved $X.XX · … · Lifetime: Nk tokens · $X.XX saved`. Reload the window — lifetime persists, session resets to zero. Open **Others** in the settings drawer, click **Clear usage data** — footer `Lifetime` zeroes out. Change `tiermux.usage.referencePriceOutPer1M` to `0` — `Saved` and `lifetime $` show `$0.00`.

## Risks

- `globalState` size: even with 10,000 lifetime requests, the stored JSON is well under 1 KB. No risk of hitting the ~5–10 MB cap.
- Reference price is a single global number. A future per-model cost change will require extending the catalog (out of scope now).
- The `$ saved` is a marketing number, not a bill — keep the wording as "Saved" / "saved" (not "spent") so users don't misread it as a charge.

## Out of scope (deferred)

Per-model token split, weekly rollups, quality leaderboard, implicit signals, new topbar command, free-quota burn-rate, per-model `costPerMillion` in the catalog, disk logs, backend sync.
