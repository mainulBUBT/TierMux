# PR5.1 Extraction Checklist - handleAssistantStart

**📋 See [PHASE_D2_COMPLETE_FRAMEWORK.md](PHASE_D2_COMPLETE_FRAMEWORK.md) for complete context and all 12 disciplines.**

**This checklist:** Working executable for PR5.1 (gate tests + budget checks + verification steps).

## Pre-Extraction Setup

1. **Review handler dependencies** (from HANDLER_DEPENDENCY_AUDIT.md)
   - handleAssistantStart dependencies: ensureTarget, setStatusLabel, startStatusTimer (3 total)
   - Target mutations: t.model only (minimal)
   - Extraction difficulty: 🟢 Easy

2. **Create new handler file**
   ```bash
   touch media/src/handlers/assistantStart.ts
   ```

## Extraction Steps

### Step 1: Define Types in Handler File

Copy/create these interfaces in `handlers/assistantStart.ts`:

```typescript
export interface AssistantStartMessage {
  type: 'assistantStart';
  requestId: string;
  platform?: string;
  model?: string;
}

export interface Target {
  el: HTMLElement;
  body: HTMLElement;
  model: string;
  // Other properties as needed
}

export interface AssistantStartContext {
  ensureTarget(requestId: string, platform?: string, model?: string): Target;
  setStatusLabel(requestId: string, text: string, opts?: {...}): boolean;
  startStatusTimer(requestId: string): void;
}
```

### Step 2: Extract Handler Function

```typescript
export function handleAssistantStart(ctx: AssistantStartContext, msg: AssistantStartMessage): void {
  const t = ctx.ensureTarget(msg.requestId, msg.platform, msg.model);
  if (msg.model) t.model = `${msg.platform || ''}/${msg.model}`;
  ctx.setStatusLabel(msg.requestId, 'Thinking…', { force: true });
  ctx.startStatusTimer(msg.requestId);
}
```

### Step 3: Update main.ts

```typescript
// At top with other imports
import { handleAssistantStart } from './handlers/assistantStart';

// In message handler switch statement
case 'assistantStart': {
  const ctx = createHandlerContext();
  handleAssistantStart(ctx, msg);
  break;
}
```

### Step 4: Remove Old Implementation

```bash
# Verify old implementation exists
grep -n "function handleAssistantStart" media/src/main.ts

# Remove the old function definition from main.ts
# (lines around 2550-2560 based on audit)
```

## Post-Extraction Verification (MUST DO ALL 5)

### ✅ Check 1: Dependency Direction
```bash
grep "import.*from.*main" media/src/handlers/assistantStart.ts
# Expected: (no matches)
```

### ✅ Check 2: Type Strategy
- Target interface in assistantStart.ts should be minimal subset
- Only properties actually used: el, body, model
- If subset grows beyond 5-6 properties, consider shared types

### ✅ Check 3: Capability-Based Context
```typescript
// ✅ GOOD - capabilities only
interface AssistantStartContext {
  ensureTarget(...): Target;
  setStatusLabel(...): boolean;
  startStatusTimer(...): void;
}

// ❌ BAD - state maps
interface AssistantStartContext {
  targets: Map<string, Target>;
  statusTimers: Map<string, number>;
  setStatusLabel(...);
}
```

### ✅ Check 4: Remove Old Implementation
```bash
# After removal, verify no matches
grep -n "function handleAssistantStart" media/src/main.ts
# Expected: (no matches)

# Verify import exists
grep "from './handlers/assistantStart'" media/src/main.ts
# Expected: import { handleAssistantStart } from './handlers/assistantStart';
```

### ✅ Check 5: Build Verification
```bash
npm run build
# Expected: Build green, no errors
```

## Metrics Tracking

Before PR5.1:
```
main.ts: 3431 lines
handlers/: 1 file (todos.ts)
```

After PR5.1 (expected):
```
main.ts: ~3427 lines (-4)
handlers/: 2 files (todos.ts, assistantStart.ts)
```

## Commit Message (Template)

```
refactor(webview): extract assistantStart handler (Phase D2 PR5.1)

- Extract handleAssistantStart to handlers/assistantStart.ts
- Introduce focused AssistantStartContext interface
- Remove inline handler from main.ts
- Preserve runtime behavior

Phase D2: incremental handler extraction using capability-based contexts
```

