set -euo pipefail
# Repo root relative to this script — works from any clone (the old hardcoded
# absolute path only existed on the machine this script was written on).
cd "$(dirname "$0")/.."
RGV=1.18.0
# Version comes from package.json so the VSIX filenames never lag a bump.
VER=$(node -p "require('./package.json').version")
OUT=release; mkdir -p "$OUT"
TMP=$(mktemp -d)
# Targets come from scripts/release-targets.json, shared with packageAllTargets.mjs — the two
# scripts used to keep private lists and had drifted to 6 and 4 targets. Each line is
# "<vscode-target> <ripgrep-suffix>"; the two differ for linux-armhf and both alpine targets
# (see the _comment in that file for why the RUNTIME name is what matters).
PAIRS=$(node -p "require('./scripts/release-targets.json').targets.map(t => t.target + ' ' + t.rg).join('\n')")
TARGETS=$(echo "$PAIRS" | awk '{print $1}')

# Fail loudly instead of letting vsce die with an opaque "include pattern does not match".
# tsconfig.lib.json is incremental: a stale .cache/lib.tsbuildinfo makes tsc skip emitting
# declarations that `files` promises, and every target then fails identically (2026-08-31).
for f in dist/extension.js dist/index.d.ts dist/router/index.d.ts dist/agent/index.d.ts \
         dist/providers/index.d.ts dist/shared/index.d.ts; do
  [ -f "$f" ] || { echo "missing build artifact: $f — run: npm run build" >&2; exit 1; }
done

# Pre-fetch each distinct ripgrep package once — alpine-x64 reuses linux-x64's, alpine-arm64
# reuses linux-arm64's, so the fetch list is shorter than the target list.
for rg in $(echo "$PAIRS" | awk '{print $2}' | sort -u); do
  if [ ! -d "$TMP/$rg" ]; then
    ( cd "$TMP" && npm pack "@vscode/ripgrep-$rg@$RGV" >/dev/null 2>&1 \
      && mkdir -p "$rg" && tar xzf "vscode-ripgrep-$rg-$RGV.tgz" -C "$rg" --strip-components=1 )
  fi
  [ -f "$TMP/$rg/bin/rg" ] || [ -f "$TMP/$rg/bin/rg.exe" ] \
    && echo "fetched  @vscode/ripgrep-$rg" \
    || { echo "MISSING  @vscode/ripgrep-$rg — cannot build the targets that need it" >&2; exit 1; }
done

echo "$PAIRS" | while read -r t rg; do
  [ -n "$t" ] || continue
  # Only ONE binary may be present, or every VSIX ships all of them. The directory is named
  # after the RIPGREP package, not the target: that is the name lib/index.js resolves at runtime.
  rm -rf node_modules/@vscode/ripgrep-*
  cp -R "$TMP/$rg" "node_modules/@vscode/ripgrep-$rg"
  npx vsce package --target "$t" --no-dependencies=false -o "$OUT/tiermux-$VER-$t.vsix" >/dev/null 2>&1 \
    || npx vsce package --target "$t" -o "$OUT/tiermux-$VER-$t.vsix" 2>&1 | tail -3
done

# Restore this machine's own binary so local dev still works.
rm -rf node_modules/@vscode/ripgrep-*
cp -R "$TMP/darwin-arm64" node_modules/@vscode/ripgrep-darwin-arm64
rm -rf "$TMP"
