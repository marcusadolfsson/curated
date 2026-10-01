#!/usr/bin/env bash
# Reverse SSH tunnel: this VM -> Mac over Tailscale.
# Exposes the Instagram API on the Mac's 127.0.0.1:8000.
# The Mac's authorized_keys restricts this key to forwarding only, so -N is
# required (a shell login would be refused).
#
# The Mac's SSH target (user@tailscale-ip) comes from MAC_SSH_TARGET in .env,
# so the address never lands in git.
#
# Usage: ./mac-tunnel.sh {start|stop|restart|status|logs}
set -u
cd "$(dirname "$0")"

if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi
REMOTE="${MAC_SSH_TARGET:-}"
if [ -z "$REMOTE" ]; then
  echo "error: MAC_SSH_TARGET is not set — add it to .env" >&2
  exit 1
fi
REMOTE_HOST="${REMOTE##*@}"

ACTION="${1:-status}"
PIDFILE=.mac-tunnel.pid
LOGFILE=mac-tunnel.log
KEY="$HOME/.ssh/id_ed25519"
PROXY_CMD="python3 $HOME/workspace/instagram-api/tunnel-proxy.py %h %p"

ssh_tunnel() {
  ssh -N -T \
    -o BatchMode=yes \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=10 \
    -o ServerAliveCountMax=3 \
    -o ConnectTimeout=25 \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o "ProxyCommand=$PROXY_CMD" \
    -i "$KEY" \
    -R 8000:127.0.0.1:8000 \
    "$REMOTE"
}

tunnel_pid() {
  pgrep -f "ssh.*-R 8000:127.0.0.1:8000.*$REMOTE_HOST" | head -1
}

case "$ACTION" in
  start)
    if [ -n "$(tunnel_pid)" ]; then
      echo "tunnel already running (ssh pid $(tunnel_pid))"
      exit 0
    fi
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "tunnel supervisor already running (pid $(cat "$PIDFILE")), ssh reconnecting"
      exit 0
    fi
    rm -f "$PIDFILE"  # stale pidfile from a dead supervisor
    if [ -f "$LOGFILE" ]; then
      tail -n 2000 "$LOGFILE" > "$LOGFILE.tmp" && mv "$LOGFILE.tmp" "$LOGFILE"
    fi
    nohup "$0" loop >> "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    echo "tunnel starting (supervisor pid $(cat "$PIDFILE")); watch $LOGFILE"
    ;;
  loop)
    # restart loop: keeps the tunnel alive across drops
    while true; do
      echo "$(date -u +%FT%TZ) starting ssh tunnel" >> "$LOGFILE"
      ssh_tunnel >> "$LOGFILE" 2>&1
      echo "$(date -u +%FT%TZ) tunnel exited ($?), retrying in 10s" >> "$LOGFILE"
      sleep 10
    done
    ;;
  stop)
    pkill -f "ssh.*-R 8000:127.0.0.1:8000.*$REMOTE_HOST" 2>/dev/null && echo "tunnel stopped"
    [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null
    rm -f "$PIDFILE"
    ;;
  restart)
    "$0" stop; sleep 2; "$0" start
    ;;
  status)
    P="$(tunnel_pid)"
    if [ -n "$P" ]; then
      echo "tunnel: running (ssh pid $P)"
    elif [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "tunnel: supervisor running (pid $(cat "$PIDFILE")), ssh reconnecting"
    else
      echo "tunnel: not running"
    fi
    ;;
  logs)
    tail -n "${2:-30}" "$LOGFILE" 2>/dev/null || echo "no log yet"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs [lines]}"
    exit 1
    ;;
esac
