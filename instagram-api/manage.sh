#!/usr/bin/env bash
# Manage the Instagram API server.
# Usage: ./manage.sh {status|start|stop|restart|logs}
set -u
cd "$(dirname "$0")"

PIDFILE=.api.pid
LOG=server.log
PORT="${PORT:-8000}"
if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

api_pid() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    cat "$PIDFILE"
  else
    pgrep -f "[u]vicorn app:app" | head -1
  fi
}

tunnel_cmd() {
  ./mac-tunnel.sh "$@"
}

case "${1:-status}" in
  status)
    PID="$(api_pid)"
    if [ -n "$PID" ]; then
      echo "API: running (pid $PID, port $PORT)"
      curl -s -m 5 "http://127.0.0.1:$PORT/health" || echo "API: process alive but not responding"
      echo
    else
      echo "API: not running"
    fi
    tunnel_cmd status
    ;;
  start)
    if [ -n "$(api_pid)" ]; then echo "API already running"; exit 0; fi
    nohup ./start.sh > "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    echo "API starting (pid $(cat $PIDFILE)). Logs: $LOG"
    ;;
  stop)
    PID="$(api_pid)"
    [ -n "$PID" ] && kill "$PID" 2>/dev/null && echo "API stopped"
    rm -f "$PIDFILE"
    tunnel_cmd stop
    ;;
  restart)
    "$0" stop; sleep 2; "$0" start
    ;;
  logs)
    tail -n "${2:-50}" "$LOG"
    ;;
  *)
    echo "Usage: $0 {status|start|stop|restart|logs [lines]}"
    exit 1
    ;;
esac
