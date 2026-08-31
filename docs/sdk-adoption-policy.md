# AI SDK adoption policy

What TierMux takes from the AI SDK (`ai`, `@ai-sdk/provider`) — and, more importantly, what it
deliberately does not. This is the policy layer; the per-version bump checklist lives in
[`sdk-upgrade.md`](./sdk-upgrade.md). When the two disagree on a specific version detail, that
file wins; when a new SDK feature shows up, this file decides whether it is even a candidate.

## The rule

TierMux takes an SDK feature only when all three hold:

1. **Stable** — no `experimental_*` prefix, no "may change" note in the changelog entry.
2. **Engine work, not policy work** — it must be message/stream/loop mechanics (conversion,
   pruning, error shapes, finish reasons), not routing, provider selection, permissions, or
   resilience. Those are TierMux's own layers (`Router`, `policies/permission.ts`, failover) and
   stay hand-written on purpose.
3. **Replaces hand-written code** — it removes an existing workaround or mapping in `src/`, not
   adds a parallel path next to it.

The strategic reason for the narrow surface: the SDK majors fast (spec `V4` vs package `v7` —
major breaking releases roughly twice a year), and TierMux only stays cheap to upgrade because
the SDK is held at a thin interface (`doGenerate`/`doStream` + `streamText` options). Every
adopted API is future breakage surface; adopt only when it pays for that.

## Adopted (verified against `src/` on 2026-08-30)

| API | Where |
|---|---|
| `streamText` | agent loop, streaming (`core/engine.ts`) |
| `generateText` | one-shot utility calls (`agent/planStructurer.ts`, `core/tools/workspaceRoot.ts`) |
| `tool` + `ToolSet` | all tool definitions (`core/tools/`) |
| `jsonSchema` | MCP tool bridging (`core/tools/mcp/mcp.ts`) |
| `pruneMessages` | transcript compaction (`core/compact.ts`) |
| `prepareStep` (`messages`) | compaction hook (`core/engine.ts`) |
| `repairToolCall` option | tool-call self-healing hook (`core/engine.ts`) |
| `toolApproval` | permission gate (`core/engine.ts`) |
| `isStepCount`, `hasToolCall`, `NoSuchToolError`, `InvalidToolInputError` | loop control, error handling |
| `prepareStep` (`toolChoice`) | forcing `exitPlanMode` on the plan-gap continuation (`core/engine.ts`) |
| `LanguageModelV4` spec types | the router-as-model adapter (`core/routerProvider.ts`) |

### Listed as adopted before 2026-08-30, and NOT actually present

The v3 rewrite retired `core/loop.ts` for `core/engine.ts` and this table was not re-checked,
so it kept asserting three APIs the code no longer imported. That is worse than a stale doc:
rule 3 below is evaluated AGAINST this table, so a hand-written replacement for a
"already-adopted" API reads as compliant when it is really a regression. `pruneMessages` was
the live case — `core/compact.ts` had grown a hand-rolled pass that stubbed every tool result
in the older half of the transcript, while the SDK function it was supposed to be using
appeared in zero files. It is restored above.

| API | Doc claimed | Reality on 2026-08-30 | Status |
|---|---|---|---|
| `pruneMessages` | `core/loop.ts` | 0 files — hand-rolled stubbing in `core/compact.ts` | **restored** |
| `wrapLanguageModel` | `core/middleware/telemetry.ts` | 0 files; that directory does not exist | still absent — a candidate, not adopted |
| `Output` | structured output | never imported from `ai` | still absent — a candidate, not adopted |

**When this table changes, re-verify it.** `grep -rn "from 'ai'" src/` is the whole check.

## Candidate list (checked 2026-08-24 against `ai@7.0.58` / `@ai-sdk/provider@4.0.3`)

