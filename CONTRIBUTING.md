# Contributing to TierMux

Thanks for your interest — TierMux is open source and contributions of every
size are welcome (typo fix, new provider adapter, a new tool, a router rule,
docs, tests).

## Code of conduct

This project follows the spirit of the [Contributor Covenant](https://www.contributor-covenant.org/):
be respectful, assume good faith, and focus on the work. Maintainers may
close or lock threads that don't meet that bar.

## Repository layout

| Path | What lives here |
|---|---|
| `src/extension.ts` | The VS Code extension entry point (wired in `package.json` `main`). |
| `src/agent/core/` | The mechanical-execution engine. **Do not add semantic judgment here** — see the simple-core reset doc. |
| `src/agent/` | The public agent contract (`AgentOpts` / `AgentResult` / `runAgentStream`). |
| `src/router/` | The failover router, Smart Auto scoring, and capability classification. |
| `src/providers/` | Built-in provider adapters (28 OpenAI-compatible + Google + Cloudflare + custom endpoints). |
| `src/chatViewProvider.ts` | The webview host — UI/UX glue, session state, the **only** place that talks to the webview via `postMessage`. |
| `media/src/` | The webview UI (vanilla TS, bundled to `media/main.js`). The webview import boundary plugin enforces that this folder may only import from itself or `src/shared/**` (type-only). |
| `scripts/` | End-to-end tests, benchmarks, catalog sync utilities. |
| `docs/` | Architecture, benchmarks, handoff notes, plans. Read `docs/SIMPLE_CORE_RESET_2026-08-24.md` before touching the engine. |

## Build, test, ship

```sh
npm ci                 # one-time install
npm run typecheck      # tsc --noEmit (whole repo, must pass)
npm run build          # produces dist/extension.js + dist/<lib>.cjs + media/main.js
npm run test:e2e:foundation  # THE contract — 32 scenarios; ~30 more, see package.json
```

`npm run build` is the source of truth for shipping. It runs `sync:catalog`
and `sync:providers` first (regenerate `media/catalog.json` and
`src/providers/index.ts` from upstream sources), then `node esbuild.js
--production`, which bundles three artifacts: the VS Code extension
(`dist/extension.js`), the webview (`media/main.js`), and the library entry
(`dist/index.cjs` + sub-paths).

The published library entry is type-checked by `npm run typecheck` against the
`exports` map in `package.json` (`./router`, `./agent`, `./providers`,
`./shared`). Anything re-exported there must stay `vscode`-free at import time —
the e2e harnesses prove this by running under plain Node with
`scripts/vscodeMock.cjs` supplying the shim.

## Adding a new provider

1. Append an entry to the `COMPAT` array in `src/providers/index.ts`
   (most providers are OpenAI-compatible and need no new file).
2. If the provider needs a bespoke wire format (e.g. tool calls under a
   different key, reasoning field naming), subclass `BaseProvider` and add a
   `register…` call in `src/providers/index.ts`. **Do not** swap out the
   `GoogleProvider` or `CloudflareProvider` with a generic compat instance —
   they have logic the generic path would lose.
3. Re-run `npm run sync:providers -- --apply` if your provider is brand-new
   and needs to be in the remote-catalog upsert path.
4. Add an e2e test under `scripts/` covering at least preflight + happy path.

## Adding a new tool

1. Create `src/agent/core/tools/v3/<name>.ts` exporting a `createXxxTool()`
   factory. Use `tool()` form with a Zod `inputSchema`, make `execute`
   exception-safe (expected failures return `{ error }`), and embed NO
   approval check — the policy decides whether a mutating tool runs. Close
   over session-scoped data rather than using
   `ToolExecutionOptions.context`, which is not propagated (see
   `docs/sdk-upgrade.md`).
2. Add the factory to the mode branches it belongs in, in
   `src/agent/core/tools/v3/index.ts`.
3. If it never mutates anything, add its name to `READ_ONLY_TOOLS` in the
   same file so the policy auto-approves it. Otherwise the approval chain
   will ask — the right default.
4. Cap the output with `capToolOutput` and make the truncation marker
   instructive, so a cap is never a dead end.
5. Add an e2e test exercising it.

## The simple-core rule

`src/agent/core/engine.ts` is **mechanical execution only**. It must never
judge answer quality, retry on weak-looking output, or synthesize a second
answer. The full list of what the loop may and must not do lives in
`docs/SIMPLE_CORE_RESET_2026-08-24.md`. If you find yourself wanting to add
a "the answer looks wrong, let me try again" path, **stop** and re-read
that file. Almost always the fix is in the prompt, the router, or the
tool — not in the loop.

## Filing issues

- **Bug report:** include a transcript (TierMux → "Copy Handoff Note" or a
  screenshot of the composer), the model picker state, and any
  `TierMux Router` / `TierMux Diag` output-channel content with
  `tiermux.agent.scoringTrace` / `tiermux.agent.diagTrace` enabled.
- **Feature request:** start a discussion. TierMux has a strong opinion
  about what it is (router + free-tier fallback), and most "shouldn't it
  also do X" requests are honored by adjusting the router, not by adding
  new code.

## License

By contributing, you agree that your contributions are licensed under the
project's MIT license (see `LICENSE`). No CLA required.
