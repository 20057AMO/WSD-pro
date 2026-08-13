# ── 02-build.sh — backend build + workspace Docker image ───────

function step_build() {
  echo "── [2/5] Backend build + workspace image"

  mkdir -p "$APP_DIR"

  # Install the app into APP_DIR (from local checkout or GitHub)
  if [ -d "$ROOT_DIR/backend" ] && [ -f "$ROOT_DIR/Dockerfile.workspace" ]; then
    echo "Copying app from local checkout → $APP_DIR"
    rsync -a --exclude node_modules --exclude dist --exclude .git --exclude workspaces "$ROOT_DIR/" "$APP_DIR/"
  else
    echo "Cloning $REPO_URL → $APP_DIR"
    git clone --depth 1 "$REPO_URL" "$APP_DIR"
  fi

  # Backend
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

  # Ownership → service user can write data/ and dist stays readable
  chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

  echo "✅ build done"
}