# Plan: In-chat Ask / Plan / Implement loop (Kilo/opencode/Cline parity)

## Goal
Make the **full Ask → Plan → Implement** loop in TierMux feel like Kilo, opencode, and Cline: clarifying questions are asked as **in-chat cards** (never native VS Code popups), a **plan** is shown for approval, and **implementation** runs smoothly on approval without re-asking what was already answered. This single plan covers the complete, smooth flow rather than just one piece of it.

## Current state (what's already in place)

| Piece | Where | Status |
|---|---|---|
| Plan mode numbered plan + Approve/Discard card | `media/main.js:1393` (`planProposed` case) | done |
| Multi-question clarifying card (tabbed, Next/Back) from `???QUESTIONS???` block | `media/main.js:1409` (`clarifyingQuestions` case) | done |
| Parser for `???QUESTIONS???…???END???` block | `src/agent/clarify.ts` | done |
| Re-run Plan with answers, then propose plan | `src/chatViewProvider.ts:1282` (`handleAnswerClarifying`) | done |
| Seed live todo checklist from approved plan | `src/chatViewProvider.ts:1064` (`pendingPlanUser`) | done |
| `askUser` tool spec (in Plan's read-only set) | `src/agent/toolSpecs.ts:216`, `src/agent/agent.ts:33-36` | done |
| `askUser` tool runtime (uses **native** prompts) | `src/chatViewProvider.ts:1183,1193` (`requestUserInput`) | **gap** |
| `Approve & Run` reuses the user turn and continues in **Agent** mode | `src/chatViewProvider.ts:1045` (`handleApprovePlan`) | done (basic) |
| `Continue` resume after paused / dropped-out run | `src/chatViewProvider.ts:1230` (`handleResume`) | done |

The two rough edges that make the loop feel non-smooth:

1. **Native prompts** for `askUser` break the in-chat feel and aren't recorded as a turn in the transcript (the user sees a popup, then the assistant turn — the question itself disappears from history).
2. **Plan → Agent handoff** runs the approved plan, but the live todo list is rebuilt from scratch by the agent's `updateTodos` calls — the original numbered plan steps aren't visibly linked to the running checklist, so the user can't easily see "step 3 of the plan is now in progress".

## Approach

Five small changes, all in the existing card / pending-promise pattern, no new infrastructure.

### 1. In-chat `askUser` card (the core fix) — **Plan + Agent modes only**

Reuse the existing clarifying-questions card machinery for the agent's `askUser` tool, with a free-text fallback.

**Scope:** this in-chat path is enabled for **Plan** and **Agent** modes only. **Debug** and **Orchestrator** keep the existing native `showQuickPick` / `showInputBox` path (via `requestUserInput`) — those modes don't have the plan-gate UX, and routing their questions through the webview isn't on the critical path for the Ask → Plan → Implement loop. (Cheap to extend later if you want.)

**`src/messages.ts`** — add two types:

```ts
// extension → webview
| { type: 'askUserPrompt'; sessionId: string; requestId: string;
    callId: string; question: string; options?: string[] }
// webview → extension
| { type: 'askUserResponse'; requestId: string; callId: string; answer: string; cancelled?: boolean }
```

**`src/chatViewProvider.ts`** — new `pendingAskUser: Map<string /* callId */, (answer: string) => void>` on `Session` (mirror of `pendingApprovals`).

New method `requestAskUser(callId, question, options?)`:
- Posts `askUserPrompt` via `postCard` (auto-cached + cleared with existing card lifecycle).
- Returns a `Promise<string>` resolved by the matching `askUserResponse`.

In `agentCallbacks`, change `onAskUser` from `requestUserInput` to `requestAskUser` **only when the active mode is `plan` or `agent`**. For `debug` and `orchestrator`, keep `requestUserInput`. The mode is already available on the session (`s.lastMode` or the `RunOpts` passed into the run) — read it from the `RunOpts` that's in scope at the call site. The `askUser` tool impl in `src/agent/agent.ts:202` is unchanged — it still just awaits `cb.onAskUser(question, options)`.

New inbound `case 'askUserResponse'`: resolve the pending promise; on `cancelled`, resolve with `''` (the model already handles that gracefully).

**`media/main.js`** — new `case 'askUserPrompt'`:
- Reuse the `.clarify` card styling (no new CSS unless the free-text variant needs it).
- **Single-question flow**: no tabs / Back / counter — `askUser` is always 1 question per tool call.
- **Options** (≥2) → render option buttons (same as Plan's clarifying card).
- **No options** → render a single `<textarea>` Submit.
- On submit: post `askUserResponse`. On card removal (new send / mode change / cancel): post `askUserResponse` with `cancelled: true`.

### 2. Lifecycle: drain `pendingAskUser` on every exit

Mirror the existing `settlePendingApprovals(s, false)` pattern at `src/chatViewProvider.ts:365`. In:
- `handleSend` (when starting a new run)
- `handleCancel`
- `handleSwitchSession`
- the `finally` block of every run

resolve any unresolved `pendingAskUser` entries with `''`. Without this, a Stop click while a card is open would hang the agent loop.

### 3. Plan → Agent handoff polish

Currently `handleApprovePlan` re-uses the original user turn and just calls `agent.run(history, 'agent', …)`. Two small upgrades:

**a) Visible "executing plan" status** — while the approved plan runs, post a status line `"▶ Executing approved plan (N steps)"` so the user sees that this isn't a fresh plan but the implementation of the one they just approved. Reuse the existing `agentStep` message.

**b) Link live todos to plan steps** — `handleApprovePlan` already seeds the todo list from the plan (`src/chatViewProvider.ts:1064`). When the agent subsequently calls `updateTodos`, the `onTodos` callback (`media/main.js` `todos` case) should:
- Keep the **first todo item** that matches the current plan step pinned at the top with a small `plan-step-N` badge, OR
- Simpler: prepend a non-interactive header `"Following the approved plan"` above the live todo list while the run is in execute-plan mode.

