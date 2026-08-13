# ── 01-deps.sh — host dependencies (Docker, Node 22, user) ─────

function detect_ips() {
  LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
  [ -z "${LAN_IP:-}" ] && LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"

  TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
  if [ -z "${TAILSCALE_IP:-}" ]; then
    TAILSCALE_IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.' | head -n1 || true)"
  fi
}

function step_deps() {
  echo "── [1/5] Host dependencies (Docker, Node $NODE_MAJOR, tools)"

  apt-get update -y >/dev/null
  apt-get install -y curl git ca-certificates gnupg lsb-release openssl rsync >/dev/null

  # Docker
  if ! command -v docker >/dev/null 2>&1; then
    echo "Installing Docker…"
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true

  # Node.js (LTS pinned)
  if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt "$NODE_MAJOR" ]; then
    echo "Installing Node.js $NODE_MAJOR…"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs >/dev/null
  fi

  # Dedicated service user with docker access
  id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$SERVICE_USER"
  usermod -aG docker "$SERVICE_USER" 2>/dev/null || true

  mkdir -p "$DATA_DIR" "$WORKSPACES_DIR" "$DATA_DIR/data"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

  echo "✅ deps ready — node $(node -v), docker $(docker --version | awk '{print $3}' | tr -d ',')"
}