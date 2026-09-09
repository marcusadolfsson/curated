#!/bin/bash
# Starts Curated. launchd runs this; it exists so the plist does not have to
# carry a PATH that works for Homebrew, nvm and a system node all at once.
set -euo pipefail

cd "$(dirname "$0")/../.."

# Node 22 first, deliberately. Homebrew's current node is 26, and
# better-sqlite3 has no prebuilt binary for it and fails to build from source
# against its headers - so a plain `brew install node` leaves the app unable to
# open its own database.
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# The analysis agent's credentials.
#
# On Linux the SDK finds ~/.claude/.credentials.json. macOS keeps its login in
# the keychain instead, which a launchd job cannot read reliably and a rebooted
# machine has no access to at all until someone signs in at the console. So a
# long-lived token from `claude setup-token` is read from a file outside the
# repo, kept at mode 600, and never committed.
TOKEN_FILE="$HOME/.curated/claude-token"
if [ -r "$TOKEN_FILE" ]; then
  CLAUDE_CODE_OAUTH_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
  export CLAUDE_CODE_OAUTH_TOKEN
fi

export NODE_ENV=production
# Out of the checkout, where a macOS app keeps its data.
#
# It used to be ./data, which put a live session, a database and Chromium's
# profile inside the thing that gets built and copied. The build tracer walked
# into it and pulled 83 MB of it into the output - so a bundle would have
# carried the Instagram session wherever it was installed. It also means the
# repo can be deleted and rebuilt without taking the data with it.
export DATA_DIR="${DATA_DIR:-$HOME/Library/Application Support/Curated}"
SERVER="$PWD/dist/server"
export MIGRATIONS_DIR="$SERVER/drizzle"
export PORT="${PORT:-3000}"
# Each post is described by its own agent process; three at once is what the
# cloud box ran and a Mac mini handles it comfortably.
export ANALYSIS_CONCURRENCY="${ANALYSIS_CONCURRENCY:-3}"

# The assembled server, run directly.
#
# Two reasons it is not `npx next start`. launchd signals the process it
# started, and npx made that npm, with the server as its child; npm goes
# without passing SIGTERM on, so the handler that closes the browser never
# heard it. And this is the same artifact the app bundle carries - one thing
# that gets built and run, rather than a checkout here and a bundle there.
[ -d "$SERVER" ] || {
  echo "No $SERVER. Run 'npm run build' then 'scripts/bundle.sh'." >&2
  exit 1
}
cd "$SERVER"
export HOSTNAME=127.0.0.1
exec node server.js
