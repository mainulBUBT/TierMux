set -euo pipefail
cd /Users/mainul/Lerd/TierMux
RGV=1.18.0
OUT=release; mkdir -p "$OUT"
TMP=$(mktemp -d)
TARGETS="darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64 win32-arm64"

# Fail loudly instead of letting vsce die with an opaque "include pattern does not match".
# tsconfig.lib.json is incremental: a stale .cache/lib.tsbuildinfo makes tsc skip emitting
# declarations that `files` promises, and every target then fails identically (2026-08-31).
for f in dist/extension.js dist/index.d.ts dist/router/index.d.ts dist/agent/index.d.ts \
         dist/providers/index.d.ts dist/shared/index.d.ts; do
  [ -f "$f" ] || { echo "missing build artifact: $f — run: npm run build" >&2; exit 1; }
done

# Pre-fetch every platform's ripgrep binary once.
for t in $TARGETS; do
  if [ ! -d "$TMP/$t" ]; then
    ( cd "$TMP" && npm pack "@vscode/ripgrep-$t@$RGV" >/dev/null 2>&1 \
      && mkdir -p "$t" && tar xzf "vscode-ripgrep-$t-$RGV.tgz" -C "$t" --strip-components=1 )
  fi
  [ -d "$TMP/$t" ] && echo "fetched  $t" || echo "MISSING  $t"
done

for t in $TARGETS; do
  # Only this target's binary may be present, or every VSIX ships all six.
  rm -rf node_modules/@vscode/ripgrep-*
  cp -R "$TMP/$t" "node_modules/@vscode/ripgrep-$t"
  npx vsce package --target "$t" --no-dependencies=false -o "$OUT/tiermux-3.0.0-$t.vsix" >/dev/null 2>&1 \
    || npx vsce package --target "$t" -o "$OUT/tiermux-3.0.0-$t.vsix" 2>&1 | tail -3
done

# Restore this machine's own binary so local dev still works.
rm -rf node_modules/@vscode/ripgrep-*
cp -R "$TMP/darwin-arm64" node_modules/@vscode/ripgrep-darwin-arm64
rm -rf "$TMP"
