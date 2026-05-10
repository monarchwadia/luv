#!/usr/bin/env bash
# Reproduce the bundle-size benchmarks. Requires bun installed.
set -e
cd "$(dirname "$0")"

BUN="${BUN:-$HOME/.bun/bin/bun}"
LUV_DIST=/workspaces/luv/lib/js/dist

if [ ! -d "$LUV_DIST" ]; then
  echo "missing $LUV_DIST — run 'make js' from repo root first" >&2
  exit 1
fi

echo "## Install size + dep count"
echo
echo "luv-js (dist):  $(du -sh "$LUV_DIST" | cut -f1)  — 0 deps"
echo "node_modules: $(du -sh node_modules | cut -f1)  — $(ls node_modules/ | grep -v '^\.' | wc -l) packages"
echo
echo "## Bundled size (minified, browser target)"
echo
"$BUN" build vercel-app.ts --minify --outfile=/tmp/vercel.js >/dev/null 2>&1
"$BUN" build openai-sdk-app.ts --minify --outfile=/tmp/openai.js >/dev/null 2>&1
"$BUN" build luv-app.ts --minify --outfile=/tmp/luv.js >/dev/null 2>&1

VC=$(stat -c %s /tmp/vercel.js)
OS=$(stat -c %s /tmp/openai.js)
LV=$(stat -c %s /tmp/luv.js)

awk -v VC="$VC" -v OS="$OS" -v LV="$LV" 'BEGIN {
  printf "vercel-ai-sdk: %12d bytes (%4.1fx luv)\n", VC, VC/LV
  printf "openai-sdk:    %12d bytes (%4.1fx luv)\n", OS, OS/LV
  printf "luv-js:        %12d bytes (1.0x)\n", LV
}'
