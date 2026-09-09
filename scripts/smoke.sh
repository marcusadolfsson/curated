#!/usr/bin/env bash
# Boots the assembled bundle somewhere it cannot cheat, and asks it a question.
#
# The bundle is normally built at dist/server, inside the repo - and Node
# resolves a missing module by walking up the directory tree, so anything the
# trace left out was quietly found in ../../node_modules. It looked complete for
# as long as it stayed where it was built. Copied into an app bundle, with no
# parent to borrow from, the server exited on the first request.
#
# So this copies it out to a temporary directory first. Anything missing fails
# here rather than after installing.
#
# Usage: scripts/smoke.sh [bundle] [port]
set -euo pipefail

cd "$(dirname "$0")/.."
SRC="${1:-dist/server}"
PORT="${2:-3009}"
NODE="${NODE_BIN:-$(./scripts/fetch-node.sh)/bin/node}"

[ -f "$SRC/server.js" ] || { echo "No server.js in $SRC" >&2; exit 1; }

WORK="$(mktemp -d /tmp/curated-smoke.XXXXXX)"
cleanup() {
  [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "Copying the bundle to $WORK"
cp -R "$SRC" "$WORK/server"

# A data directory of its own: this must never touch the real database or the
# real Instagram session, and starting a second server against those is the one
# thing this app must not do.
DATA="$WORK/data"

cd "$WORK/server"
DATA_DIR="$DATA" MIGRATIONS_DIR="$WORK/server/drizzle" \
  PORT="$PORT" HOSTNAME=127.0.0.1 NODE_ENV=production \
  "$NODE" server.js > "$WORK/out.log" 2>&1 &
PID=$!

for _ in $(seq 1 40); do
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/watch" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# /api/watch is served by the framework's own route handling; a page and a
# route go through different runtimes and only one of them was missing last
# time, so ask for both.
fail() { echo "FAILED: $1"; echo "--- log ---"; tail -30 "$WORK/out.log"; exit 1; }

curl -fsS -m 10 "http://127.0.0.1:$PORT/api/watch" >/dev/null || fail "/api/watch"
curl -fsS -m 15 "http://127.0.0.1:$PORT/api/posts?state=all" >/dev/null || fail "/api/posts"
curl -fsS -m 15 "http://127.0.0.1:$PORT/" >/dev/null || fail "the index page"

# The database it just made should have the whole schema in it, not an empty
# file: a missing migrations folder used to pass in silence.
TABLES="$("$NODE" -e '
const D = require(process.argv[2] + "/node_modules/better-sqlite3");
const d = new D(process.argv[1], { readonly: true });
console.log(d.prepare("select count(*) c from sqlite_master where type=?").get("table").c);
' "$DATA/insta.db" "$WORK/server")"
[ "$TABLES" -ge 5 ] || fail "only $TABLES tables in a fresh database"

echo "Smoke test passed: routes, pages and a migrated database from $SRC"
