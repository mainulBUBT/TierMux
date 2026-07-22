# AI SDK upgrade checklist

TierMux's agent core (`src/agent/core/`) is built directly on the AI SDK (`ai`, `@ai-sdk/provider`)
— see the "Architecture Principles" in the agent core's design: prefer extension over
replacement, and remove a custom workaround the moment the SDK grows a native equivalent. This
list is what to re-check every time that dependency is bumped, so those workarounds don't outlive
the bug they exist for.

Current pinned versions: `ai@^7.0.34`, `@ai-sdk/provider@^4.0.3`, `zod@^4.4.3`.

## 1. Is the `runtimeContext`/`toolsContext` bug fixed?

Documented in [`tools/index.ts`](../src/agent/core/tools/index.ts): as of `ai@7.0.34`,
`runtimeContext`/`toolsContext` do not populate a tool's `execute()` via
`ToolExecutionOptions.context`, contradicting the SDK's own docs. Verified empirically (a real
`streamText()` spike against a fake `LanguageModelV4`) — `options.context` came back `undefined`
both with no `contextSchema` declared, and with a declared `contextSchema` + matching
`toolsContext` (which instead threw a Zod validation error against `undefined`).

- [ ] Re-run that spike against the new version. Does `options.context` now carry the value
      passed via `runtimeContext`/`toolsContext`?
- [ ] If fixed: tools can move from the closure/factory pattern (`create*Tool(session)` capturing
      `onTodos`/`onAskUser`/session id) to static, module-level `tool()` objects reading from
      `context`. This is a real simplification, not just cosmetic — do it if the bug is gone.
- [ ] If still broken: leave the closures in place, update the comment's version number, move on.

## 2. Are closures still required to pass session data into tools?

Direct consequence of #1. If `runtimeContext` now works, decide whether the migration to
`context`-based tools is worth doing immediately or worth deferring — either way, don't leave the
code half-migrated (some tools on closures, some on context) without a comment explaining why.

## 3. Has `Experimental_Agent` (`ToolLoopAgent`) stabilized?

`loop.ts` deliberately uses `streamText` + `tool()` + `isStepCount` + `toolApproval` directly
instead of the `Experimental_`-prefixed agent class, because that class's API wasn't stable at
the time this was built.

- [ ] Check whether the `Experimental_` prefix has been dropped from `Experimental_Agent`/
      `ToolLoopAgent` in the new version's exports.
- [ ] If stabilized: this is a candidate for adoption, but only if it doesn't reintroduce a wrapper
      layer around `streamText()` — the explicit constraint on this codebase is that `runTurn()`
      stays a thin, direct call into the SDK's own execution primitive, not a
      `TierMuxAgentRunner`/`ExecutionManager`/`LoopManager` class forwarding most of the SDK's API.
      Only adopt it if it's a genuine reduction in custom code, not a lateral move.

## 4. Has `toolApproval` changed shape?

`core/policies/permission.ts`'s `createToolApproval()` returns a `GenericToolApprovalFunction`
matching the `ai@7.0.34` shape (`{ toolCall } => 'approved' | 'denied' | {type, reason} | ...`).

- [ ] Check the new version's type for `toolApproval` (in `streamText`/`generateText`'s options).
      Did the callback signature, the returned status shape, or the per-tool-name-map form change?
- [ ] Re-verify the core guarantee this whole mechanism exists for: a denied verdict means the
      tool's `execute()` never runs at all (not just that its effect is discarded afterward) — see
      the "denied toolApproval" test in `scripts/coreLoop.e2e.ts`.
- [ ] Confirm the deprecated per-tool `needsApproval` field hasn't become the only supported path
      again (unlikely, but the deprecation notice referenced a "generateText/streamText level"
      replacement — make sure that's still `toolApproval`).

## 5. Have the lifecycle callbacks changed?

`loop.ts` consumes `result.fullStream` directly (text-delta/reasoning-delta/tool-call/
tool-result/tool-error/error parts) rather than the `onStepStart`/`onToolExecutionStart`/
`onToolExecutionEnd`/`onError` callback options.

- [ ] Check the new version's `fullStream` part-type union — did any part type get renamed, split,
      or gain new required fields?
- [ ] Re-verify the ordering guarantee `chatViewProvider.ts`'s checkpoint recorder depends on:
      `onTool` state `'running'` must fire before that tool's own `execute()` mutates anything —
      see the "ordering" test in `scripts/coreLoop.e2e.ts`.

## 6. Has the middleware signature changed?

`createTelemetryMiddleware()` (`core/middleware/telemetry.ts`) implements
`LanguageModelV4Middleware`'s `wrapGenerate`/`wrapStream` hooks via `wrapLanguageModel()`.

- [ ] Check whether `LanguageModelV4Middleware`'s shape, or `wrapLanguageModel()`'s signature,
      changed in the new `@ai-sdk/provider` version.
- [ ] `createTelemetryMiddleware()` takes an options object (`{ profiler, traceId, logger? }`) —
      if a second concern (structured logging, tracing) becomes real, extend that object rather
      than adding a second middleware factory with an overlapping purpose.

## 7. Remove obsolete workarounds

Once the above are checked, remove anything this document (or `tools/index.ts`'s inline comment)
flagged as "workaround for a bug in `ai@7.0.34`" that no longer applies — don't leave dead
workaround code once the SDK grows the native equivalent it was standing in for. Update this
file's "Current pinned versions" line and re-check off the items above that changed.
