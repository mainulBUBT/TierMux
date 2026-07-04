# Benchmark Query Dataset — Bazardor

50 queries across 5 categories.
Score each: Retrieval (0/1) · Reasoning (0/0.5/1) · Answer (0/1)

---

## Category 1: Explain (10 queries)

| # | Query | Expected retrieval |
|---|---|---|
| E1 | How does a user submit a price contribution? | ContributionService, PriceContribution |
| E2 | How is the cheapest price across markets calculated? | MarketComparisonService, ProductMarketPrice |
| E3 | How does ContributionService validate a submitted price? | ContributionService |
| E4 | How are user roles and permissions assigned? | UserManagementService, spatie Role/Permission |
| E5 | How does the favorite system work for products and markets? | Favorite model, FavoriteController or similar |
| E6 | How is product translation handled for multilingual support? | ProductTranslation, astrotomic translatable |
| E7 | How is ProductMarketPrice updated when a contribution is approved? | ContributionService, ProductMarketPrice |
| E8 | How are categories assigned to products? | Category, Product, CategoryService |
| E9 | How does Sanctum API authentication work for price submission? | routes/api.php, sanctum middleware |
| E10 | How does MarketComparisonService compare prices between markets? | MarketComparisonService, ProductMarketPrice |

---

## Category 2: Bug Fix (10 queries)

| # | Query | Expected retrieval |
|---|---|---|
| B1 | Fix null pointer when ProductMarketPrice has no contributions | ProductMarketPrice, ContributionService |
| B2 | Fix market comparison returning wrong cheapest price | MarketComparisonService |
| B3 | Fix contribution approval not updating ProductMarketPrice | ContributionService, ProductMarketPrice |
| B4 | Fix favorite toggle throwing 500 error for unauthenticated users | FavoriteController, auth middleware |
| B5 | Fix product search not returning multilingual results | ProductService, ProductTranslation |
| B6 | Fix category filter returning products from wrong market | CategoryService or ProductController |
| B7 | Fix user reputation not updating after contribution rejection | ContributionService, User model |
| B8 | Fix MarketComparisonService returning stale data after price update | MarketComparisonService, cache logic |
| B9 | Fix product listing pagination breaking when category is null | ProductController or ProductService |
| B10 | Fix API rate limiting not working on price submission endpoint | routes/api.php, throttle middleware |

---

## Category 3: Feature (10 queries)

| # | Query | Expected retrieval |
|---|---|---|
| F1 | Add price history tracking for ProductMarketPrice | ProductMarketPrice, migration |
| F2 | Add email notification when a contribution is approved or rejected | ContributionService, Mail or Notification |
| F3 | Add bulk price contribution for multiple markets at once | ContributionService, PriceContribution |
| F4 | Add API endpoint for fetching cheapest market for a product | MarketComparisonService, routes/api.php |
| F5 | Add contribution cooldown — user cannot submit same product twice in 24 hours | ContributionService, PriceContribution |
| F6 | Add product price alert — notify user when price drops below their threshold | ProductMarketPrice, User, Notification |
| F7 | Add admin dashboard showing top contributors this week | PriceContribution, UserManagementService |
| F8 | Add CSV export for product prices across all markets | ProductMarketPrice, MarketComparisonService |
| F9 | Add market distance filter — show markets within X km of user location | Market model, location/distance logic |
| F10 | Add product price trend chart data endpoint — last 30 days | ProductMarketPrice, price history |

---

## Category 4: Refactor (10 queries)

| # | Query | Expected retrieval |
|---|---|---|
| R1 | Rename PriceContribution to UserPriceReport across the codebase | PriceContribution model, all references |
| R2 | Move price validation logic from ContributionService to a dedicated PriceValidator class | ContributionService |
| R3 | Rename MarketComparisonService to PriceComparisonService | MarketComparisonService, all usages |
| R4 | Extract favorite toggle logic from controller into a FavoriteService | FavoriteController |
| R5 | Move market distance calculation into a separate MarketLocationService | Market model or controller |
| R6 | Extract contribution approval flow from ContributionService into ContributionApprovalService | ContributionService |
| R7 | Move Sanctum API routes into a dedicated routes/v1.php file | routes/api.php |
| R8 | Rename UserManagementService to UserService | UserManagementService, all usages |
| R9 | Extract product search logic from ProductController to ProductSearchService | ProductController |
| R10 | Move all price-related constants (thresholds, limits) into a PriceConfig class | ContributionService, MarketComparisonService |