## Comparison with Previous Contexts

After extraction, compare:

```typescript
// From PR5.0
TodosContext {
  ensureTarget
  renderTodos
}

// From PR5.1
AssistantStartContext {
  ensureTarget      ← Shared!
  setStatusLabel
  startStatusTimer
}
```

**Observation:** `ensureTarget` is common to both. This will inform PR7's context split.

## Success Criteria

### Scope
- [ ] Only handleAssistantStart extracted
- [ ] New handlers/assistantStart.ts created
- [ ] AssistantStartContext has ONLY: ensureTarget, setStatusLabel, startStatusTimer
- [ ] Context Growth Guard: Max 3 members (if 4th needed, justify or split)

### Architecture
- [ ] assistantStart.ts does NOT import main.ts
- [ ] assistantStart.ts imports only stable modules
- [ ] No new reverse dependency created
- [ ] HandlerContext is NOT exported
- [ ] Capability-based interface maintained
- [ ] Runtime behavior preserved
- [ ] Public API Freeze: Only `handleAssistantStart` exported (helpers/types internal)

### Verification
- [ ] Old handleAssistantStart implementation removed (verified with grep)
- [ ] Build green (respects Phase D baseline: @ts-nocheck unchanged)
- [ ] Typecheck passes (current Phase D baseline)
- [ ] No circular dependencies
- [ ] No new type suppressions (@ts-ignore/@ts-expect-error)
- [ ] Runtime regression smoke test pass (see checklist below)

### Metrics (Primary: Architectural)
- [ ] Handlers extracted count increased (+1)
- [ ] Capability contexts created (+1)
- [ ] main.ts responsibilities reduced

### Metrics (Secondary: Lines)
- [ ] main.ts line count decreased
- [ ] No unnecessary module proliferation

---

## PR Stop Rule ⚠️

**STOP and open new decomposition PR if extraction requires:**
- Exporting HandlerContext
- Importing main.ts from handler
- Adding @ts-ignore/@ts-expect-error
- Changing runtime behavior
- Context growing beyond 3 members without justification

**Why:** Prevents scope creep, keeps each PR focused and mechanical.

---

## Runtime Regression Smoke Test

**Run after each extraction (~1 minute):**

Assistant Start Flow:
- [ ] User sends message
- [ ] Assistant starts (new message bubble appears)
- [ ] "Thinking…" status label appears
- [ ] Timer starts counting
- [ ] First token streams correctly
- [ ] Message finishes properly

**If any fail:** Revert immediately, investigate, retry extraction.

---

## PR5.1 Gate (7 Questions - All Must be YES)

Before merging PR5.1, verify all 7 gates pass:

1. ✅ Only handleAssistantStart moved?
2. ✅ Context has exactly 3 capabilities?
3. ✅ No import from main.ts?
4. ✅ Old implementation deleted?
5. ✅ Build baseline passes?
6. ✅ No new suppressions?
7. ✅ Runtime smoke test passes?

**If all YES → Merge ready. If any NO → Fix and re-verify.**

---

## Dependency Budget (NEW DISCIPLINE)

Each extracted handler must stay within these limits:

**Budget Limits:**
- Context capabilities: ≤ 3 (soft limit: 4 with justification)
- Public exports: exactly 1 (the handler function)
- Imports: ≤ 5 modules
- Global variable access: 0 (all via context)
- Direct DOM queries: 0 where practical (justify if required)

**Check:**
```bash
# Count capabilities
grep "interface AssistantStartContext" -A 10 handlers/assistantStart.ts | grep -E "^\s+\w+\(" | wc -l
# Expected: 3

# Count imports  
grep "^import" handlers/assistantStart.ts | wc -l
# Expected: ≤ 5

# Count public exports
grep "^export" handlers/assistantStart.ts | wc -l
# Expected: 1
```

**If exceeded:** Stop and justify OR decompose further

---

## Independence Gate (NEW DISCIPLINE)

Verify handler is truly independent from main.ts implementation:

