#!/usr/bin/env bash
#
# Does a provider/model ACTUALLY return tool calls?
#
# The catalog carries `supportsTools: true` per model, and the router trusts it when picking a
# model for a tool-using turn. That flag is metadata, not a measurement — a model whose API
# accepts a `tools` array and then never emits a tool call looks identical to a healthy one from
# the router's point of view, and the whole turn silently degrades into "answered from memory".
# Observed 2026-08-16: a full 24-query bench on cloudflare::@cf/qwen/qwen2.5-coder-32b-instruct
# produced 0 tool calls across every single query.
#
# This probes both transports, because they fail differently and the fix differs:
#   - non-stream returns tool_calls, stream does not  → our SSE parsing drops them (our bug)
#   - neither returns tool_calls                      → the model/endpoint can't tool-call
#                                                       (catalog flag is wrong; fix the catalog)
#
# Usage (never paste the token into a chat):
#   export BENCH_KEY_CLOUDFLARE='<account_id>:<api_token>'
#   bash scripts/bench/probe-tools.sh
#   bash scripts/bench/probe-tools.sh '@cf/zai-org/glm-5.2'    # probe a different model
#
# Prints only diagnostics. The token is never echoed.

set -uo pipefail

MODEL="${1:-@cf/qwen/qwen2.5-coder-32b-instruct}"
KEY="${BENCH_KEY_CLOUDFLARE:-}"
if [ -z "$KEY" ]; then
  echo "BENCH_KEY_CLOUDFLARE is not set (format: account_id:api_token)." >&2
  exit 1
fi
ACCOUNT="${KEY%%:*}"
TOKEN="${KEY#*:}"
if [ "$ACCOUNT" = "$KEY" ] || [ -z "$TOKEN" ]; then
  echo "Key must be 'account_id:api_token'." >&2
  exit 1
fi
URL="https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1/chat/completions"

# A prompt that is unanswerable without the tool, so a model that CAN call one will.
read -r -d '' TOOLS <<'JSON' || true
[{"type":"function","function":{
  "name":"readFile",
  "description":"Read a file from the project. Use this whenever asked about file contents.",
  "parameters":{"type":"object","properties":{"path":{"type":"string","description":"Path to read"}},"required":["path"]}
}}]
JSON

payload() {
  local stream="$1"
  cat <<JSON
{"model":$(printf '%s' "$MODEL" | sed 's/.*/"&"/'),
 "messages":[{"role":"user","content":"What is on line 1 of src/agent/core/loop.ts? You must use the readFile tool - do not guess."}],
 "tools":${TOOLS},
 "tool_choice":"auto",
 "max_tokens":256,
 "stream":${stream}}
JSON
}

echo "model:   $MODEL"
echo "account: ${ACCOUNT:0:6}…(redacted)"
echo ""

echo "──────── non-streaming ────────"
NS=$(curl -sS -X POST "$URL" \
  -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
  -d "$(payload false)" 2>&1)
if printf '%s' "$NS" | grep -q '"tool_calls"'; then
  echo "✓ tool_calls PRESENT"
  printf '%s' "$NS" | tr ',' '\n' | grep -i '"name"' | head -3
else
  echo "✗ NO tool_calls"
  printf '%s' "$NS" | head -c 500; echo
fi

echo ""
echo "──────── streaming ────────"
ST=$(curl -sS -N -X POST "$URL" \
  -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
  -d "$(payload true)" 2>&1 | head -c 4000)
if printf '%s' "$ST" | grep -q 'tool_calls'; then
  echo "✓ tool_calls PRESENT in the SSE deltas"
else
  echo "✗ NO tool_calls in the SSE deltas"
fi
echo "first SSE lines:"
printf '%s' "$ST" | head -5

echo ""
echo "──────── verdict ────────"
NS_OK=$(printf '%s' "$NS" | grep -c '"tool_calls"' || true)
ST_OK=$(printf '%s' "$ST" | grep -c 'tool_calls' || true)
# Check for a failed request BEFORE interpreting the absence of tool calls. An errored request
# has no tool calls either, and reading that as "the model can't tool-call" is a wrong and
# expensive conclusion — it sends you to edit the catalog when the real answer is "out of quota".
# This exact misread happened on 2026-08-16 against a spent Cloudflare neuron allocation.
ERR=$(printf '%s\n%s' "$NS" "$ST" | grep -oiE '"message" *: *"[^"]{0,160}' | head -2 || true)
if printf '%s\n%s' "$NS" "$ST" | grep -qiE '"success" *: *false|"errors" *:|error|quota|allocation|unauthorized|rate.?limit'; then
  echo "INCONCLUSIVE — the request itself failed, so tool support was never exercised."
  [ -n "$ERR" ] && echo "provider said: $ERR"
  echo "Fix the request (quota / key / model id), then re-run this probe."
  exit 2
fi
if [ "$NS_OK" -gt 0 ] && [ "$ST_OK" -eq 0 ]; then
  echo "SSE parsing drops tool calls — OUR bug (src/providers/base.ts readSseStream)."
elif [ "$NS_OK" -eq 0 ]; then
  echo "Model/endpoint does not emit tool calls — catalog supportsTools:true is WRONG for $MODEL."
  echo "The router will keep picking it for tool turns. Fix the catalog or pick another model."
else
  echo "Tool calling works on both transports — a zero-tool bench run has another cause."
fi
