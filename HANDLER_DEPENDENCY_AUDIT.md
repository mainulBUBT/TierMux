# Handler Dependency Audit (Phase D2 → PR5 Gateway)

**Generated:** 2026-07-04  
**Purpose:** Verify readiness for PR5 (extract handlers to separate files)

---

## Executive Summary

### ✅ Good News

1. **No direct global access in handlers** - All handlers use `ctx.` prefix
2. **Dependencies are explicit** - Each handler declares what it needs
3. **Low coupling for simple handlers** - `handleTodos` (2 deps), `handleAssistantStart` (3 deps)

### ⚠️ Concerns

1. **HandlerContext is a God Object (14 members)** - *but acceptable as intermediate state*
   - **Bad God Object:** All handlers use all 14 members → interface churn, hard to evolve
   - **Acceptable God Object:** Large interface, but each handler only uses 2-4 members ✅ (current case)
   - 7 state maps (globals wrapped): targets, startTimes, statusTimers, userTargets, currentTurn, currentMode, viewedSessionId
   - 7 helper functions: ensureTarget, setStatusLabel, startStatusTimer, scrollDown, activityFor, upsertTool, renderTodos

2. **Not true dependency injection** - `createHandlerContext()` returns globals wrapped in an object:
   ```typescript
   function createHandlerContext(): HandlerContext {
     return {
       targets,        // ← global variable
       startTimes,     // ← global variable
       ensureTarget,   // ← global function
       // ... all globals wrapped
     };
   }
   ```

3. **Context exposes internal implementation details** - Handlers shouldn't need `statusTimers`, `startTimes`, `userTargets`
   - *Action:* Defer context split until after handlers extracted (PR5→PR6→PR7)
   - *Rationale:* Split now based on assumptions → wait for real usage patterns to emerge

---

## Dependency Table by Handler

| Handler | Dependencies (via ctx) | Reads | Writes | Total Dependencies | Extract Difficulty |
|---------|----------------------|-------|--------|-------------------|-------------------|
| **handleTodos** | ensureTarget, renderTodos | msg.todos, msg.followingPlan | DOM (t.body) | 2 | 🟢 Easy |
| **handleAssistantStart** | ensureTarget, setStatusLabel, startStatusTimer | msg.platform, msg.model | Target.model, Status label, Timer | 3 | 🟢 Easy |
| **handleAgentStep** | ensureTarget, setStatusLabel, startStatusTimer, scrollDown | msg.label | Status label, Timer, Scroll position | 4 | 🟢 Easy |
| **handleToolStatus** | ensureTarget, setStatusLabel, activityFor, upsertTool | msg.state, msg.name, msg.args, msg.toolCallId, t._wasStreamed, t.flow (DOM) | Target.activeTool, Target.currentText, Status label | 6 + Target lifecycle | 🟡 Medium (Target mutation) |

---

## Target Object Structure (Runtime)

Handlers receive a `Target` object from `ctx.ensureTarget()` with these properties:

```typescript
{
  // Core elements
  el: HTMLElement,              // .msg container
  body: HTMLElement,           // .bubble
  tools: HTMLElement,          // .flow (alias for backward compat)
  flow: HTMLElement,           // .flow (chronological activity feed)

  // Status display elements
  statusEl: HTMLElement,       // .agent-status
  statusLabel: HTMLElement,    // .agent-label
  statusCaret: HTMLElement,    // .agent-caret
  statusElapsed: HTMLElement,  // .agent-elapsed

  // State tracking
  currentText: string | null,  // Current streamed text segment
  toolRunning: boolean,        // Is a tool actively running?
  activeTool: string | null,   // Current tool's toolCallId
  _wasStreamed: boolean,       // Did we receive streamed text?
  startedAt: number,           // Epoch when timer started (for "Worked for Ns")

  // Metadata
  model: string,               // "platform/model" or ""
  requestId: string,           // Unique request ID

  // Failover/rotation state (optional)
  failoverCount?: number,
  failoverEl?: HTMLElement,
  keyRotEl?: HTMLElement,
  _typeTimer?: number,
  rotateWord?: string,
  nextRotateAt?: number,
  rotating?: boolean
}
```

