# ── 03-caddy.sh — Caddy + self-signed TLS for LAN & Tailscale ──

function step_caddy() {
  echo "── [3/5] Caddy (local_certs)"

  if ! command -v caddy >/dev/null 2>&1; then
    echo "Installing Caddy…"
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    apt-get update -y >/dev/null
    apt-get install -y caddy >/dev/null
  fi

  # Optional Tailscale site blocks
  local tailblock=""
  if [ -n "${TAILSCALE_IP:-}" ]; then
    tailblock="
https://${TAILSCALE_IP} {
    encode zstd gzip
    reverse_proxy 127.0.0.1:${DASHBOARD_PORT}
}

https://${TAILSCALE_IP}:${IDE_PORT} {
    encode zstd gzip
    reverse_proxy 127.0.0.1:${IDE_PORT}
}"
  fi

  # GNU sed requires newlines escaped as \n inside the replacement text
  local tailblock_esc
  tailblock_esc="${tailblock//$'\n'/\\n}"

  sed -e "s|{{LAN_IP}}|${LAN_IP}|g" \
      -e "s|{{DASHBOARD_PORT}}|${DASHBOARD_PORT}|g" \
      -e "s|{{IDE_PORT}}|${IDE_PORT}|g" \
      -e "s|{{TAILSCALE_BLOCK}}|${tailblock_esc}|g" \
      "$SCRIPT_DIR/templates/Caddyfile.tmpl" > /etc/caddy/Caddyfile

  systemctl enable --now caddy >/dev/null 2>&1 || true

  if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    systemctl reload caddy >/dev/null 2>&1 || true
  else
    echo "⚠️  Caddy config validation warning — check /etc/caddy/Caddyfile"
  fi

  echo "✅ Caddy ready — https://${LAN_IP} (+ https://${TAILSCALE_IP:-'<tailscale>'} if available)"
}