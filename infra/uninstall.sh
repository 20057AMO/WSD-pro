#!/usr/bin/env bash
# ──────────────────────────────────────────────
# WSD-Pro uninstall.sh — removes app, containers, data
#   sudo bash infra/uninstall.sh
# ──────────────────────────────────────────────
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/versions.env"

echo "═══════════════════════════════════════════"
echo "  WSD-Pro uninstall"
echo "  This will REMOVE:"
echo "    • WSD-Pro containers (projects + IDE)"
echo "    • $APP_DIR"
echo "    • $DATA_DIR (workspaces, chats, users!)"
echo "  Caddy + Ollama are kept installed."
echo "═══════════════════════════════════════════"
read -r -p "Type YES to continue: " confirm
if [ "$confirm" != "YES" ]; then
  echo "Aborted."
  exit 1
fi

systemctl disable --now wsd-pro-backend 2>/dev/null || true

docker rm -f "$(docker ps -aq --filter label=wsd.managed)" 2>/dev/null || true
docker rmi "$WS_WORKSPACE_IMAGE" 2>/dev/null || true

rm -rf "$APP_DIR" "$DATA_DIR"
rm -f /etc/systemd/system/wsd-pro-backend.service
systemctl daemon-reload

echo "✅ WSD-Pro uninstalled."
echo "   (Optional: sudo apt remove caddy; remove Ollama via https://ollama.com/install.sh --uninstall)"