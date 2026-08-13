# ──────────────────────────────────────────────────────────────
# WSD-Pro install.sh — CasaOS-style one-command installer
#
#   curl -fsSL https://raw.githubusercontent.com/20057AMO/WSD-pro/main/infra/install.sh | sudo bash
#   # or from a checkout:
#   sudo bash infra/install.sh [--with-ollama]
#
# Detects LAN + Tailscale IPs, installs Docker/Node/Caddy, builds the
# workspace image, creates the backend service, and prints access URLs.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

# ── Options ───────────────────────────────────────────────────
WITH_OLLAMA=0
for arg in "$@"; do
  case "$arg" in
    --with-ollama) WITH_OLLAMA=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

# ── Root check ────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Source vars + steps ───────────────────────────────────────
# shellcheck disable=SC1091
source "$SCRIPT_DIR/versions.env"
for step in "$SCRIPT_DIR"/steps/*.sh; do
  # shellcheck disable=SC1090
  source "$step"
done

# ── Detect IPs (LAN + Tailscale) ──────────────────────────────
detect_ips

echo ""
echo "═══════════════════════════════════════════"
echo "   WSD-Pro installer"
echo "   LAN IP:        ${LAN_IP:-<unknown>}"
echo "   Tailscale IP:  ${TAILSCALE_IP:-<none>}"
echo "   With Ollama:   $([ "$WITH_OLLAMA" -eq 1 ] && echo yes || echo no)"
echo "═══════════════════════════════════════════"
echo ""

step_deps
step_build
step_caddy
step_service
if [ "$WITH_OLLAMA" -eq 1 ]; then
  step_ollama
fi

# ── Summary ───────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "   ✅ WSD-Pro installed successfully!"
echo ""
echo "   Dashboard:  https://${LAN_IP:-<IP>}            user: $(cat "$DATA_DIR/env.conf" | grep WSD_ADMIN_USER | cut -d= -f2)"
echo "   Password:   $(cat "$DATA_DIR/env.conf" | grep WSD_ADMIN_PASSWORD | cut -d= -f2)"
echo "   Web IDE:    https://${LAN_IP:-<IP>}:${IDE_PORT}   password: $(cat "$DATA_DIR/env.conf" | grep WSD_IDE_PASSWORD | cut -d= -f2)"
if [ -n "${TAILSCALE_IP:-}" ]; then
  echo "   Tailscale:  https://${TAILSCALE_IP}  /  https://${TAILSCALE_IP}:${IDE_PORT}"
fi
echo ""
echo "   Change these in: $DATA_DIR/env.conf"
echo "   Then: sudo systemctl restart wsd-pro-backend"
echo "═══════════════════════════════════════════"
echo ""