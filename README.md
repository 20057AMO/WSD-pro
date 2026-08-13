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

## Install (Linux only — clone method)

> Requires Ubuntu 22.04+/Debian 12, root/sudo, ≥8 GB RAM (16 GB recommended for local models).

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

## Development

```bash
cd backend
npm install
npm run dev        # ts-node, http://localhost:3000
npm run build      # tsc → dist/
npm run typecheck
```

Frontend is served statically by the backend (no build step).

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

- Set `WSD_JWT_SECRET`, `WSD_ADMIN_PASSWORD` before first boot (random values are generated otherwise)
- JWT secret is persisted in `backend/data/jwt-secret` (mode 600) when not provided
- Login is rate-limited (8 attempts / 15 min per IP)
- All file paths are validated against path traversal
- Default install serves only on your LAN/Tailscale — no public exposure by default

## Roadmap

- Phase 1 ✅/🚧 — fixes, real-time terminal, streaming chat
- Phase 2 — Web IDE (shared code-server), port scanner, git
- Phase 3 — CasaOS-style installer, Tailscale support
- Post-MVP — agent browser (noVNC), multi-user, scheduled tasks, self-update

## License

MIT — see [LICENSE](LICENSE). Not affiliated with Remote.
