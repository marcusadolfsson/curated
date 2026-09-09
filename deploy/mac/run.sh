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
export DATA_DIR="$PWD/data"
export PORT="${PORT:-3000}"
# Each post is described by its own agent process; three at once is what the
# cloud box ran and a Mac mini handles it comfortably.
export ANALYSIS_CONCURRENCY="${ANALYSIS_CONCURRENCY:-3}"

# Next directly, not through npx.
#
# launchd signals the process it started, and `npx next start` made that npm,
# with the server as its child. npm does not pass SIGTERM on before it goes, so
# a stop never reached the handler that saves the live cookies and closes the
# browser - the app was killed outright and went back to whatever was last
# written when the inbox loaded. Running the server as the process launchd
# supervises puts the signal where the handler is.
exec node node_modules/next/dist/bin/next start -p "$PORT" -H 127.0.0.1
