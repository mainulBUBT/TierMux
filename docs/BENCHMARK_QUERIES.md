# Benchmark Query Dataset Template

50 queries across 5 categories to benchmark agent performance on **ANY** project.
**Instructions:** Before running the benchmark, replace the `[Placeholder]` values with actual components, models, and services from your target codebase.

Score each: Retrieval (0/1) · Reasoning (0/0.5/1) · Answer (0/1)

---

## Category 1: Explain (10 queries)

| # | Query Template | Expected retrieval |
|---|---|---|
| E1 | How does a user submit a [Core Entity Action]? | [Core Service], [Action Controller] |
| E2 | How is the [Complex Calculation] calculated? | [Calculation Service], [Main Data Model] |
| E3 | How does [Core Service] validate a [Submitted Data]? | [Core Service], [Validation Logic] |
| E4 | How are user roles and permissions assigned? | [User Service], [Role/Permission Config] |
| E5 | How does the [Secondary Feature, e.g., Favorite/Like] system work for [Main Entity]? | [Secondary Model], [Related Controller] |
| E6 | How is [Localization/Multi-tenant/Edge Case] handled? | [Relevant Service], [Config/Middleware] |
| E7 | How is [Related Model] updated when a [Core Entity Action] is approved/completed? | [Core Service], [Related Model] |
| E8 | How are [Taxonomy/Categories] assigned to [Main Entity]? | [Category Model], [Main Entity], [Service] |
| E9 | How does [Authentication System] work for [Specific Endpoint]? | [Router File], [Auth Middleware] |
| E10 | How does [Data Processing Service] process [Specific Data Task]? | [Data Processing Service], [Main Data Model] |

---

## Category 2: Bug Fix (10 queries)

| # | Query Template | Expected retrieval |
|---|---|---|
| B1 | Fix null pointer when [Main Data Model] has no [Related Entities] | [Main Data Model], [Processing Service] |
| B2 | Fix [Calculation Service] returning wrong [Calculated Value] | [Calculation Service] |
| B3 | Fix [Action Event] not updating [Related Model] | [Action Service], [Related Model] |
| B4 | Fix [Secondary Feature] throwing 500 error for unauthenticated users | [Feature Controller], [Auth Middleware] |
| B5 | Fix [Search/Filter Feature] not returning [Specific Condition] results | [Search Service], [Query Logic] |
| B6 | Fix [Filter/Sort Feature] returning items from wrong [Context/Tenant] | [Filter Service] or [Controller] |
| B7 | Fix [User Stat/Metric] not updating after [Action Event] | [Action Service], [User Model] |
| B8 | Fix [Data Processing Service] returning stale data after [Update Event] | [Data Processing Service], [Cache Logic] |
| B9 | Fix [List View] pagination breaking when [Parameter] is null | [Controller] or [List Service] |
| B10 | Fix API rate limiting not working on [Important Endpoint] | [Router File], [Throttle Middleware] |

---

## Category 3: Feature (10 queries)

| # | Query Template | Expected retrieval |
|---|---|---|
| F1 | Add [History/Audit] tracking for [Main Data Model] | [Main Data Model], [Migration/Schema] |
| F2 | Add email/push notification when a [Action Event] happens | [Action Service], [Notification Class] |
| F3 | Add bulk [Core Action] for multiple [Entities] at once | [Action Service], [Controller] |
| F4 | Add API endpoint for fetching [Specific Aggregated Data] | [Data Service], [Router File] |
| F5 | Add [Action Cooldown/Rate Limit] — user cannot [Do Action] twice in 24 hours | [Action Service], [Relevant Model] |
| F6 | Add [Alert/Trigger] — notify user when [Metric] hits [Threshold] | [Main Data Model], [User], [Notification] |
| F7 | Add admin dashboard showing [Top Metric] this week | [Metric Model], [Admin Service] |
| F8 | Add CSV export for [Main Entity] across all [Contexts] | [Main Data Model], [Export Service] |
| F9 | Add [Proximity/Complex Filter] — show [Entities] matching [Complex Condition] | [Main Entity Model], [Filter Logic] |
| F10 | Add [Trend/Chart] data endpoint — last 30 days of [Metric] | [Main Data Model], [History Logic] |

---

## Category 4: Refactor (10 queries)

| # | Query Template | Expected retrieval |
|---|---|---|
| R1 | Rename [Core Model] to [New Name] across the codebase | [Core Model], all references |
| R2 | Move [Validation Logic] from [Core Service] to a dedicated [Validator Class] | [Core Service] |
| R3 | Rename [Main Service] to [New Service Name] | [Main Service], all usages |
| R4 | Extract [Feature] logic from [Controller] into a [Feature Service] | [Controller] |
| R5 | Move [Complex Calculation] into a separate [Calculation Class] | [Model] or [Controller] |
| R6 | Extract [Action Approval Flow] from [Core Service] into [Approval Service] | [Core Service] |
| R7 | Move [Specific Group] API routes into a dedicated [New Route File] | [Main Router File] |
| R8 | Rename [User Service] to [New User Service Name] | [User Service], all usages |
| R9 | Extract [Search Logic] from [Controller] to [Search Service] | [Controller] |
| R10 | Move all [Domain]-related constants into a [DomainConfig] class | [Relevant Services] |

