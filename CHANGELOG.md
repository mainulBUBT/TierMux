# Changelog

All notable changes to TierMux are documented here. The format is loosely
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [Unreleased]

### Added

- **OSS-ready library entry point.** `import { Router, runAgentStream,
  runPlanStream, runAskStream, classifyTask, createRouterProvider, ... } from
  'tiermux'` (or `'tiermux/router'`, `'tiermux/agent'`, `'tiermux/providers'`,
  `'tiermux/shared'`). The same agent engine that powers the VS Code
  extension is now consumable from any Node 18+ application. The library
  build is wired into `npm run build`; declaration files are emitted by
  `npm run typecheck:lib`. A smoke test (`npm run test:e2e:library`)
  proves the public surface resolves under plain Node with the same
  `scripts/vscodeMock.cjs` shim the e2e suite uses.
- **`package.json` exports map**, `files`, `sideEffects: false`, and
  `keywords` updates so the npm tarball contains only what consumers need
  and the package.json's `import`/`require`/`types` resolution paths all
  work.
- **`NOTICE`** — Apache-2.0 §4(d) attribution for the bundled Vercel AI SDK
  and `pdf-parse`, plus an informational list of other MIT/ISC/BSD
  dependencies. Required for the AI SDK's Apache-2.0 license when shipped
  bundled.
- **`CONTRIBUTING.md`** — build, layout, and the simple-core rule summary.
- **`CHANGELOG.md`** (this file).
- **Library smoke e2e** (`scripts/librarySmoke.e2e.ts`) — headless
  end-to-end proving `Router`, `runAgentStream`, and `classifyTask` import
  and run under plain Node.

### Changed

- `esbuild.js` now produces a third artifact (`dist/<lib>.cjs` for each
  public entry) alongside the existing extension and webview bundles. The
  extension build path is unchanged.

### Out of scope (follow-ups, not in this release)

- Engine `vscode` decoupling (Approach B) — config reads, filesystem
  calls, and workspace root resolution still go through `vscode.*` (or
  the supplied shim). A full host-boundary refactor is a separate change.
- Webview `@ts-nocheck` removal in `media/src/main.ts` and
  `media/src/bridge.ts`. Not a packaging concern; tracked separately.
- Marketplace artwork scan (vendor name, banner image) before publishing
  to the VS Code Marketplace or open-vsx.

## [2.1.7] — 2026-08-25 and prior

See git history. Pre-OSS packaging; everything from the simple-core reset
forward. The TierMux VS Code extension was distributed as MIT throughout —
this release makes the licensing + library surface explicit.