**Checks:**
- [ ] Handler does NOT import from main.ts
- [ ] Handler does NOT depend on main.ts implementation details
- [ ] Handler depends ONLY on its declared context and public modules
- [ ] Handler can be unit-tested without main.ts

**Why essential:** Prevents hidden coupling that makes refactoring dangerous

**Verify:**
```bash
# Check for main.ts imports
grep "from.*main\|from.*'\.\./main\|from.*\"./main\"" handlers/assistantStart.ts
# Expected: (no matches)

# Check for implementation detail leakage
# (manual review: does handler assume main.ts internal structure?)
```

---

## PR6 Preparation Note

**⚠️ DO NOT split HandlerContext yet.**

Wait until at least 3–4 handlers are extracted (PR5.0, PR5.1, PR5.2) and compare their actual capability usage:

**After PR5.2, compare:**
```typescript
// TodosContext (PR5.0)
{ ensureTarget, renderTodos }

// AssistantStartContext (PR5.1)  
{ ensureTarget, setStatusLabel, startStatusTimer }

// AgentStepContext (PR5.2)
{ ensureTarget, setStatusLabel, startStatusTimer, scrollDown }
```

**Create shared interfaces ONLY from demonstrated overlap, not anticipated future reuse:**
- `ensureTarget` used by ALL → TargetManager (create in PR6)
- `setStatusLabel + startStatusTimer` used by 2 → StatusDisplay (create if 3rd handler uses it)

**Why:** Splitting on assumptions creates wrong abstractions. Wait for real patterns.

---

## Target Lifecycle Rule

Handlers should not gradually accumulate Target lifecycle state mutations.

**Tracking:**
- `handleToolStatus` mutates: `activeTool`, `currentText`, `_wasStreamed`
- If 2+ handlers mutate same Target lifecycle fields → candidate for abstraction

**Current state (from audit):**
| Handler | Target Mutations | Fields |
|---------|-----------------|--------|
| handleTodos | None | - |
| handleAssistantStart | Minimal | `model` (metadata only) |
| handleAgentStep | None | - |
| handleToolStatus | Significant | `activeTool`, `currentText`, `_wasStreamed` |

**Rule:** If multiple handlers accumulate Target lifecycle mutations, those operations become candidates for Target lifecycle abstraction in a future PR.

---

## Architectural Metrics (Primary)

Track these BEFORE line count (they indicate real progress):

**Before PR5.1:**
```
Extracted handlers: 1
Capability-based contexts: 1
Direct global access: 0
Direct DOM queries: 1 (in handleToolStatus)
Public API size: 1 export per handler
Shared capability overlap: 0 (too early)
```

**After PR5.1 (expected):**
```
Extracted handlers: 2
Capability-based contexts: 2
Direct global access: 0
Direct DOM queries: 1 (unchanged)
Public API size: 1 export per handler
Shared capability overlap: 1 (ensureTarget common to both)
```

**Why these matter:**
- `Extracted handlers` → modularization progress
- `Capability-based contexts` → abstraction quality
- `Shared capability overlap` → informs PR6 context split
- `Direct DOM queries` → technical debt indicator

**Line count is secondary** - it's a side effect, not the goal.

---

## Future Abstraction Rule

**Do NOT introduce a shared abstraction until it is used by at least 3 independent handlers or modules.**

**Prefer duplication over premature abstraction.**

**Examples:**

❌ **BAD - Premature abstraction:**
```typescript
// After only 2 handlers extracted
interface TargetManager {
  ensureTarget(...): Target;
  // Created "because we might need it"
}
```

✅ **GOOD - Wait for demonstrated need:**
```typescript
// After 4 handlers extracted, ALL use ensureTarget
// Only THEN create TargetManager abstraction
interface TargetManager {
  ensureTarget(...): Target;
  // Shared by 4 handlers - real pattern emerged
}
```

**Why:** Premature abstraction:
- Locks in wrong design
- Creates coupling where none should exist
- Must be refactored later (wasted effort)

Demonstrated need:
- Emerges from real usage
- Natural boundaries become clear
- More likely to be correct

**Rule of thumb:** 3 independent uses = justify abstraction. 2 uses = wait and see.

---

**Reference:** HANDLER_DEPENDENCY_AUDIT.md, VERIFICATION_PR5.0.md
