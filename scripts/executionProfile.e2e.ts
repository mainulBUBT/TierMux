// ExecutionProfile: the single resolved decision consumed by loop, router, and prompts —
// strength boundaries, prune-target formula (85% clamped), output-limit defaults, unknown-model
// fallbacks. Pure unit; no vscode APIs touched.
//
// Run:  npm run test:e2e:execution-profile
import {
  resolveExecutionProfile, defaultMaxOutputTokens,
  WEAK_RANK_MIN, STRONG_RANK_MAX, UNKNOWN_RANK, FALLBACK_CONTEXT_WINDOW, PRUNE_TARGET_FRACTION,
} from '../src/agent/executionProfile';
import type { CatalogModel } from '../src/shared/types';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

function model(over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    platform: 'p', modelId: 'm', displayName: 'm',
    intelligenceRank: 3, speedRank: 3, sizeLabel: '', contextWindow: 32768,
    rpmLimit: null, rpdLimit: null, monthlyTokenBudget: '',
    supportsTools: true, supportsVision: false, supportsReasoning: false,
    ...over,
  };
}

function main() {
  const rank1 = resolveExecutionProfile(model({ intelligenceRank: 1 }));
  ok('rank 1 → strong, no weak scaffolding, no judge', rank1.strong && !rank1.useWeakModelScaffolding && !rank1.useAnswerJudge);
  ok('rank 1 ≤ STRONG_RANK_MAX boundary is inclusive', STRONG_RANK_MAX === 2 && rank1.modelRank <= STRONG_RANK_MAX);

  const rank2 = resolveExecutionProfile(model({ intelligenceRank: 2 }));
  ok('rank 2 still strong (boundary)', rank2.strong && !rank2.useAnswerJudge);

  const rank3 = resolveExecutionProfile(model({ intelligenceRank: 3 }));
  ok('rank 3 = weak boundary: scaffold on, judge on, not strong',
    rank3.weak && rank3.useWeakModelScaffolding && rank3.useAnswerJudge && !rank3.strong);
  ok('WEAK_RANK_MIN matches the boundary (3)', WEAK_RANK_MIN === 3);

  const unknown = resolveExecutionProfile(undefined);
  ok('unknown model → UNKNOWN_RANK, weak path, fallback window',
    unknown.modelRank === UNKNOWN_RANK && unknown.useWeakModelScaffolding && unknown.contextWindow === FALLBACK_CONTEXT_WINDOW);

  // ---- prune target: 85% clamped [12k, 120k] ----
  const small = resolveExecutionProfile(model({ contextWindow: 8_192 }));
  const mid = resolveExecutionProfile(model({ contextWindow: 128_000 }));
  const huge = resolveExecutionProfile(model({ contextWindow: 1_000_000 }));
  ok('small window clamps up to 12k floor', small.pruneTarget === 12_000);
  ok('mid window ≈ 85% (128k → 108800, within clamp)', mid.pruneTarget === Math.floor(128_000 * PRUNE_TARGET_FRACTION));
  ok('huge window clamps down to 120k ceiling', huge.pruneTarget === 120_000);
  ok('the old 40% formula is gone (mid would have been 51200)', mid.pruneTarget > 51_200);

  // ---- output limits: raised floor, declared cap wins ----
  ok('non-reasoning floor 8192 (old 4096 gone)', defaultMaxOutputTokens(model()) === 8_192);
  ok('reasoning floor 16384 (old 8192 gone)', defaultMaxOutputTokens(model({ supportsReasoning: true })) === 16_384);
  ok('declared cap below floor caps it', defaultMaxOutputTokens(model({ outputTokenLimit: 4_096 })) === 4_096);
  ok('declared cap above floor uses the floor', defaultMaxOutputTokens(model({ outputTokenLimit: 65_536 })) === 8_192);
  ok('reasoning cap respected (gemini-style 65536 → 16384 floor)',
    defaultMaxOutputTokens(model({ supportsReasoning: true, outputTokenLimit: 65_536 })) === 16_384);
  ok('unknown model → plain floor', defaultMaxOutputTokens(undefined) === 8_192);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
