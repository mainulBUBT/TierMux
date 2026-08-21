# Developing TierMux

How to build, run, and work on TierMux locally.

## Prerequisites

- **Node.js 20+** and npm
- **VS Code 1.90+**
- **git**

## Run it for development

```bash
git clone <your-fork-url> tiermux
cd tiermux
npm install        # install dev deps (esbuild, typescript, vsce)
npm run build      # bundle src → dist/ and copy webview vendor assets into media/vendor
```

Then launch the extension:

1. Open the folder in VS Code.
2. Press **F5** (Run → Start Debugging). This opens a second window — the **Extension Development Host** — with TierMux loaded.
3. In that window, open the **TierMux** view in the Activity Bar.
4. Click **⚙ Manage Models & Keys** → **Set key** for a provider (or use a keyless one: OVH / Pollinations / Kilo).
5. Leave **Mode: Auto** / **Model: Auto** and start chatting.

For a fast edit loop, run the watcher in a terminal and just reload the dev window (`Cmd/Ctrl+R` in the Extension Development Host) after changes:

```bash
npm run watch      # esbuild rebuilds on save
```

> Editing **`media/`** (webview `main.js` / `main.css`) only needs a dev-window reload — it's served directly, not bundled. Editing **`src/`** needs a rebuild (the watcher handles it), then a reload.

## Testing without tokens (mock model)

Three ways to run the full agent with **zero API calls** — no keys, no enabled models needed:

1. **Canned fake (quick smoke):** launch config *"Run Extension (Fake Model — no tokens)"* (sets `TIERMUX_FAKE_MODEL=1`). Every turn makes one dummy tool call, then answers with canned text.
2. **Scripted fixture (scenarios):** launch config *"Run Extension (Mock Fixture — scripted scenario, no tokens)"*. Edit `.tiermux/mock/fixture.json` to script what the "model" does, step by step — native tool calls, plain text, or raw weak-model dialect (`<function=readFile>{…}</function>`) that exercises the rescue/nudge recovery paths. Steps queue **per taskKind** (`agent` = main turn, `coding`/`reasoning` = sub-agents like `delegate`/`implementPipeline`, `*` = any), so a parent turn and its sub-agents each play their own movie. Point `TIERMUX_MOCK_FIXTURE` at any other file to switch scenarios.
3. **Cassette (record once, replay forever):** run a REAL session with `TIERMUX_RECORD_CASSETTE=/path/cassette.json` set in the launch env. Every successful `Router.route()` response is appended verbatim. Convert it to a replayable fixture with `cassetteToFixture()` (`src/router/mockFixture.ts`), or just study the file to see exactly what a model sent.

Contract tests: `npm run test:e2e:mock-fixture` (queue semantics, full `runTurn()` over a fixture incl. dialect rescue, cassette round-trip). Most loop behavior can be developed this way — only prompt-tuning ("does the model actually listen?") still needs real tokens.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Production bundle (esbuild) → `dist/extension.js`. |
| `npm run watch` | Rebuild on change during development. |
| `npm run typecheck` | `tsc --noEmit` — type-check without emitting. |
| `npm run rebrand` | Sync `package.json` display fields from `PRODUCT_NAME` (see below). |
| `npm run package` | Build a `.vsix` with `vsce` (for sideloading/publishing). |

Always run `npm run typecheck` before committing — the bundler does not type-check.

## Project layout

```
src/
  extension.ts          # activation: constructs everything and wires it together
  chatViewProvider.ts   # hosts the webview chat, handles its messages
  agent/                # agent.ts (stable contract) + core/ (the AI SDK-based agent
                         #   engine: loop.ts, routerProvider.ts, tools/, policies/,
                         #   middleware/ — see docs/ARCHITECTURE.md), routing.ts (task
                         #   classification)
  backend/              # groundingVerify.ts (manual Plan-mode grounding check)
  router/router.ts      # multi-provider router: failover, cooldown, quarantine
  providers/            # provider adapters: base, openai-compat, google, cohere, cloudflare
  catalog/              # loads media/catalog.json into the model catalog
  config/               # secrets (keys), settingsStore, usage, modelStats
  context/              # project rules, ambient editor context, @-mentions
  edits/                # applyEdit (diff-approval gate), commandGate, checkpoints
  completions/ editor/ scm/ mcp/   # inline completion, inline chat, commit msgs, MCP
  shared/               # types + branding.ts (PRODUCT_NAME)
media/
  main.js  main.css     # webview UI (vanilla JS, no build step)
  catalog.json          # seed model catalog
```

**Core vs IDE layer:** `providers/`, `router/`, `catalog/`, and `agent/routing.ts` are largely IDE-agnostic; the rest is VS Code-specific. Keep new core logic free of `vscode` imports where practical.

## Rebranding (changing the name)

The display name lives in **one place**: `src/shared/branding.ts` (`PRODUCT_NAME`). All runtime and webview code references it. `package.json` is a static manifest VS Code reads before any code runs, so a script syncs it:

```bash
# 1. edit PRODUCT_NAME in src/shared/branding.ts
# 2. propagate to package.json:
npm run rebrand
```

`rebrand` only syncs **display** fields. The technical `tiermux.*` prefix (setting/command/view IDs) and the `publisher` are **not** touched by it — renaming those breaks users' saved settings and stored keys.

## Packaging

```bash
npm run package        # → tiermux-<version>.vsix
```