**Analysis:** Handlers mutate Target properties directly (e.g., `t.activeTool = null`). This is acceptable because:
1. Target is a domain object, not a global
2. Handlers receive it via `ctx.ensureTarget()` (factory pattern)
3. The alternative (copy-on-write) would be prohibitively expensive

---

## Core Dependency Analysis

### ensureTarget() — The Rendering Root

**Usage across handlers:**
- ✅ handleAssistantStart (creates target for new assistant message)
- ✅ handleAgentStep (ensures target exists for status updates)
- ✅ handleToolStatus (manipulates target state during tool execution)
- ✅ handleTodos (renders todos into target body)

**Why it's critical:**
- Factory pattern for Target object creation (lazy initialization)
- Central entry point for all rendering operations
- Encapsulates DOM structure creation (el, flow, statusEl, bubble)
- Manages Target lifecycle in the global `targets` Map

**Implications for extraction:**
- All extracted handlers will need access to `ensureTarget` or a TargetManager abstraction
- Post-PR5, if `ensureTarget` proves too coupled, it becomes the next extraction target
- Current wrapping in HandlerContext is acceptable because every handler needs it

---

## Handler Code Analysis

### ✅ handleAssistantStart (Lines 2550-2560)
```typescript
function handleAssistantStart(ctx: HandlerContext, msg: AssistantStartMessage): void {
  const t = ctx.ensureTarget(msg.requestId, msg.platform, msg.model);
  if (msg.model) t.model = `${msg.platform || ''}/${msg.model}`;
  ctx.setStatusLabel(msg.requestId, 'Thinking…', { force: true });
  ctx.startStatusTimer(msg.requestId);
}
```
- **Dependencies:** 3 (ensureTarget, setStatusLabel, startStatusTimer)
- **Global access:** ❌ None
- **Extraction readiness:** ✅ Easy

---

### ✅ handleAgentStep (Lines 2562-2568)
```typescript
function handleAgentStep(ctx: HandlerContext, msg: AgentStepMessage): void {
  const t = ctx.ensureTarget(msg.requestId);
  if (msg.label) ctx.setStatusLabel(msg.requestId, msg.label, { force: true });
  ctx.startStatusTimer(msg.requestId);
  ctx.scrollDown();
}
```
- **Dependencies:** 4 (ensureTarget, setStatusLabel, startStatusTimer, scrollDown)
- **Global access:** ❌ None
- **Extraction readiness:** ✅ Easy

---

### ⚠️ handleToolStatus (Lines 2570-2588)
```typescript
function handleToolStatus(ctx: HandlerContext, msg: ToolStatusMessage): void {
  const t = ctx.ensureTarget(msg.requestId);
  if (msg.state === 'running') {
    t.activeTool = msg.toolCallId;
    ctx.setStatusLabel(msg.requestId, ctx.activityFor(msg.name, msg.args), { tool: true });
  } else if (msg.toolCallId && msg.toolCallId === t.activeTool) {
    t.activeTool = null;
    ctx.setStatusLabel(msg.requestId, t._wasStreamed ? 'Responding…' : 'Thinking…', { done: true });
  }
  const isNew = !t.flow.querySelector(`[data-tc="${msg.toolCallId}"]`);
  ctx.upsertTool(t, msg);
  if (isNew) t.currentText = null;
}
```
- **Dependencies:** 6 (ensureTarget, setStatusLabel, activityFor, upsertTool) + 3 Target props + 1 DOM query
- **Global access:** ❌ None
- **Extraction readiness:** ⚠️ Medium (Target lifecycle mutation)
- **Reads:** msg.state, msg.name, msg.args, msg.toolCallId, t._wasStreamed, t.flow (DOM query)
- **Writes:** t.activeTool, t.currentText, status label
- **Extraction blocker:** Not DOM coupling (`t.flow.querySelector` is Target invariant) → **Target lifecycle state mutations**
  - `t.activeTool` (tracks current running tool)
  - `t.currentText` (manages streaming text segments)
  - `t._wasStreamed` (distinguishes streamed vs. non-streamed responses)