- **`convertToModelMessages` / UI↔Core message utilities** — ✗ does not apply. Its input is
  `UIMessage[]` (a web-frontend persistence shape); TierMux persists its own OpenAI-wire
  `ChatMessage` and maps it in `loop.ts`'s `toCoreMessages`. The orphaned-tool-call repair
  (`sanitizeCoreMessages`) has no SDK equivalent to delegate to. Re-check only if TierMux ever
  adopts `UIMessage` as its persisted shape (it shouldn't — that shape exists for `useChat`).
- **Stable stream-part / finish-reason helpers** — ✓ resolved differently and better: instead of
  new SDK helpers, the whole boundary was made cast-free. `CoreMessage` in `loop.ts` is now an
  alias of the SDK's `ModelMessage`; `permission.ts` imports the SDK's `ToolApprovalStatus`
  instead of mirroring it; `routerProvider.ts` builds fully-typed `LanguageModelV4Usage`
  objects. All `as any` / `as unknown as` casts at `streamText`/`generateText` call sites
  (loop.ts, delegate.ts, routerProvider.ts) are gone, and the dead `part.delta`/`errorText`
  fallbacks (shapes that no longer exist in `ai@7.0.58`) were removed. The compiler now catches
  SDK shape drift at the boundary — which was the whole point.
- **Stable tool-execution options (e.g. concurrency control)** — ✗ no such option exists in
  `ai@7.0.58`, and `core/stepEngine.ts` holds no concurrency logic to replace (it is pure
  round/continuation decision logic). Nothing to do; re-scan on the next major.

## Permanently banned

- **`Agent` class / agent abstractions** — assume one smart model and server-side control of
  routing; both are false in TierMux's free-tier multiplexer.
- **Anything `experimental_*`, incl. code mode** — weak free models can't reliably author the
  inputs these demand, and code mode bypasses the per-call permission gates.
- **Workflow SDK** — durability across processes TierMux doesn't have; the live `Router` closure
  can't be serialized, by design. Turn-resume, if ever wanted, is a small local
  persist-the-transcript change, not a framework.
- **Harnesses / adapter bridges (`@ai-sdk/langchain`, codex-cli provider, …)** — TierMux *is* the
  agent runtime and the provider; wrapping someone else's would invert the architecture.
- **AI SDK UI** — TierMux's chat is a VS Code webview with its own message protocol; there is no
  HTTP endpoint for `useChat`-style hooks to talk to.
- **`embedMany`/embeddings, image, speech** — no product feature consumes them. (Semantic search
  has a separate trigger-gated plan; do not adopt via this policy.)

## Upgrade routine (every major SDK release)

1. Branch, bump `ai` + `@ai-sdk/provider`, compile, run the test suite — the narrow interface is
   what keeps this cheap.
2. Walk [`sdk-upgrade.md`](./sdk-upgrade.md) top to bottom (it tracks concrete bug workarounds
   that may now be removable).
3. Scan the changelog against the candidate list above; adopt anything that flipped stable, via
   the "replace, don't add" rule.
4. Update the pinned-versions line in `sdk-upgrade.md` and the tables here if the set changed.

## Considered and NOT adopted (2026-08-31)

| API | Why not |
|---|---|
| `addToolInputExamplesMiddleware` + `wrapLanguageModel` | Rule 3. It would add a middleware layer around `core/routerProvider.ts` rather than replace anything, and the field it serializes (`inputExamples`) is dropped by that adapter's own tool mapping anyway. The one place a worked example was worth having — `exitPlanMode` — carries it inline in the tool description instead. |
| `detectToolDrift` / `fingerprintTools` | Solves MCP tool-definition "rug pull", not tool-call reliability. No live problem to point at. |
| XML/text tool protocol as a fallback for weak models | Rule 2 (that is provider/reliability work, TierMux's own layer) — and the evidence is against it: Roo Code migrated OFF XML after measuring ~10% tool-call failure on top-tier models, >15% on `apply_diff`, degrading through multi-turn. `toolChoice` forcing gets the same reliability win at the wire level without a second parser. |
