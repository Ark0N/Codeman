#!/usr/bin/env bash
# Quick Cloudflare Tunnel for Codeman
# Usage: ./scripts/tunnel.sh [start|stop|status|url]
set -euo pipefail

SERVICE="codeman-tunnel"

case "${1:-start}" in
  start)
    if ! systemctl --user is-active "$SERVICE" &>/dev/null; then
      # Install service if not already
      if ! systemctl --user cat "$SERVICE" &>/dev/null 2>&1; then
        cp "$(dirname "$0")/codeman-tunnel.service" "$HOME/.config/systemd/user/"
        systemctl --user daemon-reload
      fi
      systemctl --user start "$SERVICE"
      echo "Tunnel starting... waiting for URL"
      sleep 6
    fi
    # Extract the tunnel URL from journal
    URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$HOME/.codeman/tunnel.log" 2>/dev/null | tail -1)
    if [ -n "$URL" ]; then
      echo "$URL"
    else
      echo "URL not ready yet, try: $0 url"
    fi
    ;;
  stop)
    systemctl --user stop "$SERVICE"
    echo "Tunnel stopped"
    ;;
  status)
    systemctl --user status "$SERVICE" --no-pager 2>&1 | head -10
    echo ""
    echo "URL:"
    grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$HOME/.codeman/tunnel.log" 2>/dev/null | tail -1
    ;;
  url)
    grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$HOME/.codeman/tunnel.log" 2>/dev/null | tail -1
    ;;
  *)
    echo "Usage: $0 [start|stop|status|url]"
    exit 1
    ;;
esac