- **Recommendation:** Defer extraction to PR6 after Target lifecycle is better encapsulated

---

### ✅ handleTodos (Lines 2590-2593)
```typescript
function handleTodos(ctx: HandlerContext, msg: TodosMessage): void {
  const t = ctx.ensureTarget(msg.requestId);
  ctx.renderTodos(t, msg.todos || [], !!msg.followingPlan);
}
```
- **Dependencies:** 2 (ensureTarget, renderTodos)
- **Global access:** ❌ None
- **Extraction readiness:** ✅ Easy

---

## Gate Check Results

### Question 1: Is createHandlerContext() doing true dependency injection?
**Answer:** ❌ No - it's wrapping globals

True dependency injection would be:
```typescript
// Hypothetical: interface-based DI
interface StatusDisplay {
  setLabel(id: string, text: string): void;
  startTimer(id: string): void;
}

function handleAssistantStart(
  statusDisplay: StatusDisplay,
  targetManager: TargetManager,
  msg: AssistantStartMessage
) { ... }
```

Current implementation:
```typescript
// Actual: globals wrapped in object
function handleAssistantStart(ctx: HandlerContext, msg: AssistantStartMessage) {
  ctx.ensureTarget(...)  // accesses global 'targets' map internally
}
```

### Question 2: Are handlers accessing globals directly?
**Answer:** ✅ No - all access goes through `ctx.`

### Question 3: Is HandlerContext becoming a God Object?
**Answer:** ⚠️ Yes - 14 members is excessive

**Recommendation:** Split into focused contexts for PR5–PR7:
- `StatusContext` (setStatusLabel, startStatusTimer)
- `RenderContext` (ensureTarget, scrollDown, upsertTool, renderTodos)
- `StateContext` (read-only targets, currentMode)

---

## PR5 Recommendation

### Strategy: Incremental Extraction (Phased)

**Phase 1 (PR5):** Extract isolated handlers first
- ✅ `handleTodos` → `handlers/todos.ts` (2 deps, fully isolated)
- ✅ `handleAssistantStart` → `handlers/assistantStart.ts` (3 deps, only touches Target.model)
- Commit after each handler (small, reviewable)

**Phase 1.5 (PR5.1 or same PR):** Extract status-related handler
- ✅ `handleAgentStep` → `handlers/agentStep.ts` (4 deps, shares status/timer concerns with assistantStart)
- Optionally keep in same PR if changes remain small (<200 lines total)

**Phase 2 (PR6):** Encapsulate Target lifecycle, then extract tool handler
- ⚠️ Refactor Target lifecycle state (activeTool, currentText, _wasStreamed) into Target methods
- ⚠️ Then extract `handleToolStatus` → `handlers/toolStatus.ts`

**Phase 3 (PR7):** Split HandlerContext based on real usage patterns
- Analyze which context members are actually used together across handlers
- Create focused interfaces: `StatusContext`, `RenderContext`, `StateContext`
- Update handlers to use specific contexts instead of monolithic `HandlerContext`
- *Rationale:* Split now based on assumptions → wait for real usage patterns to emerge

### Why This Order Works

| Handler | Isolation | Shared Concerns | Extraction Order |
|---------|-----------|----------------|------------------|
| handleTodos | ✅ Perfect (2 deps, render-only) | None | 1st |
| handleAssistantStart | ✅ Good (3 deps, Target.model only) | Status/timer with agentStep | 2nd |
| handleAgentStep | ✅ Good (4 deps, no Target mutation) | Status/timer with assistantStart | 3rd |
| handleToolStatus | ⚠️ Complex (Target lifecycle) | Shares ensureTarget with all | Last (PR6) |

