# Phase D2 Complete Framework - Mechanical Extraction

**Status:** ✅ Complete - 12 Disciplines Established

**Evolution:** PR5.0 (Mechanical) → PR5.1 (Architectural) → **Complete Framework**

---

## Overview

Phase D2 has evolved into a comprehensive framework for **mechanical, verifiable, low-risk handler extraction**. Each PR follows disciplined gates ensuring architectural progress without scope creep.

## 12 Disciplines (6 Original + 6 Enhanced)

### Original 6 Disciplines (from PR5.1)

1. **No Import From Main.ts Rule**
   - Handler cannot import main.ts
   - Only imports from stable modules
   - Prevents circular dependencies

2. **Context Growth Guard**
   - Max 3 members per context (soft: 4 with justification)
   - Prevents God Object resurrection

3. **Public API Freeze**
   - Export ONLY the handler function
   - Types, helpers, constants stay internal
   - Makes future refactoring easier

4. **Runtime Regression Smoke Test**
   - 1-minute manual test after extraction
   - Catches regressions build misses
   - Quick revert if fails

5. **Architectural Metrics (Primary)**
   - Track extracted handlers, capability contexts
   - Line count is secondary
   - Focus on architectural progress

6. **PR Stop Rule**
   - STOP if requires: HandlerContext export, main.ts import, @ts-ignore
   - Prevents scope creep
   - One PR = one capability extraction

### Enhanced 6 Disciplines (New)

7. **Dependency Budget**
   - Context capabilities: ≤ 3 (soft: 4)
   - Public exports: exactly 1
   - Imports: ≤ 5
   - Global access: 0
   - Direct DOM queries: 0 (justify if needed)

8. **Independence Gate**
   - Handler independent from main.ts implementation
   - Depends only on declared context + public modules
   - Can be unit-tested without main.ts

9. **PR6 Preparation Note**
   - DO NOT split HandlerContext yet
   - Wait for 3-4 handlers to be extracted
   - Create shared interfaces from demonstrated overlap only
   - Not from anticipated future reuse

10. **Target Lifecycle Rule**
    - Track Target mutations across handlers
    - If 2+ handlers mutate same fields → abstraction candidate
    - Prevents distributed lifecycle management

11. **Architectural Metrics (Detailed)**
    - Extracted handlers count
    - Capability-based contexts count
    - Direct global access: 0
    - Direct DOM queries: track
    - Public API size: 1 per handler
    - Shared capability overlap: informs PR6

12. **Future Abstraction Rule**
    - Do NOT abstract until 3 independent uses
    - Prefer duplication over premature abstraction
    - Real patterns emerge, wrong designs avoided

---

## PR5.1 Complete Gate (7 Questions + 6 Budgets)

### 7-Gate Test (All Must Be YES)

| # | Gate Question | Verify Method |
|---|---------------|---------------|
| 1 | Only handleAssistantStart moved? | Code review |
| 2 | Context has exactly 3 capabilities? | Interface inspection |
| 3 | No import from main.ts? | Grep handler file |
| 4 | Old implementation deleted? | Grep main.ts |
| 5 | Build baseline passes? | npm run build |
| 6 | No new suppressions? | Grep @ts-ignore |
| 7 | Runtime smoke test passes? | Manual test (1 min) |

### 6 Budget Checks (Must All Pass)

| # | Budget | Limit | Verify |
|---|--------|-------|--------|
| 1 | Context capabilities | ≤ 3 (4 with justification) | Count interface methods |
| 2 | Public exports | exactly 1 | Count `^export` lines |
| 3 | Imports | ≤ 5 modules | Count `^import` lines |
| 4 | Global access | 0 | Review handler code |
| 5 | DOM queries | 0 (justify if needed) | Review DOM access |
| 6 | Independence | fully independent | Check imports + implementation details |

**Result:** 7 YES + 6 PASS = Merge Ready ✅

---

## Extraction Template (Step by Step)

### Phase 1: Pre-Extraction

1. Review HANDLER_DEPENDENCY_AUDIT.md
2. Check handler dependencies count
3. Verify Target mutations (if any)
4. Review extraction difficulty rating

### Phase 2: Extraction

5. Create `handlers/[handlerName].ts`
6. Define focused types (message, target subset, context)
7. Extract handler function
8. Keep types/helpers internal (Public API Freeze)

### Phase 3: Integration

9. Add import to main.ts: `import { handleX } from './handlers/x'`
10. Update case statement to call extracted handler

### Phase 4: Cleanup

11. Remove old implementation from main.ts
12. Verify with grep: no matches for old function

