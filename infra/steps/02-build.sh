# ── 02-build.sh — backend build + workspace Docker image ───────
# Builds in place from the clone (APP_DIR is set by install.sh).

function step_build() {
  echo "── [2/5] Backend build + workspace image"

  cd "$APP_DIR/backend"

  echo "npm install…"
  npm ci >/dev/null 2>&1 || npm install >/dev/null
  echo "Building (tsc)…"
  npm run build || ./node_modules/.bin/tsc

  # Workspace image (node 22 + python + git + code-server)
  echo "Building workspace image: $WS_WORKSPACE_IMAGE (code-server v$CODE_SERVER_VERSION)…"
  docker build \
    -f "$APP_DIR/Dockerfile.workspace" \
    --build-arg CODE_SERVER_VERSION="$CODE_SERVER_VERSION" \
    -t "$WS_WORKSPACE_IMAGE" \
    "$APP_DIR"

  # Ownership → service user can write data/ inside the clone
  chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

  echo "✅ build done (in place: $APP_DIR)"
}