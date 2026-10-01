#!/usr/bin/env bash
# Start the Instagram API. Generates an API key on first run (saved in .env).
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .venv/bin/uvicorn ]; then
  echo "Creating virtualenv and installing dependencies..."
  python3 -m venv .venv
  .venv/bin/pip install --quiet -r requirements.txt
fi

if [ ! -f .env ]; then
  KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  printf 'IG_API_KEY=%s\nPORT=8000\n' "$KEY" > .env
  echo "Generated a new API key and saved it to .env"
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

echo "Starting Instagram API on http://127.0.0.1:${PORT}"
echo "Docs: http://127.0.0.1:${PORT}/docs"
exec .venv/bin/uvicorn app:app --host 0.0.0.0 --port "${PORT}"
