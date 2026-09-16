// How a model id folds to "the same model". Three places have to agree on this: sync-catalog
// stamps the tier under this key, canonicalModelId() in src/router/picker.ts ranks and rotates
// under it, and modelTierKey() in tiermux-admin/src/lib/utils.js builds the table itself. Let
// them drift and a model is tiered under one key and ranked under another. No imports on
// purpose — the routing-gates e2e bundles this to CJS to assert the agreement.
//
// A trailing auto/free/default/router segment names a routing policy rather than a model, and
// which policy it is depends on the namespace in front of it, so that one keeps its prefix.
// Everything else is spelling: separators fold to "-", the separator before a version number
// goes away ("qwen-3.8-27b" == "qwen3.8-27b"), and serving modes ("-thinking", "-search",
// "-instruct") come off, because UnoRouter lists one GLM under four suffixes and they are all
// the same weights.
const ROUTER_SENTINEL = /^(auto|free|default|router)$/;

export function modelTierKey(id) {
  let s = String(id || '').toLowerCase().replace(/:free$|:latest$|:floor$|:exp$|-free$/g, '');
  if (s.indexOf('/') !== -1) {
    const tail = s.slice(s.lastIndexOf('/') + 1);
    if (!ROUTER_SENTINEL.test(tail)) s = tail;
  }
  s = s.replace(/@.*$/, '').replace(/[._:]/g, '-').replace(/-+/g, '-');
  let prev;
  do { prev = s; s = s.replace(/-(think-search|thinking|search|instruct|it)$/, ''); } while (s !== prev);
  return s.replace(/-+(?=\d)/g, '');
}
