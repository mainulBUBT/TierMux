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

## Adopted (the current set — near-complete, no additions pending)

| API | Where |
|---|---|
| `streamText` | agent loop, streaming (`core/loop.ts`) |
| `generateText` | one-shot utility calls (title, condense, clarify) |
| `tool` + `jsonSchema` + `ToolSet` | all tool definitions (`core/tools/`) |
| `Output` | structured output |
| `pruneMessages` | history pruning (`core/loop.ts`) |
| `repairToolCall` option | tool-call self-healing hook (`core/loop.ts`) |
| `wrapLanguageModel` | telemetry middleware (`core/middleware/telemetry.ts`) |
| `isStepCount`, `NoSuchToolError`, `InvalidToolInputError` | loop control, error handling |
| `LanguageModelV4` spec types | the router-as-model adapter (`core/routerProvider.ts`) |

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
