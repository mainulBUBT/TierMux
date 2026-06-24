/**
 * Benchmark query dataset — 50 queries across 5 categories.
 * Source of truth: BENCHMARK_QUERIES.md (Bazardor).
 *
 * `expectedTokens` are the symbols/files the agent SHOULD touch for the query to
 * count as a retrieval hit. Retrieval is scored programmatically: a query scores 1
 * if any opened-file basename contains one of these tokens (case-insensitive).
 *
 * Chains (C1–C10) share state within a chain — see `chain` field.
 */

export interface BenchQuery {
  id: string;
  text: string;
  /** Lowercase substrings; basename match against any → retrieval = 1. */
  expectedTokens: string[];
  /** Chain id; queries sharing a chain id run in one persistent session. */
  chain?: string;
}

const EXPLAIN: BenchQuery[] = [
  { id: 'E1', text: 'How does a user submit a price contribution?', expectedTokens: ['contributionservice', 'pricecontribution'] },
  { id: 'E2', text: 'How is the cheapest price across markets calculated?', expectedTokens: ['marketcomparisonservice', 'productmarketprice'] },
  { id: 'E3', text: 'How does ContributionService validate a submitted price?', expectedTokens: ['contributionservice'] },
  { id: 'E4', text: 'How are user roles and permissions assigned?', expectedTokens: ['usermanagementservice', 'role', 'permission'] },
  { id: 'E5', text: 'How does the favorite system work for products and markets?', expectedTokens: ['favorite'] },
  { id: 'E6', text: 'How is product translation handled for multilingual support?', expectedTokens: ['producttranslation', 'translatable'] },
  { id: 'E7', text: 'How is ProductMarketPrice updated when a contribution is approved?', expectedTokens: ['contributionservice', 'productmarketprice'] },
  { id: 'E8', text: 'How are categories assigned to products?', expectedTokens: ['category', 'categoryservice', 'product'] },
  { id: 'E9', text: 'How does Sanctum API authentication work for price submission?', expectedTokens: ['api.php', 'sanctum'] },
  { id: 'E10', text: 'How does MarketComparisonService compare prices between markets?', expectedTokens: ['marketcomparisonservice', 'productmarketprice'] },
];

const BUG: BenchQuery[] = [
  { id: 'B1', text: 'Fix null pointer when ProductMarketPrice has no contributions.', expectedTokens: ['productmarketprice', 'contributionservice'] },
  { id: 'B2', text: 'Fix market comparison returning the wrong cheapest price.', expectedTokens: ['marketcomparisonservice'] },
  { id: 'B3', text: 'Fix contribution approval not updating ProductMarketPrice.', expectedTokens: ['contributionservice', 'productmarketprice'] },
  { id: 'B4', text: 'Fix favorite toggle throwing a 500 error for unauthenticated users.', expectedTokens: ['favoritecontroller', 'auth'] },
  { id: 'B5', text: 'Fix product search not returning multilingual results.', expectedTokens: ['productservice', 'producttranslation'] },
  { id: 'B6', text: 'Fix category filter returning products from the wrong market.', expectedTokens: ['categoryservice', 'productcontroller'] },
  { id: 'B7', text: 'Fix user reputation not updating after contribution rejection.', expectedTokens: ['contributionservice', 'user'] },
  { id: 'B8', text: 'Fix MarketComparisonService returning stale data after a price update.', expectedTokens: ['marketcomparisonservice', 'cache'] },
  { id: 'B9', text: 'Fix product listing pagination breaking when category is null.', expectedTokens: ['productcontroller', 'productservice'] },
  { id: 'B10', text: 'Fix API rate limiting not working on the price submission endpoint.', expectedTokens: ['api.php', 'throttle'] },
];

const FEATURE: BenchQuery[] = [
  { id: 'F1', text: 'Add price history tracking for ProductMarketPrice.', expectedTokens: ['productmarketprice', 'migration'] },
  { id: 'F2', text: 'Add an email notification when a contribution is approved or rejected.', expectedTokens: ['contributionservice', 'notification', 'mail'] },
  { id: 'F3', text: 'Add bulk price contribution for multiple markets at once.', expectedTokens: ['contributionservice', 'pricecontribution'] },
  { id: 'F4', text: 'Add an API endpoint for fetching the cheapest market for a product.', expectedTokens: ['marketcomparisonservice', 'api.php'] },
  { id: 'F5', text: 'Add a contribution cooldown — a user cannot submit the same product twice in 24 hours.', expectedTokens: ['contributionservice', 'pricecontribution'] },
  { id: 'F6', text: 'Add a product price alert — notify the user when price drops below their threshold.', expectedTokens: ['productmarketprice', 'notification'] },
  { id: 'F7', text: 'Add an admin dashboard showing top contributors this week.', expectedTokens: ['pricecontribution', 'usermanagementservice'] },
  { id: 'F8', text: 'Add CSV export for product prices across all markets.', expectedTokens: ['productmarketprice', 'marketcomparisonservice'] },
  { id: 'F9', text: 'Add a market distance filter — show markets within X km of the user location.', expectedTokens: ['market'] },
  { id: 'F10', text: 'Add a product price trend chart data endpoint — last 30 days.', expectedTokens: ['productmarketprice', 'pricehistory'] },
];

