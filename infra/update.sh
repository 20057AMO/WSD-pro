#!/usr/bin/env bash
# ──────────────────────────────────────────────
# WSD-Pro update.sh — pull latest, rebuild, restart
#   sudo bash infra/update.sh
# ──────────────────────────────────────────────
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/versions.env"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "App is not a git checkout ($APP_DIR) — update manually." >&2
  exit 1
fi

cd "$APP_DIR"
git pull --ff-only

cd backend
npm install >/dev/null
npm run build
systemctl restart wsd-pro-backend

echo "✅ WSD-Pro updated and restarted."
echo "   systemctl status wsd-pro-backend"