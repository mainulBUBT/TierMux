# Developing TierMux

How to build, run, test, and work on TierMux locally.

## Prerequisites

- **Node.js 20+** and npm
- **VS Code 1.93+**
- **git**

## Run it for development

```bash
git clone <your-fork-url> tiermux
cd tiermux
npm install        # install dev deps (esbuild, typescript, vsce)
npm run build      # bundle src → dist/ (also runs catalog/provider sync first)
```

Then launch the extension:

1. Open the folder in VS Code.
2. Press **F5** (Run → Start Debugging). This opens a second window — the **Extension Development Host** — with TierMux loaded.
3. In that window, open the **TierMux** view in the Activity Bar.
4. Click **⚙ Manage Models & Keys** → **Set key** for a provider (or use a keyless one: OVH / Pollinations / Kilo / OpenCode Zen).
5. Leave **Mode: Auto** / **Model: Auto** and start chatting.

For a fast edit loop, run the watcher in a terminal and just reload the dev window (`Cmd/Ctrl+R` in the Extension Development Host) after changes:

```bash
npm run watch      # esbuild rebuilds on save
```

> Editing **`media/`** (webview `main.js` / `main.css`) only needs a dev-window reload — it's served directly, not bundled. Editing **`src/`** needs a rebuild (the watcher handles it), then a reload.

## Testing without tokens

The e2e harnesses under `scripts/` are the no-token path, and they are the only one left. Each
bundles the real code (`runTurn`, the real toolset, the real picker) and injects a scripted
`LanguageModelV4` through the test seams — `__setEngineModelForTests`, `__setPlanModelForTests`,
`__setRouteOnceForTests` — so a scenario is a list of steps the "model" performs, not a recording.
`scripts/mockModel.ts` builds those models; `scripts/vscodeMock.cjs` stands in for the `vscode`
module so a harness runs under plain `node`.

Write a new scenario by copying the closest existing harness — `scripts/foundation.e2e.ts` is the
broadest — and adding an npm script next to its siblings.

> Three older no-token routes used to be documented here — a `TIERMUX_FAKE_MODEL` canned fake, a
> `TIERMUX_MOCK_FIXTURE` scripted fixture, and `TIERMUX_RECORD_CASSETTE` session recording. All
> three died with `src/router/mockFixture.ts` when the old Router was retired (2026-09-05):
> nothing in `src/` reads those variables. The two launch configs that set them and
> `.tiermux/mock/fixture.json` have been removed too, so `.vscode/launch.json` now has one
> config.

Only prompt-tuning ("does a real model actually listen?") still needs real tokens.

## Test harnesses

There is no single monolithic test runner — instead there are ~30 focused e2e harnesses in
`scripts/*.e2e.ts`, each proving one behavior against the real code paths. Run any of them via its
npm script:

```bash
npm run test:e2e:foundation       # THE contract: 32 scenarios over the real engine
npm run test:e2e:exit-plan-mode   # plan mode's tool boundary
npm run test:e2e:edit-match       # editFile search/replace failure diagnostics
npm run test:e2e:grep-options     # grep filesOnly / context / ignoreCase output shapes
npm run test:e2e:read-paging      # a truncated read always says where to resume
npm run test:e2e:tool-output-aging  # earlier steps' bulky outputs become stubs
npm run test:e2e:routing-gates    # picker skip filters, quota, rotation
npm run test:e2e:fit-messages     # per-model context-window fitting
```

Browse `package.json` → `"scripts"` for the rest; names map 1:1 to the behavior they cover
(`edit-gate`, `verify-detect`, `condense-split`, `delegate-task`, …). Start with `foundation` — the
core reset note treats it as the contract the loop must not break.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Sync catalog/providers, then production bundle (esbuild) → `dist/extension.js`. |
| `npm run watch` | Rebuild on change during development. |
| `npm run typecheck` | `tsc --noEmit` — type-check without emitting. |
| `npm run sync:catalog` | Pull remote model catalog into `media/catalog.json` and validate models against live provider APIs (retired models get dropped). |
| `npm run validate:catalog:offline` | Validate the committed catalog without network access. |
| `npm run package` | Build a `.vsix` with `vsce`. |
| `npm run package:all` / `publish:all` | Package/publish for all targets. |
| `npm run publish` | Publish to VS Code Marketplace **and** Open VSX (`ovsx publish`). |

Always run `npm run typecheck` before committing — the bundler does not type-check.

## Project layout

```
src/
  extension.ts          # activation: constructs everything and wires it together
  chatViewProvider.ts   # hosts the webview chat, handles its messages
  agent/                # agent.ts (stable contract) + core/ (the AI SDK-based agent
                        #   engine: engine.ts (the loop), routerProvider.ts, routeOnce.ts,
                        #   compact.ts, repair.ts, subagent.ts, tools/ —
                        #   see docs/ARCHITECTURE.md), routing.ts (task classification)
  backend/              # groundingVerify.ts (manual Plan-mode grounding check)
  permissions/          # the tool-approval policy chain
  router/               # picker.ts (model selection), capabilityProfile.ts,
                        #   rateTracker.ts, errors.ts
  providers/            # provider adapters: base, openai-compat, google, cohere,
                        #   cloudflare (+ remote-catalog upsert of new platforms)
  catalog/              # loads media/catalog.json into the model catalog
  config/               # secrets (keys), settingsStore, usage, modelStats
  context/              # project rules, ambient editor context, @-mentions, embeddings
  edits/                # applyEdit (diff-approval gate), commandGate, checkpoints,
                        #   gitSnapshot
  completions/ editor/ scm/ mcp/   # inline completion, inline chat, commit msgs, MCP
  shared/               # types + branding.ts (PRODUCT_NAME) + workReport.ts
media/
  main.js  main.css     # webview UI bundle (vanilla JS entry, built from media/src/)
  src/                  # webview TS sources (ui/components, ui/tool, handlers, format)
  catalog.json          # seed model catalog (auto-synced from remote)
scripts/                # e2e harnesses (test:e2e:*), mockModel.ts, sync & validate tooling
.tiermux/
  skills/               # user-editable slash-command prompts (doc, fix, tests, …)
  agent/                # system-prompt fragments loaded at activation
  design/               # design-skill references
```

**Core vs IDE layer:** `providers/`, `router/`, `catalog/`, and `agent/routing.ts` are largely IDE-agnostic; the rest is VS Code-specific. Keep new core logic free of `vscode` imports where practical.

## Rebranding (changing the name)

The display name lives in **one place**: `src/shared/branding.ts` (`PRODUCT_NAME`). All runtime and webview code references it. `package.json` is a static manifest VS Code reads before any code runs, so a script syncs it:

Edit `PRODUCT_NAME` there, then update `package.json`'s **display** fields (`displayName`,
`description`, and the `contributes` titles) by hand — the `npm run rebrand` script that used to
sync them is gone.

Change only display fields. The technical `tiermux.*` prefix (setting/command/view IDs) and the
`publisher` must stay — renaming those breaks users' saved settings and stored keys.

## Packaging & publishing

```bash
npm run package        # → tiermux-<version>.vsix
npm run publish        # → VS Code Marketplace + Open VSX (needs OVSX_PAT)
```

Before pushing to the public repo, run the checklist in [PUBLISHING.md](../PUBLISHING.md) (secret scan, sensitive-path check, personal-info sanity check).
