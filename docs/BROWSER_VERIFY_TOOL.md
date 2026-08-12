# Browser verification tool — design notes (WIP)

Status: research/design only, not implemented. Captures the reasoning from the
2026-08-12 design discussion so it can be picked up later without re-deriving it.

## Problem

`fetchUrl` (`src/agent/core/tools/network/fetchUrl.ts`) is a **static** fetch —
jsdom + regex-based main-content extraction. It cannot:
- render JS-heavy SPAs / dashboards
- take a screenshot
- see console/runtime errors on a page

CLAUDE.md's own guideline says frontend changes should be verified "in a browser"
before reporting done, but TierMux's agent currently has no way to actually look
at a running page — that verification step is 100% manual/user-driven today.

## Options considered

### Cloudflare Kitesurf (rejected for this use case)
https://developers.cloudflare.com/browser-run/kitesurf/ — lightweight stateless
browser engine on Workers, built for AI agents (screenshots, extraction, PDF),
3-7x lighter than Chromium, connect via CDP (Puppeteer/Playwright) or MCP.

Rejected because:
- Requires a Cloudflare account + API token — not truly keyless. Two integration
  models exist (user brings their own key vs TierMux proxies with a shared key)
  and neither fits cleanly: BYO-key means the feature silently doesn't work for
  most users; shared-key reintroduces the "backend TierMux operates and pays for"
  problem that got `ai-memory`/`agentmemory` rejected for the `remember` tool
  (see `rippling-gathering-parrot.md` plan).
- **Can't reach `localhost` anyway** — Kitesurf runs on Cloudflare's edge, so it
  has no route to a dev server running on the user's own machine. Since the
  primary use case (screenshot a localhost dev server to verify a UI change) is
  inherently local, a cloud browser service doesn't fit regardless of the key
  question.

### Other cloud screenshot/render APIs (Firecrawl, PhantomJsCloud, Zyte, Scrape.do, etc.)
Surveyed via web search — none are genuinely keyless for real use (Firecrawl's
"keyless tier" is ambiguous/agent-onboarding-specific; others are plainly
account+key metered services). Same localhost-unreachability problem applies.

### Local headless browser (playwright-core) — current direction
Bundle `playwright-core` (driver only, no bundled browser binary) and launch the
user's **system Chrome/Edge** via `channel: 'chrome'`. No API key, no signup, no
backend, no extension-size bloat from a bundled Chromium. Directly reaches
`localhost`. Matches TierMux's existing no-backend/in-process philosophy
(same reasoning that shaped the `remember` tool design).

Chosen over `puppeteer-core` for:
- `waitForLoadState('networkidle')` — waits for SPA hydration before
  screenshotting, avoiding blank/half-rendered captures
- typed errors (e.g. `TimeoutError`) that are easy to catch and turn into
  actionable messages
- `channel: 'chrome'` cleanly targets the system browser without needing a
  downloaded/bundled Chromium

Known gap to resolve before implementing: if the user has no Chrome/Edge
installed, the tool needs a graceful "disabled, here's why" path rather than a
hard failure — cross-platform executable detection still needs to be designed.

## Error/verification design (4 layers, all inside the tool's `execute()`)

1. **Launch failure** — no system Chrome found → `launch()` throws → catch and
   return an actionable message ("No local Chrome found — install Chrome or set
   `tiermux.chromePath`"), not a crashed turn.
2. **Navigation failure** — dev server not running → `page.goto(url, {timeout:
   15000})` throws `net::ERR_CONNECTION_REFUSED` → catch and return "Could not
   reach localhost:PORT — is the dev server running?".
3. **Page-level JS errors** — attach `page.on('pageerror', ...)` and
   `page.on('console', msg => msg.type() === 'error' ...)` listeners *before*
   navigating; collect anything raised during load and surface it alongside the
   screenshot in the tool result (e.g. "3 console errors: ...").
4. **HTTP status check** — inspect the `Response` from `goto()`; flag 4xx/5xx as
   an error condition ("page loaded but returned 404") rather than silently
   treating any successful navigation as success.

## Open question: how results reach the model

TierMux is multi-model, and many of the free/weak models it routes to are
text-only (no vision). There is currently no image/multimodal tool-result
pattern anywhere in `src/agent/core/tools/` — this would be new surface area.
Direction to evaluate: detect whether the active model supports vision; if yes,
attach the screenshot as an image content block; if no, save the screenshot to
disk and return only the text summary (console errors, HTTP status, file path)
so the user can open it, rather than sending bytes the model can't use.

## When would the agent actually call this tool?

Not yet decided — needs its own design pass, but the shape under consideration:

- **Not automatic on every edit.** Firing a browser launch after every file save
  would be slow and noisy, and most edits aren't frontend-visual changes. The
  tool should be model-invoked (like `fetchUrl`/`webSearch`), not
  loop-triggered.
- **System-prompt guidance, same pattern as `remember`'s guardrail lines** —
  tell the model explicitly: after a change to UI-affecting code (component,
  CSS, template) *and* a dev server is confirmed running, call this tool before
  claiming the change works. Needs a negative guardrail too, so a weak model
  doesn't start calling it for backend-only or non-visual edits.
- **Gate on "dev server is actually running"** — the tool shouldn't be the thing
  that starts the server; it should check/require a URL the agent already knows
  is live (e.g. from a prior `runCommand` that started `npm run dev`), otherwise
  every call degrades into the "navigation failure" path above.

## Self-fix loop (how the agent is meant to close the loop on what it sees)

The tool itself does not fix anything — it only reports. The fix loop is meant
to run entirely through the agent's normal edit-tool cycle, using this tool's
output as a new signal source:

1. Agent makes a UI-affecting edit.
2. Agent calls the verify tool against the running dev server.
3. Tool returns: screenshot (if vision-capable model) + console error list +
   HTTP status + any navigation/launch error.
4. If layer 2, 3, or 4 reported a problem, that becomes part of the model's own
   context for its *next* turn of reasoning — same as a failed test run or a
   TypeScript error would. The agent reads the console error text, locates the
   offending code (normal `Grep`/`Read` flow), edits it, and re-runs the verify
   tool to confirm the error is gone.
5. This is a bounded loop, not unbounded retries — needs the same kind of
   stop-condition thinking already in place for other agent loops (budget/stuck
   detection noted in the `agent-efficiency-initiative` memory) so a model
   doesn't thrash indefinitely against a screenshot that never becomes "correct"
   (e.g. cosmetic judgment calls have no crisp pass/fail signal the way a
   console error does).
6. Concretely: layers 2-4 above are the machine-checkable pass/fail signal that
   makes this loop viable at all (network error / console error / HTTP status)
   — the screenshot itself is comparatively soft feedback (useful to a
   vision-capable model, unusable as a boolean signal to a text-only one).

## Files this would touch (once actually planned)

Not scoped yet — this doc is upstream of a real implementation plan. When ready,
follow the same structure as the `remember` tool plan
(`~/.claude/plans/rippling-gathering-parrot.md`): write-side helper, tool file
under `src/agent/core/tools/`, registration in `tools/index.ts` (with the same
mode-scoping check — should this be excluded from Plan/Ask mode?), system-prompt
guidance, and a verification checklist.
