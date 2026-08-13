# WSD-Pro — Work Space Development Pro

Self-hosted command center for AI coding agents, **Linux only**. Every project gets its own isolated Docker container with a durable workspace, a real-time terminal, files, logs, and free local AI agents (Ollama). A single shared **Web IDE (code-server / VS Code in the browser)** opens any project, and every project publishes its own ports for testing and live previews.

> Inspired by [Remote](https://github.com/futrx-com/remote.futrx) (Go/LXC) but reimplemented as a lighter Node.js/Docker stack with **free-only agents**.

## What you get

| Feature | Description |
|---|---|
| Projects (Docker) | One container per project (`wsd-{slug}`), bind-mounted workspace, published ports |
| Real-time terminal | WebSocket + xterm.js, runs `bash` inside the container (input/resize) |
| File manager | Browse / edit / create / delete files in the workspace (REST) |
| Agent chat | Streaming chat with free local agents (Ollama `qwen2.5-coder`) with JSONL history + replay |
| Web IDE | One shared code-server on `:8100` mounting all workspaces — open any project folder |
| Port discovery | Live scan of open ports per project → one-click preview links |
| Git | status / log / diff / commit straight from the API |
| Auth | JWT + bcrypt admin account, login rate limiting |
| TLS | Caddy with self-signed certs for LAN + Tailscale access |

## Access layout

```
https://<IP>:3000   → Command center (projects, terminal, files, agents)
https://<IP>:8100   → Web IDE (VS Code) — one instance for all projects
https://<IP>:<port> → Live preview of a project's published port
```

`<IP>` is your LAN IP (e.g. `192.168.0.110`) or your **Tailscale IP** (`100.x.y.z`) — the app works on both with zero DNS setup.

## Stack

- **Backend:** Node.js 22 + TypeScript, Express 5, Dockerode, ws
- **Frontend:** Vanilla JS SPA (no framework) + xterm.js
- **Edge:** Caddy (local_certs), systemd services
- **Containers:** Docker per-project workspaces + one `wsd/workspace` dev image (Node 22, Python, git, code-server)

## Install (CasaOS-style, one command)

```bash
# 1. Get git + clone the repo (anywhere you like)
sudo apt update && sudo apt install -y git
git clone https://github.com/20057AMO/WSD-pro.git
cd WSD-pro

# 2. Run the installer from inside the clone
sudo bash infra/install.sh                # basic
sudo bash infra/install.sh --with-ollama  # + local free models (qwen2.5-coder)
```

The installer (idempotent, re-runnable) detects your **LAN IP and Tailscale IP**, installs Docker/Node/Caddy, builds the workspace image in place, creates the backend systemd service, prints your credentials, and optionally installs Ollama. Full step-by-step guide in **[docs/INSTALL.md](docs/INSTALL.md)** (Arabic).

- Update: `sudo bash infra/update.sh` (git pull + rebuild + restart)
- Uninstall: `sudo bash infra/uninstall.sh`

## Development / Local run

This project is designed for Linux or WSL. Docker must be running and the workspace image must exist before the shared IDE is used.

```bash
cd backend
npm install
npm run build        # tsc → dist/
npm run typecheck   # optional validation
node dist/index.js   # reliable runtime entry point
```

Then open:

- http://localhost:3000
- or http://<LAN-IP>:3000

If the shared IDE is not available, build the workspace image first:

```bash
cd ..
docker build -f Dockerfile.workspace -t wsd/workspace:latest .
```

Then start the IDE from the app or via the API:

```bash
curl -X POST http://localhost:3000/api/ide/start \
  -H "Authorization: Bearer <JWT>"
```

The UI is served statically by the backend; there is no separate frontend build step.

## Repository layout

```
backend/src/
  index.ts                 Express app + REST API
  services/
    docker-manager.ts      Docker orchestration (create/start/stop/exec)
    auth.ts                JWT + bcrypt + rate limiting
    agents-manager.ts      Free agents (Ollama ReAct) + streaming
    chat-store.ts          JSONL chat history + replay
    git-service.ts         Git operations in a project
    port-scanner.ts        Live port discovery
    ide-service.ts         Shared code-server (wsd-ide container)
  ws/
    ws-server.ts           WebSocket hub (JWT-auth'd)
    ws-terminal.ts         Interactive container terminal
    ws-chat.ts             Streaming agent chat
frontend/                  Vanilla JS SPA (index.html, app.js, style.css, vendor/xterm)
infra/                     Installer (steps/), Caddy/systemd templates
docs/                      systemd units, QA report, plans
```

## Security notes

- Set `WSD_JWT_SECRET`, `WSD_ADMIN_PASSWORD` before first boot; generated values are used as fallback only
- JWT secret is persisted in `backend/data/jwt-secret` (mode 600) when not provided
- Login is rate-limited (8 attempts / 15 min per IP)
- Project slugs, ports, execution commands, and file paths are validated to reduce injection/path traversal risk
- WebSocket entry points are restricted to safe project/chat routes and connection caps
- Docker execution is filtered through validated project containers rather than raw host-shell execution
- Default install serves only on your LAN/Tailscale — no public exposure by default
- Shared IDE uses the workspace image and avoids unsafe shell embedding for password handling

## Runtime notes

- Backend app entry point is `backend/dist/index.js` after TypeScript build.
- `npm run dev` may not be reliable in all local Windows shells due to ts-node environment differences; `npx tsc && node dist/index.js` is the stable option in this project.
- The IDE container depends on `wsd/workspace:latest` being present locally; without it, port `:8100` will not respond.

## Troubleshooting

### 1) Backend is running but port 3000 is not reachable

Check whether the app is listening:

```bash
ss -tulpn | grep 3000
```

If nothing is listening, restart the built server:

```bash
cd backend
npx tsc
node dist/index.js
```

If port 3000 is already in use by another process, stop that process or change the port in `.env`:

```env
PORT=3001
```

### 2) IDE does not open on :8100

This is usually caused by one of the following:

- Docker is not running
- the image `wsd/workspace:latest` was never built
- the project is running on Windows without Docker Desktop / WSL support

Check the image:

```bash
docker images | grep wsd/workspace
```

Build it if missing:

```bash
cd /path/to/WSD-Pro
docker build -f Dockerfile.workspace -t wsd/workspace:latest .
```

Then start the IDE:

```bash
curl -X POST http://localhost:3000/api/ide/start \
  -H "Authorization: Bearer <JWT>"
```

Open:

```text
http://<LAN-IP>:8100
```

### 3) Docker is available but container creation fails

Check Docker status:

```bash
docker ps -a
```

Inspect logs for the IDE container:

```bash
docker logs wsd-ide
```

If the container was never created, trigger startup from the UI or API, then re-check:

```bash
docker ps -a --filter name=wsd-ide
```

### 4) The app loads, but auth/login fails

Verify the admin credentials and the stored JWT secret:

```bash
ls -l backend/data
cat backend/data/jwt-secret
```

If needed, set them explicitly before first boot:

```env
WSD_ADMIN_USER=admin
WSD_ADMIN_PASSWORD=yourStrongPassword
WSD_JWT_SECRET=yourRandomSecret
```

### 5) `npm run dev` fails in Windows shell

This project is Linux-first. The stable local path is:

```bash
cd backend
npx tsc
node dist/index.js
```

Avoid relying on `ts-node` in some Windows shells because the environment may not resolve the TypeScript config correctly.

## Roadmap

- Phase 1 ✅/🚧 — fixes, real-time terminal, streaming chat
- Phase 2 — Web IDE (shared code-server), port scanner, git
- Phase 3 — CasaOS-style installer, Tailscale support
- Post-MVP — agent browser (noVNC), multi-user, scheduled tasks, self-update

## License

MIT — see [LICENSE](LICENSE). Not affiliated with Remote.