### Phase 5: Architecture Verification

13. **Dependency Budget Check:**
    - Count capabilities (≤ 3)
    - Count imports (≤ 5)
    - Count exports (exactly 1)
    - Verify no global access
    - Check DOM queries (justify if present)

14. **Independence Gate:**
    - No main.ts imports
    - No implementation detail leakage
    - Unit-testable without main.ts

15. **Context Growth Check:**
    - Max 3 members
    - Justify if 4th needed

### Phase 6: Build Verification

16. Build green: `npm run build`
17. No new type suppressions: `grep @ts-ignore @ts-expect-error`
18. @ts-nocheck unchanged (Phase D baseline)

### Phase 7: Runtime Verification

19. **Smoke Test (1 minute):**
    - Trigger the handler's flow
    - Verify expected behavior
    - Check no regressions

### Phase 8: Gate Check

20. **7-Gate Test:**
    - All 7 questions must be YES
    - If any NO → fix and re-verify

### Phase 9: Metrics Update

21. Update architectural metrics:
    - Extracted handlers: +1
    - Capability contexts: +1
    - Shared overlaps: track
    - Direct DOM queries: track

### Phase 10: Commit

22. **Commit message:**
    ```
    refactor(webview): extract [handler] handler (Phase D2 PR[X])
    
    - Extract handle[X] to handlers/[x].ts
    - Introduce focused [X]Context interface
    - Remove inline handler from main.ts
    - Preserve runtime behavior
    
    Phase D2: incremental handler extraction using capability-based contexts
    ```

23. Merge when all gates pass

---

## Architecture Progress Tracking

### Metrics by PR

| PR | Handler | Context Size | Handlers | Contexts | Shared Overlap |
|----|---------|--------------|----------|----------|----------------|
| PR5.0 | handleTodos | 2 members | 1 | 1 | 0 |
| PR5.1 | handleAssistantStart | 3 members | 2 | 2 | 1 (ensureTarget) |
| PR5.2 | handleAgentStep | 4 members | 3 | 3 | 2 (ensureTarget, setStatusLabel+startStatusTimer) |
| PR6 | handleToolStatus | TBD | 4 | TBD | TBD |
| PR7 | Context Split | N/A | 4 | 3–5 | Shared → extracted |

### Anti-Patterns Detected Early

**Dependency Budget Violation:**
- Context > 3 members → justify or split PR
- Imports > 5 → consolidate dependencies
- Exports > 1 → reduce public API

**Independence Gate Failure:**
- Imports main.ts → STOP, restructure
- Depends on implementation details → STOP, redesign
- Not unit-testable → STOP, refactor

**Premature Abstraction:**
- Shared interface before 3 uses → STOP, duplicate instead
- Abstracting on assumptions → STOP, wait for patterns

**Context Growth:**
- Gradual addition to context → STOP, budget exceeded
- God Object resurrection → STOP, split context

---

## Example: PR5.1 Application

### Before Extraction
```
main.ts: 3431 lines
Handlers extracted: 1 (todos)
Contexts: 1 (TodosContext)
Shared overlap: 0
```

### During Extraction
```
handlers/assistantStart.ts created:
- AssistantStartMessage interface
- Target interface (subset: el, body, model)
- AssistantStartContext interface (3 members)
- handleAssistantStart function (export only)

Dependency Budget:
- Capabilities: 3 ✅ (≤ 3)
- Exports: 1 ✅ (exactly handler)
- Imports: 0 ✅ (≤ 5)
- Global access: 0 ✅
- DOM queries: 0 ✅

Independence Gate:
- No main.ts import ✅
- No impl detail leakage ✅
- Unit-testable ✅
```

### After Extraction
```
main.ts: 3427 lines (-4)
Handlers extracted: 2 ✅
Contexts: 2 ✅
Shared overlap: 1 (ensureTarget) ✅

7-Gate: All YES ✅
6-Budget: All PASS ✅
Runtime: Smoke test PASS ✅

Status: MERGE READY ✅
```

---

## PR6 Context Split Preparation

After PR5.2 (3 handlers extracted), compare actual capability usage:

```typescript
// TodosContext (PR5.0)
{ ensureTarget, renderTodos }

// AssistantStartContext (PR5.1)
{ ensureTarget, setStatusLabel, startStatusTimer }

// AgentStepContext (PR5.2)
{ ensureTarget, setStatusLabel, startStatusTimer, scrollDown }
```

