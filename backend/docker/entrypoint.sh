#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${WSD_DATA_DIR:-/app/data}"
IDE_PASSWORD_FILE="$DATA_DIR/ide-password"

# Resolve the IDE password: explicit env > persisted > generated
if [ -n "${WSD_IDE_PASSWORD:-}" ]; then
  IDE_PASSWORD="$WSD_IDE_PASSWORD"
else
  mkdir -p "$DATA_DIR"
  if [ -f "$IDE_PASSWORD_FILE" ]; then
    IDE_PASSWORD="$(cat "$IDE_PASSWORD_FILE")"
  else
    IDE_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -d '+/=' | cut -c1-16)"
    printf '%s' "$IDE_PASSWORD" > "$IDE_PASSWORD_FILE"
  fi
fi

echo "WSD-Pro: starting code-server IDE on 0.0.0.0:8080 (password stored in $IDE_PASSWORD_FILE)"
export PASSWORD="$IDE_PASSWORD"
code-server --auth password --bind-addr 0.0.0.0:8080 /workspaces \
  > /tmp/code-server.log 2>&1 &
CODE_SERVER_PID=$!

cleanup() {
  kill "$CODE_SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "WSD-Pro: starting dashboard on 0.0.0.0:${PORT:-3000}"
cd /app/backend
exec node dist/index.js
