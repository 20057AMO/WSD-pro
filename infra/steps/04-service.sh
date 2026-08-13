# ── 04-service.sh — env + systemd unit ─────────────────────────

function step_service() {
  echo "── [4/5] Backend systemd service"

  mkdir -p "$DATA_DIR" "$DATA_DIR/data"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

  # Generate env.conf once (marked in .envgenerated)
  if [ ! -f "$DATA_DIR/env.conf" ]; then
    local jwt_secret admin_pass ide_pass
    jwt_secret="$(openssl rand -hex 24)"
    admin_pass="$(openssl rand -base64 9 | tr '+/' '_-' | tr -d '=')"
    ide_pass="$(openssl rand -base64 9 | tr '+/' '_-' | tr -d '=')"

    cat > "$DATA_DIR/env.conf" <<EOF
PORT=${DASHBOARD_PORT}
HOST=0.0.0.0
WSD_PROJECTS_DIR=${WORKSPACES_DIR}
WSD_DATA_DIR=${DATA_DIR}/data
WSD_JWT_SECRET=${jwt_secret}
WSD_ADMIN_USER=admin
WSD_ADMIN_PASSWORD=${admin_pass}
WSD_IDE_PORT=${IDE_PORT}
WSD_IDE_PASSWORD=${ide_pass}
WSD_BASE_IMAGE=${WS_WORKSPACE_IMAGE}
EOF
    chmod 600 "$DATA_DIR/env.conf"
    chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR/env.conf"
    echo "Generated credentials → $DATA_DIR/env.conf"
  fi

  sed -e "s|{{APP_DIR}}|${APP_DIR}|g" \
      -e "s|{{DATA_DIR}}|${DATA_DIR}|g" \
      -e "s|{{SERVICE_USER}}|${SERVICE_USER}|g" \
      "$SCRIPT_DIR/templates/wsd-pro-backend.service.tmpl" > /etc/systemd/system/wsd-pro-backend.service

  systemctl daemon-reload
  systemctl enable --now wsd-pro-backend >/dev/null 2>&1 || true

  echo "✅ backend service running (systemctl status wsd-pro-backend)"
}