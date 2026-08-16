#!/usr/bin/env bash
#
# A/B the late re-anchoring feature (src/agent/core/anchors.ts) on the quality bench.
#
# Why a script rather than two commands: an A/B is only meaningful if BOTH arms run on the same
# commit, the same dataset, the same pinned agent model and the same pinned judge, differing in
# exactly one variable. Typing that twice by hand is how an arm silently drifts.
#
# Why Cloudflare: every previous quality run died on free-tier rate limits — 4/24 queries were
# lost even with retries on 2026-08-16, and the harness correctly refused to call that a baseline.
# Cloudflare Workers AI allows 300 rpm / 432k rpd, ~5x the best keyless option, which removes
# quota as a confound. It also lets the judge be a rank-1 model: grading a weak model's answer
# with another weak model measures very little.
#
# Usage (run in YOUR terminal — never paste the token into a chat or commit it):
#
#   export BENCH_KEY_CLOUDFLARE='<account_id>:<api_token>'
#   bash scripts/bench/ab-reanchor.sh
#
# Results land in .benchmarks/quality/ as two run JSONs, then a compare is printed.

set -euo pipefail
cd "$(dirname "$0")/../.."

if [ -z "${BENCH_KEY_CLOUDFLARE:-}" ]; then
  echo "BENCH_KEY_CLOUDFLARE is not set." >&2
  echo "  export BENCH_KEY_CLOUDFLARE='<account_id>:<api_token>'" >&2
  echo "Get one at https://dash.cloudflare.com/profile/api-tokens (Workers AI read+run)." >&2
  exit 1
fi
case "$BENCH_KEY_CLOUDFLARE" in
  *:*) ;;
  *) echo "Key must be 'account_id:api_token' (see src/providers/cloudflare.ts parseKey)." >&2; exit 1 ;;
esac

# Pinned on purpose. --model auto picks a different model per query, which makes two runs
# incomparable — the harness prints that warning itself.
AGENT_MODEL="cloudflare::@cf/qwen/qwen2.5-coder-32b-instruct"   # rank 2, coder-tagged, 131k ctx
JUDGE_MODEL="cloudflare::@cf/openai/gpt-oss-120b"               # rank 1 — the strongest judge available
DELAY_MS=1500      # 300 rpm is ~5 req/s; this stays well clear without wasting wall-clock
RETRIES=3

run_arm() {
  local value="$1" variant="$2"
  echo ""
  echo "════════ arm: $variant (reanchorChars=$value) ════════"
  TIERMUX_REANCHOR="$value" npm run bench:quality -- \
    --model "$AGENT_MODEL" \
    --judge "$JUDGE_MODEL" \
    --platforms cloudflare \
    --variant "$variant" \
    --delay "$DELAY_MS" \
    --retries "$RETRIES"
}

# Control first so a mid-run failure still leaves the more informative arm unrun (and obvious).
run_arm 0 reanchor-off
run_arm 6000 reanchor-on

echo ""
echo "════════ compare ════════"
# compareQuality takes two FILE PATHS, not --before/--after flags. Pick the newest run JSON per
# variant so a re-run of one arm compares against the latest, not a stale file.
newest_for() { ls -t .benchmarks/quality/*"-$1.json" 2>/dev/null | head -1; }
BEFORE="$(newest_for reanchor-off)"
AFTER="$(newest_for reanchor-on)"
if [ -z "$BEFORE" ] || [ -z "$AFTER" ]; then
  echo "Could not find both run JSONs in .benchmarks/quality/ — compare skipped." >&2
  exit 1
fi
echo "before: $BEFORE"
echo "after:  $AFTER"
# Exit code is the merge gate (0 = MERGE, 1 = REJECT), so don't swallow it.
npm run bench:quality:compare -- "$BEFORE" "$AFTER"
