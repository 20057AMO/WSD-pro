#!/usr/bin/env bash
# ──────────────────────────────────────────────
# WSD-Pro update.sh — pull latest, rebuild, restart
#   cd /path/to/WSD-pro   (your clone)
#   sudo bash infra/update.sh
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

if [ ! -d "$APP_DIR/.git" ]; then
  echo "❌ Not a git clone: $APP_DIR" >&2
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