---

## Category 5: Follow-up / Continuation (10 queries — 4 chains)

These must be run as chains. Do NOT reset context between steps in a chain.
This tests conversationMemory + executionTracker.

### Chain A — Validation flow (3 steps)

| # | Query Template |
|---|---|
| C1 | How does [Core Service] handle a new [Entity Submission]? |
| C2 | Now add validation to reject [Submissions] that are [Specific Invalid Condition] |
| C3 | Add an admin notification when a [Submission] is auto-rejected by this rule |

### Chain B — Data Processing + caching (3 steps)

| # | Query Template |
|---|---|
| C4 | How does [Data Service] find the [Best/Top Metric] for a [Entity]? |
| C5 | Now cache the result for 30 minutes using [Project Cache System] |
| C6 | Add an API endpoint that returns this cached result |

### Chain C — State / Metric Updates (2 steps)

| # | Query Template |
|---|---|
| C7 | How is [User Metric/Reputation] calculated after a [Action] is [State]? |
| C8 | Fix: [Metric] is not updating when [Action] is auto-processed by the system |

### Chain D — Feature + Notification (2 steps)

| # | Query Template |
|---|---|
| C9 | How does the [Secondary Feature, e.g., Favorite] system currently work? |
| C10 | Add a [Trigger Notification] — when a [Favorited Entity]'s [Metric] drops, notify the user |

---

## Scoring Sheet

Copy this table and fill after each query.

| # | Query | Retrieval | Reasoning | Answer | Notes |
|---|---|---|---|---|---|
| E1 | Action submission | | | | |
| E2 | Calculation logic | | | | |
| E3 | Data validation | | | | |
| E4 | Roles and permissions | | | | |
| E5 | Secondary feature (Favorites) | | | | |
| E6 | Edge case / Localization | | | | |
| E7 | Related model updates | | | | |
| E8 | Taxonomy / Category | | | | |
| E9 | Authentication system | | | | |
| E10 | Data processing logic | | | | |
| B1 | Null pointer in related entities | | | | |
| B2 | Wrong calculation | | | | |
| B3 | Action not updating model | | | | |
| B4 | 500 error on feature | | | | |
| B5 | Filter / Search broken | | | | |
| B6 | Wrong filter context | | | | |
| B7 | Metric not updating | | | | |
| B8 | Stale processed data | | | | |
| B9 | Pagination breaking | | | | |
| B10 | Rate limiting failing | | | | |
| F1 | History tracking | | | | |
| F2 | Email / Push notification | | | | |
| F3 | Bulk operations | | | | |
| F4 | Aggregated API endpoint | | | | |
| F5 | Action cooldown / limit | | | | |
| F6 | Metric alert trigger | | | | |
| F7 | Admin dashboard metric | | | | |
| F8 | CSV Export | | | | |
| F9 | Complex filtering logic | | | | |
| F10 | Trend data endpoint | | | | |
| R1 | Rename Core Model | | | | |
| R2 | Extract Validator | | | | |
| R3 | Rename Main Service | | | | |
| R4 | Extract Feature Service | | | | |
| R5 | Extract Calculation Class | | | | |
| R6 | Extract Approval Service | | | | |
| R7 | Move API routes | | | | |
| R8 | Rename User Service | | | | |
| R9 | Extract Search Service | | | | |
| R10 | Extract Config Class | | | | |
| C1 | Submission flow | | | | |
| C2 | → Add complex validation | | | | |
| C3 | → Admin notification on reject| | | | |
| C4 | Data processing logic | | | | |
| C5 | → Add caching | | | | |
| C6 | → Expose API endpoint | | | | |
| C7 | Metric calculation | | | | |
| C8 | → Fix auto-process bug | | | | |
| C9 | Secondary feature flow | | | | |
| C10 | → Action trigger notification | | | | |
| | **TOTAL** | **/50** | **/100** | **/50** | |

---

## Final Score Calculation

```
Retrieval Score = sum(retrieval) / 50 × 100
Reasoning Score = sum(reasoning) / 50 × 100   (max 1.0 per query)
Answer Score    = sum(answer) / 50 × 100
```

## Pass/Fail

```
Retrieval ≥ 85%  ✓/✗
Reasoning ≥ 80%  ✓/✗
Answer    ≥ 80%  ✓/✗
```

---

## Diagnosis

```
Retrieval ≥85%, Reasoning <80%  →  free model bottleneck  →  tune model routing
Retrieval <85%                  →  retrieval pipeline      →  fix symbol index / alias
All three pass                  →  MVP PASSED, architecture frozen
```