---

## Category 5: Follow-up / Continuation (10 queries — 4 chains)

These must be run as chains. Do NOT reset context between steps in a chain.
This tests conversationMemory + executionTracker.

### Chain A — Contribution validation flow (3 steps)

| # | Query |
|---|---|
| C1 | How does ContributionService handle a new price submission? |
| C2 | Now add validation to reject prices that are 50% above the current market average |
| C3 | Add an admin notification when a contribution is auto-rejected by this rule |

### Chain B — Market comparison + caching (3 steps)

| # | Query |
|---|---|
| C4 | How does MarketComparisonService find the cheapest price for a product? |
| C5 | Now cache the comparison result for 30 minutes using Laravel cache |
| C6 | Add an API endpoint that returns this cached comparison result |

### Chain C — User reputation (2 steps)

| # | Query |
|---|---|
| C7 | How is user reputation calculated after a contribution is approved or rejected? |
| C8 | Fix: reputation is not updating when contribution is auto-approved by the system |

### Chain D — Favorite + notification (2 steps)

| # | Query |
|---|---|
| C9 | How does the favorite system currently work for products? |
| C10 | Add a price drop notification — when a favorited product's price drops 10%, notify the user |

---

## Scoring Sheet

Copy this table and fill after each query.

| # | Query | Retrieval | Reasoning | Answer | Notes |
|---|---|---|---|---|---|
| E1 | Price contribution submit | | | | |
| E2 | Cheapest price calculation | | | | |
| E3 | Contribution validation | | | | |
| E4 | Roles and permissions | | | | |
| E5 | Favorite system | | | | |
| E6 | Multilingual translation | | | | |
| E7 | ProductMarketPrice update on approval | | | | |
| E8 | Category assignment | | | | |
| E9 | Sanctum API auth | | | | |
| E10 | Market comparison logic | | | | |
| B1 | Null pointer — no contributions | | | | |
| B2 | Wrong cheapest price | | | | |
| B3 | Approval not updating price | | | | |
| B4 | Favorite 500 error | | | | |
| B5 | Multilingual search broken | | | | |
| B6 | Category filter wrong market | | | | |
| B7 | Reputation not updating | | | | |
| B8 | Stale comparison data | | | | |
| B9 | Pagination null category | | | | |
| B10 | Rate limiting not working | | | | |
| F1 | Price history tracking | | | | |
| F2 | Email on contribution | | | | |
| F3 | Bulk contribution | | | | |
| F4 | Cheapest market API | | | | |
| F5 | Contribution cooldown | | | | |
| F6 | Price drop alert | | | | |
| F7 | Top contributors dashboard | | | | |
| F8 | CSV export | | | | |
| F9 | Distance filter | | | | |
| F10 | Price trend endpoint | | | | |
| R1 | Rename PriceContribution | | | | |
| R2 | Extract PriceValidator | | | | |
| R3 | Rename MarketComparisonService | | | | |
| R4 | Extract FavoriteService | | | | |
| R5 | Extract MarketLocationService | | | | |
| R6 | Extract ContributionApprovalService | | | | |
| R7 | Move API routes | | | | |
| R8 | Rename UserManagementService | | | | |
| R9 | Extract ProductSearchService | | | | |
| R10 | Extract PriceConfig | | | | |
| C1 | Contribution submission flow | | | | |
| C2 | → Add 50% threshold validation | | | | |
| C3 | → Admin notification on reject | | | | |
| C4 | Market comparison cheapest | | | | |
| C5 | → Cache 30 minutes | | | | |
| C6 | → API endpoint | | | | |
| C7 | Reputation calculation | | | | |
| C8 | → Fix auto-approve reputation bug | | | | |
| C9 | Favorite system | | | | |
| C10 | → Price drop notification | | | | |
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