**Overlap Analysis:**
- `ensureTarget`: used by ALL 3 → **Create TargetManager** ✅
- `setStatusLabel + startStatusTimer`: used by 2 → **Wait for 3rd handler** ⏸️
- `renderTodos`: used by 1 → **Keep local** ✅
- `scrollDown`: used by 1 → **Keep local** ✅

**PR6 Decision:**
- Create `TargetManager` interface (ensureTarget only)
- Defer `StatusDisplay` until 3rd handler uses status/timer
- Keep handler-specific capabilities local

**Result:** Context split based on demonstrated patterns, not assumptions.

---

## Key Principles

1. **Mechanical Process**
   - Each extraction follows same template
   - No heroics, no guessing
   - Verifiable at each step

2. **Architectural Discipline**
   - Dependency budgets prevent scope creep
   - Independence gates prevent coupling
   - Context growth guards prevent God Objects

3. **Verification Over Trust**
   - 7-gate test must all pass
   - 6-budget checks must all pass
   - Runtime smoke test required
   - Build verification required

4. **Evidence-Based Evolution**
   - Wait for 3 uses before abstracting
   - Create shared interfaces from real overlap
   - Not from anticipated future reuse

5. **Incremental Progress**
   - One handler per PR
   - Small, reviewable commits
   - Always mergeable, always revertible

---

## Files in Framework

### Core Documents
1. **[HANDLER_DEPENDENCY_AUDIT.md](HANDLER_DEPENDENCY_AUDIT.md)** - Complete dependency analysis
2. **[VERIFICATION_PR5.0.md](VERIFICATION_PR5.0.md)** - PR5.0 verification + Phase D baseline
3. **[CHECKLIST_PR5.1.md](CHECKLIST_PR5.1.md)** - Complete extraction checklist (12 disciplines)
4. **[PR5_REFINEMENTS_COMPLETE.md](PR5_REFINEMENTS_COMPLETE.md)** - Original 6 disciplines
5. **[PHASE_D2_COMPLETE_FRAMEWORK.md](PHASE_D2_COMPLETE_FRAMEWORK.md)** - This document

### Handler Files
- **[handlers/todos.ts](handlers/todos.ts)** - PR5.0 extracted (pattern template)

---

## Success Criteria

### For Each PR (PR5.1, PR5.2, PR6, PR7)

**Must Pass:**
- ✅ 7-Gate Test (all YES)
- ✅ 6-Budget Checks (all PASS)
- ✅ Runtime Smoke Test
- ✅ Build Verification
- ✅ No Regressions

**Must Maintain:**
- ✅ Dependency Budget (≤ 3 capabilities)
- ✅ Independence Gate (no main.ts coupling)
- ✅ Context Growth (max 3-4 members)
- ✅ Public API Freeze (1 export)
- ✅ No Premature Abstraction (wait for 3 uses)

### For Phase D2 (Overall)

**Architectural Progress:**
- ✅ 4 handlers extracted
- ✅ 3–5 capability contexts created
- ✅ Shared capabilities identified and extracted
- ✅ main.ts reduced to routing + core state
- ✅ Zero direct global access in handlers
- ✅ Zero circular dependencies
- ✅ All contexts focused and testable

**Code Quality:**
- ✅ Build green throughout
- ✅ No accumulating type suppressions
- ✅ Runtime regressions caught early
- ✅ Each handler independently testable

---

## Next Steps

### Immediate (PR5.1)
```bash
# Use complete checklist
cat CHECKLIST_PR5.1.md

# Follow 12 disciplines
# Pass 7 gates + 6 budgets
# Runtime smoke test
# Commit when ready
```

### Future (PR5.2, PR6, PR7)
- Apply same template to each PR
- Track metrics progression
- Compare contexts after PR5.2
- Plan PR6 context split from real patterns
- Execute PR7 split based on demonstrated overlaps

---

## Summary

Phase D2 now has a **complete, mechanical, verifiable framework** for handler extraction:

- **12 Disciplines** (6 original + 6 enhanced)
- **7-Gate Test** (must all be YES)
- **6-Budget Checks** (must all PASS)
- **Runtime Verification** (smoke test required)
- **Architecture Tracking** (metrics over line counts)
- **Evidence-Based Evolution** (wait for 3 uses)

Each PR is:
- ✅ Mechanical (follow template)
- ✅ Verifiable (gates + budgets)
- ✅ Low-risk (runtime tested)
- ✅ Incremental (one handler at a time)
- ✅ Reviewable (small commits)

**Result:** Sustainable architectural decomposition with confidence.

---

Phase D2 Complete Framework: Ready for PR5.1 and beyond. 🎯
