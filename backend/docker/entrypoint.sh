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

# ── Web IDE ───────────────────────────────────────────────────
echo "WSD-Pro: starting code-server IDE on 0.0.0.0:8080 (no auth)"
# NOTE: code-server reads the PORT env var and it overrides --bind-addr,
# so unset it (PORT is used by the dashboard node app).
# Auth disabled (--auth none) — safe in local Docker environment.
env -u PORT code-server --auth none --disable-telemetry --disable-update-check \
  --bind-addr 0.0.0.0:8080 /workspaces \
  > /tmp/code-server.log 2>&1 &
CODE_SERVER_PID=$!

# ── opencode web (native UI, rooted at /workspaces) ───────────
# Purge stale opencode projects BEFORE it starts: deleted WSD-Pro projects
# must never haunt the opencode web UI. Its store is a SQLite db (project +
# project_directory tables); cleaning it here, before `opencode web` launches,
# avoids any locking concerns entirely.
OPENCODE_DB="$DATA_DIR/opencode/opencode/opencode.db"
if [ -f "$OPENCODE_DB" ] && command -v python3 >/dev/null 2>&1; then
  python3 - "$DATA_DIR" <<'PYEOF' || true
import sqlite3, sys, os
data = sys.argv[1]
db = os.path.join(data, 'opencode', 'opencode', 'opencode.db')
live_dir = os.path.join(data, 'projects')
try:
    con = sqlite3.connect(db, timeout=5)
    cur = con.cursor()
    rows = cur.execute('SELECT id, worktree FROM project').fetchall()
    dead = []
    for pid, wt in rows:
        if not isinstance(wt, str) or not wt.startswith('/workspaces/'):
            continue  # leave the global/root instance alone
        slug = wt[len('/workspaces/'):].split('/')[0]
        if not slug or slug.startswith('.'):
            continue
        if os.path.isfile(os.path.join(live_dir, slug, 'meta.json')):
            continue  # still a live project
        dead.append((pid, slug))
    for pid, _slug in dead:
        cur.execute('DELETE FROM project_directory WHERE project_id=?', (pid,))
        cur.execute('DELETE FROM project WHERE id=?', (pid,))
    con.commit()
    print(f'WSD-Pro: purged {len(dead)} stale opencode project(s)')
except Exception as e:
    print(f'WSD-Pro: opencode db purge skipped ({e})')
PYEOF
fi

echo "WSD-Pro: starting opencode web on 0.0.0.0:${WSD_OPENCODE_PORT:-4096} (cwd /workspaces)"
mkdir -p "$DATA_DIR/opencode"
cd /workspaces
# env -u PORT avoids the dashboard PORT=3000 leaking into opencode.
# HOME=/workspaces makes the web UI's project picker start at /workspaces so the
# user's project folders are visible immediately. XDG_* pins keep the Big Pickle
# config, session state, cache and data in their original locations (so opencode
# does not litter /workspaces with .cache/.npm runtime folders). npm_config_cache
# redirects the npm cache the opencode process creates at startup.
env -u PORT \
  HOME=/workspaces \
  XDG_CONFIG_HOME=/root/.config \
  XDG_STATE_HOME=/root/.local/state \
  XDG_CACHE_HOME=/root/.cache \
  XDG_DATA_HOME="$DATA_DIR/opencode" \
  npm_config_cache=/root/.npm \
  opencode web --hostname 0.0.0.0 --port "${WSD_OPENCODE_PORT:-4096}" \
  > /tmp/opencode-web.log 2>&1 &
OPENCODE_PID=$!

# ── Register existing projects with opencode ──────────────────
# opencode only gives a directory its own project once a session is created
# there AND it can resolve a project id. Resolution order (packages/core/src/
# project.ts): git remote > cached id in <gitdir>/opencode > root commit >
# global. Seed every live /workspaces/<slug> with a git repo + a deterministic
# cached id (sha1 of the dir path) so the web UI sidebar lists each project.
# IMPORTANT: only directories belonging to LIVE projects (meta store in
# $DATA_DIR/projects/<slug>) are registered — deleted projects must never
# resurrect in opencode after a restart.
# Every curl is time-boxed so this block can never block dashboard startup.
OPCODE_URL="http://localhost:${WSD_OPENCODE_PORT:-4096}"
opencode_ready() {
  curl -fsS --max-time 2 "$OPCODE_URL/global/health" >/dev/null 2>&1
}
for i in $(seq 1 30); do
  opencode_ready && break
  sleep 1
done
if opencode_ready; then
  PROJ_JSON="$(curl -fsS --max-time 5 "$OPCODE_URL/project" 2>/dev/null || echo '[]')"
  WORKTREES="$(printf '%s' "$PROJ_JSON" | jq -r '.[].worktree' 2>/dev/null || true)"
  for m in "$DATA_DIR"/projects/*/meta.json; do
    [ -f "$m" ] || continue
    slug="$(basename "$(dirname "$m")")"
    case "$slug" in .*) continue ;; esac # skip runtime dot-dirs (.cache, .npm, ...)
    dir="/workspaces/$slug"
    [ -d "$dir" ] || continue
    if printf '%s\n' "$WORKTREES" | grep -qxF "$dir"; then
      continue
    fi
    git -C "$dir" init -q 2>/dev/null || true
    if [ -d "$dir/.git" ]; then
      printf '%s' "$(printf '%s' "$dir" | sha1sum | cut -c1-40)" > "$dir/.git/opencode"
    fi
    curl -fsS --max-time 5 -X POST "$OPCODE_URL/session?directory=$dir" \
      -H 'content-type: application/json' -d '{}' >/dev/null 2>&1 || true
  done
fi

cleanup() {
  kill "$CODE_SERVER_PID" "$OPENCODE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "WSD-Pro: starting dashboard on 0.0.0.0:${PORT:-3000}"
cd /app/backend
exec node dist/index.js