**Benefits of this approach:**
1. ✅ Each commit/PR is small and reviewable
2. ✅ Isolated handlers extracted first (quick wins, low risk)
3. ✅ Handlers sharing concerns extracted together (status/timer pair)
4. ✅ Complex handler deferred until Target lifecycle is clearer
5. ✅ Context split delayed until real usage patterns emerge

---

## Metrics

### Architectural Progress (Phase D focus)

| Metric | Current | After PR5 | After PR6 | Target |
|--------|---------|-----------|-----------|--------|
| **main.ts lines** | 3435 | ~3235 | ~3050 | ~2500 |
| **Handlers in main.ts** | 4 | 1 | 0 | 0 |
| **Handler files extracted** | 0 | 2–3 | 4 | 8+ |
| **HandlerContext members** | 14 | 14 | 14 | 3–5 (split in PR7) |
| **Direct global access in handlers** | 0 | 0 | 0 | 0 |
| **Target lifecycle mutations in handlers** | 1 (toolStatus) | 1 (toolStatus stays) | 0 (encapsulated) | 0 |
| **DOM queries in handler bodies** | 1 (toolStatus) | 1 (toolStatus stays) | 0 (moved to helper) | 0 |

### Extraction Complexity by Handler

| Handler | Dependencies | Target Mutations | Extraction Order | Risk Level |
|---------|-------------|------------------|------------------|------------|
| handleTodos | 2 | 0 | 1st | 🟢 Low |
| handleAssistantStart | 3 | 1 (model only) | 2nd | 🟢 Low |
| handleAgentStep | 4 | 0 | 3rd | 🟢 Low |
| handleToolStatus | 6 | 3 (activeTool, currentText, _wasStreamed) | 4th (PR6) | 🟡 Medium |

---

## Conclusion

**Ready for PR5?** ✅ **YES**, with the refined scoped approach below.

### Approved PR5 Scope

**Extract in this order:**
1. ✅ `handleTodos` → `handlers/todos.ts` (2 deps, perfect isolation)
2. ✅ `handleAssistantStart` → `handlers/assistantStart.ts` (3 deps, minimal Target mutation)
3. ✅ `handleAgentStep` → `handlers/agentStep.ts` (4 deps, optionally separate commit)

**Defer to PR6:**
- ⏸️ `handleToolStatus` → Target lifecycle needs encapsulation first

**Defer to PR7:**
- ⏸️ HandlerContext split → wait for real usage patterns to emerge

### Why This Is Safe

1. **No direct global access** ✅ - All handlers use `ctx.` prefix
2. **Incremental commits** ✅ - Each handler extracted and committed separately
3. **Low-risk handlers first** ✅ - Todos and assistantStart are isolated (2–3 deps)
4. **Complex handler deferred** ✅ - ToolStatus stays in main.ts until Target lifecycle clearer
5. **No premature abstraction** ✅ - Context split delayed until usage patterns emerge

### What Improves

**After PR5:**
- ✅ 2–3 handlers in separate files (reduces main.ts by ~200 lines)
- ✅ Extraction pattern validated for remaining handlers
- ✅ Zero increase in direct global access or coupling

**After PR6:**
- ✅ All handlers extracted (main.ts focused on routing)
- ✅ Target lifecycle better encapsulated

**After PR7:**
- ✅ HandlerContext split into focused interfaces based on actual usage
- ✅ Foundation for further extraction (approval handlers, plan handlers, etc.)

### Phase D Principles Maintained

- ✅ **Small, reviewable PRs** - Each handler is a separate commit
- ✅ **Buildable at every step** - No broken intermediate states
- ✅ **Evidence-based evolution** - Context split deferred until real patterns emerge
- ✅ **Minimal churn** - No interfaces created prematurely and then discarded
