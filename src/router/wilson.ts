/**
 * Confidence / shrinkage statistics for the Smart Auto scoring engine.
 *
 * Pure functions, no VS Code deps. Used by {@link MetricsStore} and
 * {@link ScoringEngine} so that small sample sizes can't dominate large ones
 * and cold-start signals blend smoothly toward their prior.
 */

/**
 * Wilson score interval lower bound for a binomial proportion.
 *
 * This is the "how confident are we that the true success rate is at least X"
 * number used by ranking/recommendation systems. With few observations it
 * stays well below the raw mean; as n grows it converges to the mean. So
 * 3/3 success does NOT outrank 194/200.
 *
 * @param successes observed successes
 * @param total     observed trials
 * @param z         z-score for the confidence level (1.96 ≈ 95%)
 * @returns lower bound in [0,1]; 0 when total <= 0
 */
export function wilsonLowerBound(successes: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;
  const phat = Math.min(1, Math.max(0, successes / total));
  const denom = 1 + (z * z) / total;
  const center = phat + (z * z) / (2 * total);
  const spread = (z * Math.sqrt((phat * (1 - phat)) / total + (z * z) / (4 * total * total))) / denom;
  return Math.min(1, Math.max(0, (center - spread) / denom));
}

/**
 * Beta(α=1, β=1) posterior mean (= (successes+1)/(total+2)).
 *
 * A Bayesian "add-one" smoothing of a rate — mildly regularized toward 0.5,
 * never 0 or 1 on tiny samples. Used as an alternative regularized rate.
 */
export function betaMean(successes: number, total: number): number {
  if (total <= 0) return 0.5;
  return (successes + 1) / (total + 2);
}

/**
 * Confidence factor in [0,1] derived from sample count `n`.
 *
 * Returns ~0 at n=0 (no trust, lean on the prior), rising and saturating
 * around `k` observations. Uses a smooth bounded curve so there's no cliff.
 *
 *   confidence = n / (n + k)
 *
 * e.g. k=8 → n=8 gives 0.5, n=24 gives 0.75, n=80 gives ~0.91.
 */
export function shrinkageFactor(n: number, k: number): number {
  if (n <= 0) return 0;
  if (k <= 0) return 1;
  return n / (n + k);
}

/**
 * Blend an `observed` runtime value toward a `prior` by a confidence factor.
 *
 * Low confidence (cold start, few samples) → result stays near `prior`.
 * High confidence → result tracks `observed`.
 */
export function lerp(prior: number, observed: number, confidence: number): number {
  return prior + confidence * (observed - prior);
}
