# ──────────────────────────────────────────────────────────────
# WSD-Pro install.sh — clone-based installer (CasaOS-style)
#
#   git clone https://github.com/20057AMO/WSD-pro.git
#   cd WSD-pro
#   sudo bash infra/install.sh [--with-ollama]
#
# Runs entirely from YOUR CLONE (in-place, no copying). Detects LAN +
# Tailscale IPs, installs Docker/Node/Caddy, builds the workspace image,
# creates the backend service, and prints access URLs. Idempotent —
# re-run after joining Tailscale to regenerate the Caddy config.
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

# ── Validate: must be running from a WSD-Pro clone ────────────
if [ ! -f "$ROOT_DIR/Dockerfile.workspace" ] || \
   [ ! -d "$ROOT_DIR/backend" ] || \
   [ ! -d "$ROOT_DIR/infra" ]; then
  echo "❌ This installer must be run from inside a WSD-Pro clone." >&2
  echo "   git clone https://github.com/20057AMO/WSD-pro.git && cd WSD-pro" >&2
  echo "   sudo bash infra/install.sh" >&2
  exit 1
fi

# The app IS the clone — install in place, no copying.
APP_DIR="$ROOT_DIR"

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
echo "   WSD-Pro installer (clone method)"
echo "   App dir:        $APP_DIR"
echo "   LAN IP:         ${LAN_IP:-<unknown>}"
echo "   Tailscale IP:   ${TAILSCALE_IP:-<none>}"
echo "   With Ollama:    $([ "$WITH_OLLAMA" -eq 1 ] && echo yes || echo no)"
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
echo "   Dashboard:  https://${LAN_IP:-<IP>}            user: $(grep WSD_ADMIN_USER "$DATA_DIR/env.conf" | cut -d= -f2)"
echo "   Password:   $(grep WSD_ADMIN_PASSWORD "$DATA_DIR/env.conf" | cut -d= -f2)"
echo "   Web IDE:    https://${LAN_IP:-<IP>}:${IDE_PORT}   password: $(grep WSD_IDE_PASSWORD "$DATA_DIR/env.conf" | cut -d= -f2)"
if [ -n "${TAILSCALE_IP:-}" ]; then
  echo "   Tailscale:  https://${TAILSCALE_IP}  /  https://${TAILSCALE_IP}:${IDE_PORT}"
fi
echo ""
echo "   Credentials:  $DATA_DIR/env.conf  (edit → systemctl restart wsd-pro-backend)"
echo "   Update:       cd $APP_DIR && sudo bash infra/update.sh"
echo "   Uninstall:    sudo bash infra/uninstall.sh"
echo "═══════════════════════════════════════════"
echo ""