const REFACTOR: BenchQuery[] = [
  { id: 'R1', text: 'Rename PriceContribution to UserPriceReport across the codebase.', expectedTokens: ['pricecontribution'] },
  { id: 'R2', text: 'Move price validation logic from ContributionService into a dedicated PriceValidator class.', expectedTokens: ['contributionservice'] },
  { id: 'R3', text: 'Rename MarketComparisonService to PriceComparisonService.', expectedTokens: ['marketcomparisonservice'] },
  { id: 'R4', text: 'Extract the favorite toggle logic from the controller into a FavoriteService.', expectedTokens: ['favoritecontroller'] },
  { id: 'R5', text: 'Move market distance calculation into a separate MarketLocationService.', expectedTokens: ['market'] },
  { id: 'R6', text: 'Extract the contribution approval flow from ContributionService into a ContributionApprovalService.', expectedTokens: ['contributionservice'] },
  { id: 'R7', text: 'Move Sanctum API routes into a dedicated routes/v1.php file.', expectedTokens: ['api.php'] },
  { id: 'R8', text: 'Rename UserManagementService to UserService.', expectedTokens: ['usermanagementservice'] },
  { id: 'R9', text: 'Extract product search logic from ProductController into a ProductSearchService.', expectedTokens: ['productcontroller'] },
  { id: 'R10', text: 'Move all price-related constants (thresholds, limits) into a PriceConfig class.', expectedTokens: ['contributionservice', 'marketcomparisonservice'] },
];

const CHAINS: BenchQuery[] = [
  { id: 'C1', text: 'How does ContributionService handle a new price submission?', expectedTokens: ['contributionservice'], chain: 'A' },
  { id: 'C2', text: 'Now add validation to reject prices that are 50% above the current market average.', expectedTokens: ['contributionservice'], chain: 'A' },
  { id: 'C3', text: 'Add an admin notification when a contribution is auto-rejected by this rule.', expectedTokens: ['contributionservice', 'notification'], chain: 'A' },
  { id: 'C4', text: 'How does MarketComparisonService find the cheapest price for a product?', expectedTokens: ['marketcomparisonservice'], chain: 'B' },
  { id: 'C5', text: 'Now cache the comparison result for 30 minutes using the Laravel cache.', expectedTokens: ['marketcomparisonservice', 'cache'], chain: 'B' },
  { id: 'C6', text: 'Add an API endpoint that returns this cached comparison result.', expectedTokens: ['marketcomparisonservice', 'api.php'], chain: 'B' },
  { id: 'C7', text: 'How is user reputation calculated after a contribution is approved or rejected?', expectedTokens: ['contributionservice', 'user'], chain: 'C' },
  { id: 'C8', text: 'Fix: reputation is not updating when a contribution is auto-approved by the system.', expectedTokens: ['contributionservice', 'user'], chain: 'C' },
  { id: 'C9', text: 'How does the favorite system currently work for products?', expectedTokens: ['favorite'], chain: 'D' },
  { id: 'C10', text: 'Add a price drop notification — when a favorited product\'s price drops 10%, notify the user.', expectedTokens: ['favorite', 'notification'], chain: 'D' },
];

/** All 50, in canonical order. */
export const QUERIES: BenchQuery[] = [...EXPLAIN, ...BUG, ...FEATURE, ...REFACTOR, ...CHAINS];

export type Scope =
  | 'smoke' // E1–E3
  | 'consistency' // E1 × 3 (judge determinism check)
  | 'explain' // E1–E10
  | 'bug' // B1–B10
  | 'feature' // F1–F10
  | 'refactor' // R1–R10
  | 'chains' // C1–C10
  | 'all'; // everything

export function queriesForScope(scope: Scope): BenchQuery[] {
  switch (scope) {
    case 'smoke': return EXPLAIN.slice(0, 3);
    case 'consistency': {
      // Run E1 three times. Each becomes its own single-shot unit (fresh session),
      // so planExecution yields 3 independent runs of the identical query.
      const e1 = EXPLAIN[0];
      return [{ ...e1, id: 'E1#1' }, { ...e1, id: 'E1#2' }, { ...e1, id: 'E1#3' }];
    }
    case 'explain': return EXPLAIN;
    case 'bug': return BUG;
    case 'feature': return FEATURE;
    case 'refactor': return REFACTOR;
    case 'chains': return CHAINS;
    case 'all': return QUERIES;
  }
}

/** Group queries into execution units: single-shot queries run in fresh sessions; each chain runs in one persistent session. */
export interface ExecutionUnit {
  /** Queries to run, in order, sharing one session. */
  queries: BenchQuery[];
  /** True when this unit is a multi-step chain (do not reset between steps). */
  chained: boolean;
}

export function planExecution(queries: BenchQuery[]): ExecutionUnit[] {
  const units: ExecutionUnit[] = [];
  // Chain queries: group by chain id, preserve order of first appearance.
  const chainOrder: string[] = [];
  const byChain = new Map<string, BenchQuery[]>();
  const standalone: BenchQuery[] = [];
  for (const q of queries) {
    if (q.chain) {
      if (!byChain.has(q.chain)) { byChain.set(q.chain, []); chainOrder.push(q.chain); }
      byChain.get(q.chain)!.push(q);
    } else {
      standalone.push(q);
    }
  }
  for (const q of standalone) units.push({ queries: [q], chained: false });
  for (const c of chainOrder) units.push({ queries: byChain.get(c)!, chained: true });
  return units;
}
