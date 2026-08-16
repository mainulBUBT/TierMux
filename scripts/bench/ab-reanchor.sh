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

# Provider choice, and why it is NOT Cloudflare.
#
# Cloudflare looks best in the catalog (300 rpm / 432k rpd) and is the worst choice in practice:
# its free tier meters COMPUTE, not requests — 10,000 neurons/day — and the catalog has no field
# for that. A 24-query run on a 32B model exhausted the whole daily allocation and produced a run
# with 0 tool calls on every query. Trust catalog rpm/rpd only for providers that actually bill by
# request.
#
# Two arms x 24 queries x ~10 requests/turn is ~480 requests, so rpd is the binding number.
#   cerebras gpt-oss-120b  30 rpm / 14,400 rpd  rank 2   <- default here, ample margin
#   agnes    2.0-flash     20 rpm / 28,800 rpd  rank 2   <- more rpd, less rpm
#   groq     gpt-oss-120b  30 rpm /  1,000 rpd  rank 2   <- tight: ~480 of 1,000 in one A/B
#   kilo     nemotron      3 rpm  /  4,800 rpd  rank 1   <- 3 rpm cannot serve a tool-heavy turn
# Override either model by exporting AGENT_MODEL / JUDGE_MODEL before running.
PLATFORM="${BENCH_PLATFORM:-cerebras}"
KEY_VAR="BENCH_KEY_$(printf '%s' "$PLATFORM" | tr '[:lower:]' '[:upper:]')"
if [ -z "${!KEY_VAR:-}" ]; then
  echo "$KEY_VAR is not set." >&2
  echo "  export $KEY_VAR='<your-key>'" >&2
  echo "Or pick another provider: BENCH_PLATFORM=agnes|groq|cerebras bash $0" >&2
  exit 1
fi

# Pinned on purpose. --model auto picks a different model per query, which makes two runs
# incomparable — the harness prints that warning itself.
AGENT_MODEL="${AGENT_MODEL:-cerebras::gpt-oss-120b}"
JUDGE_MODEL="${JUDGE_MODEL:-cerebras::gpt-oss-120b}"
DELAY_MS="${DELAY_MS:-2500}"   # 30 rpm = 1 req/2s; this keeps a margin for multi-request turns
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
