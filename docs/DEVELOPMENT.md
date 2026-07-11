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
  agent/                # agent engine bridge (sdk.ts), task classification (routing.ts)
  backend/              # openCode proxy integration (routerProxy.ts, ocLauncher.ts)
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
