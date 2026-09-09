#!/usr/bin/env bash
# Assembles a runnable server out of a finished `next build`.
#
# `output: "standalone"` traces what the server actually imports and leaves the
# rest of node_modules behind, but it does not produce something runnable on its
# own. Three things have to be put back:
#
#   .next/static   Next expects to serve it from beside the traced server
#   public/        the same
#   drizzle/       migrations, run at startup; MIGRATIONS_DIR points at them
#
# and one thing has to be put in that the trace cannot see at all: the Agent
# SDK's platform binary. It is an optional dependency picked by platform at
# runtime, so nothing statically imports it and the tracer never learns it
# exists. Without it the app runs and quietly cannot describe anything.
#
# Usage: scripts/bundle.sh [destination]   (default: dist/server)
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="${1:-dist/server}"

[ -d .next/standalone ] || {
  echo "No .next/standalone. Run 'npm run build' first, with output: 'standalone'." >&2
  exit 1
}

rm -rf "$OUT"
mkdir -p "$OUT"

cp -R .next/standalone/. "$OUT/"
mkdir -p "$OUT/.next"
cp -R .next/static "$OUT/.next/static"
[ -d public ] && cp -R public "$OUT/public"
cp -R drizzle "$OUT/drizzle"

# Packages the trace cannot get right, copied whole.
#
# The tracer follows imports, so it takes a package's JavaScript and leaves the
# files that package reads at runtime. playwright-core loads browsers.json to
# find out which Chromium it wants, and the traced copy did not have it: the
# app started, the watcher could not open a browser, and the only sign was a
# module-not-found in the log. Copying the whole package is a few megabytes
# against a failure that looks like something else entirely.
for whole in playwright playwright-core; do
  if [ -d "node_modules/$whole" ]; then
    rm -rf "${OUT:?}/node_modules/$whole"
    cp -R "node_modules/$whole" "$OUT/node_modules/$whole"
  fi
done

# Next's own server runtimes, all of them.
#
# The trace picks the ones it can see being imported and misses the rest -
# app-route-turbo was absent, which is every API route in this app. It did not
# show up in testing because the bundle was sitting inside the repo, so Node
# resolved the missing file by walking up into ../../node_modules. Out of the
# repo and inside an app bundle there is no parent to walk up to, and the
# server exits on the first request. 3 MB to not depend on where it is run
# from.
RUNTIMES="node_modules/next/dist/compiled/next-server"
if [ -d "$RUNTIMES" ]; then
  mkdir -p "$OUT/$RUNTIMES"
  cp "$RUNTIMES"/*.runtime.prod.js "$OUT/$RUNTIMES/"
fi

# The Agent SDK's runtime, for this machine's architecture. Named rather than
# globbed: shipping every platform's copy would add most of a gigabyte, and
# shipping none is the failure this exists to prevent.
SDK_PLATFORM="@anthropic-ai/claude-agent-sdk-$(node -p 'process.platform + "-" + process.arch')"
if [ -d "node_modules/$SDK_PLATFORM" ]; then
  mkdir -p "$OUT/node_modules/@anthropic-ai"
  cp -R "node_modules/$SDK_PLATFORM" "$OUT/node_modules/@anthropic-ai/"
else
  echo "WARNING: $SDK_PLATFORM is not installed." >&2
  echo "The bundle will run but will not be able to describe posts." >&2
fi

# Prune what the tracer swept up.
#
# next.config.ts asks for these to be excluded and the Turbopack build ignores
# the request: the previous bundle ended up inside the next one, and the local
# editor settings came along too. Pruning here is not elegant but it does not
# depend on the tracer behaving.
for stray in dist data docs menubar .git .claude; do
  rm -rf "${OUT:?}/$stray"
done

# The one that must never ship. A bundle carrying data/ carries a live
# Instagram session and the whole database to wherever it is installed, so this
# is a hard stop rather than another line of pruning.
if [ -e "$OUT/data" ] || find "$OUT" -name "instagram.json" -print -quit | grep -q .; then
  echo "REFUSING: the bundle contains session or database files." >&2
  exit 1
fi

echo "Bundled into $OUT ($(du -sh "$OUT" | cut -f1))"
