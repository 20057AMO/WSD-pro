#!/usr/bin/env bash
# ──────────────────────────────────────────────
# WSD-Pro uninstall.sh — removes app, containers, data
#   sudo bash /path/to/WSD-pro/infra/uninstall.sh
# ──────────────────────────────────────────────
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/versions.env"
APP_DIR="$ROOT_DIR"

echo "═══════════════════════════════════════════"
echo "  WSD-Pro uninstall"
echo "  This will REMOVE:"
echo "    • WSD-Pro containers (projects + IDE)"
echo "    • $DATA_DIR (workspaces, chats, users, credentials!)"
echo "    • $APP_DIR (this clone + built files)"
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

rm -rf "$DATA_DIR"
rm -f /etc/systemd/system/wsd-pro-backend.service
systemctl daemon-reload

echo ""
echo "✅ WSD-Pro removed: containers, data, service."
echo "   The clone still exists at $APP_DIR — delete it manually if you want:"
echo "     rm -rf \"$APP_DIR\""
echo "   (Optional: sudo apt remove caddy; ollama uninstall via ollama.com/install.sh)"