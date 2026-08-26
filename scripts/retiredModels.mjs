/**
 * Models the remote worker still serves but the UPSTREAM provider has already retired — the
 * live validator (validate-catalog.mjs) proves they're absent from the provider's own public
 * list, so serving them is a guaranteed failure. Shared by:
 *   - scripts/sync-catalog.mjs  → dropped from the bundled catalog at every sync, so
 *                                 `npm run build` can't re-add them;
 *   - scripts/validate-catalog.mjs → skipped in the live existence check (the worker's stale
 *                                 row is not a bundled defect).
 * Remove an entry ONLY after confirming the model is served upstream again.
 */
export const RETIRED_MODEL_KEYS = new Set([
  'nvidia||deepseek-ai/deepseek-r1',
  'nvidia||meta/llama-3.1-405b-instruct',
  'nvidia||qwen/qwen2.5-72b-instruct',
  'nvidia||google/gemma-4-31b',
  'nvidia||minimax/minimax-m2.7',
  'nvidia||nvidia/nemoretriever-parse',
  'nvidia||nvidia/nv-embedcode-7b-v1',
  'nvidia||nvidia/nv-embedqa-e5-v5',
  'nvidia||thinkingmachines/inkling',
]);