A `pendingPlanUser` flag already exists on `Session` (set in `handleSend` when mode is `plan`, used in `handleApprovePlan` to re-add the user turn). Extend it: while the approved plan is executing, set `s.executingPlan = true`; clear it when the run ends. The webview uses this to render the header.

### 4. Reject path records what was discarded

Currently `handleApprovePlan` with `approved: false` just removes the card. To match Kilo/opencode/cline (where a rejected plan is still visible in history as a discarded plan), the `planProposed` card should stay in the transcript with a "✗ Discarded" note after the user clicks **Discard**. Implementation: instead of removing the card on reject, replace its action buttons with a `✗ Discarded` label (mirror the existing `commandApproval` reject path at `media/main.js:1380`).

### 5. Auto-promote to Plan in Agent/Ask when ambiguous (small)

Optional but high-value: if the user is in **Agent** or **Ask** mode and the agent's `askUser` tool fires, the answer is recorded as a normal turn. The user can then click **Edit files** on the now-shown plan only if Plan mode was used. To keep this in scope, **skip the auto-promote** for this PR — it would be a behavior change to mode routing (`src/agent/routing.ts`) that's better as a separate ask. Keep the ask → plan → implement flow manual (the user picks Plan mode when they want approval gating).

## Files to change

| File | Change |
|---|---|
| `src/messages.ts` | Add `askUserPrompt` (out) and `askUserResponse` (in) types. |
| `src/chatViewProvider.ts` | `pendingAskUser` map; `requestAskUser` method; new inbound `case 'askUserResponse'`; wire `onAskUser` in `agentCallbacks` **gated on mode ∈ {plan, agent}** (Debug/Orchestrator keep native `requestUserInput`); drain `pendingAskUser` on send / cancel / switch / run-finally (mirror `settlePendingApprovals`). `handleApprovePlan`: post an "Executing approved plan" status step; set/clear `s.executingPlan`. |
| `media/main.js` | New `case 'askUserPrompt'` (reuse `.clarify` styles; single-question; free-text fallback). `todos` case: render "Following the approved plan" header when `s.executingPlan` is true. `planProposed` case: on reject, keep card with "✗ Discarded" label. |
| `media/main.css` | Only if `.clarify-opts` doesn't cover the free-text `<textarea>` — add a tiny `.ask-input` rule. |

No changes to:
- `src/agent/agent.ts` (the `askUser` tool's runtime contract is unchanged)
- `src/agent/toolSpecs.ts` (spec stays the same)
- `src/agent/clarify.ts` (Plan-mode `???QUESTIONS???` block parsing stays the same)
- `src/agent/prompts.ts` (existing Plan/Agent prompts already say "call askUser when ambiguous")
- `src/agent/routing.ts` (mode auto-promote is explicitly out of scope)

## Why this matches Kilo / opencode / Cline end-to-end

- **In-chat Ask, never native popups** — Kilo/opencode/cline all show questions inline; the user never leaves the chat thread.
- **Persistent in history** — the `tool_calls` / `tool` exchange already records Q + A, so resuming a chat shows past questions, just like Kilo.
- **Plan → Execute, visibly linked** — opencode and Cline show a "following approved plan" affordance during execution; the live todos are visibly the plan steps.
- **Discarded plans stay visible** — Kilo and Cline show the rejected plan in the transcript so the user remembers what was proposed.
- **Smooth resume after pause** — already works (`handleResume`); the new pieces don't add any new failure modes.

## Validation

1. `npm run typecheck` — must pass.
2. Manual in the Extension Development Host:
   - **Plan + askUser**: set Mode = **Plan**, send "refactor the auth module". If the planner calls `askUser` (e.g. "session-based or JWT?"), the question appears as an in-chat card. Click an option (or type a free-text answer) → answer is recorded in the transcript → plan is proposed.
   - **Agent + askUser**: set Mode = **Agent**, send a task that the model decides to clarify. The `askUser` tool call surfaces inline; submitting resumes the agent.
   - **Free-text path**: send a Plan-mode task where the model calls `askUser` with no `options`. Card shows a text input.
   - **Debug/Orchestrator unchanged**: set Mode = **Debug** (or Orchestrator), trigger a clarifying question → still uses the native VS Code quickPick/inputBox. Confirms the gate.
   - **Cancel**: click **Stop** while a card is open. Agent loop unblocks, no hang, card disappears.
   - **Plan approve + execute**: approve a plan → see "▶ Executing approved plan (N steps)" → live todos appear under a "Following the approved plan" header → run completes without re-asking any of the clarifying questions.
   - **Plan reject**: click **Discard** → plan stays in the transcript with a "✗ Discarded" note (not deleted).
3. Regression: Plan mode's `???QUESTIONS???` block (multi-question tabbed card) still works for models that emit it; `Continue` after a paused run still works.

## Out of scope (intentionally, future asks)

- **Auto-promote Agent/Ask → Plan** when the planner wants a plan-gate. Routing change in `routing.ts`, separate ask.
- **Ask-mode UI polish** (a distinct banner / color so users can see at a glance "I'm in read-only Ask"). Cosmetic, separate ask.
- **Plan file persistence** — `tiermux.plan.saveToFile` setting already exists; the webview already has a copy-link for the plan. The plan card stays in the transcript either way; no change needed.
