<p align="center">
  <img src="frontend/public/logo.png" alt="WSD-Pro" width="110" />
</p>

<h1 align="center">WSD-Pro</h1>

<p align="center">
  <a href="https://github.com/20057AMO/WSD-pro/actions/workflows/ci.yml">
    <img src="https://github.com/20057AMO/WSD-pro/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <img src="https://img.shields.io/badge/version-2.0.0--beta-blue" alt="version" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license" />
</p>

**WSD-Pro** is a self-hosted workspace platform for developers and AI-assisted workflows. Every project gets its own isolated Docker container, and the whole stack is driven from a single web dashboard: browser IDE, live logs, terminal, AI chat that understands your codebase, autonomous agents, and multi-provider LLM configuration.

Designed for local or private deployment — no domain, no SSL, no cloud dependency required.

---

## Highlights

- **Isolated project containers** — each project runs in its own container with its own port, created from a purpose-built Ubuntu workspace image
- **Project-aware AI chat** — streaming chat per project with automatic workspace context and file retrieval, image/text attachments, sessions, stop control
- **AI agents with tools** — file operations, shell commands, project tree exploration; RTL/LTR support and ready-made presets
- **Multi-provider LLM config** — Ollama (cloud or local), any OpenAI-compatible endpoint, Anthropic, Gemini, and Azure OpenAI
- **Providers security lock** — optional second password protecting API keys, with sudo-style re-auth for sensitive actions
- **Browser IDE** — embedded code-server, plus an OpenCode web UI
- **Full project lifecycle** — create/start/stop/restart/delete, env variables, file upload, live logs, xterm terminal, script execution
- **Security-first** — bcrypt + JWT auth, brute-force rate limiting, session revocation ("logout everywhere"), security activity log, config backup export/import

## Requirements

| Requirement | Notes |
| --- | --- |
| Docker Engine 24+ **or** Docker Desktop | With the `compose` plugin (v2). On Windows use the WSL2 backend |
| Free ports | `3000` (dashboard), `8100` (IDE), `4096` (OpenCode) |
| ~4 GB disk | For the two images plus your projects |

No Node.js or other tooling is needed on the host — everything builds inside Docker.

## Quick Start

```bash
# 1. Clone
git clone https://github.com/20057AMO/WSD-pro.git
cd WSD-Pro

# 2. Create your environment file
cp .env.example .env

# 3. Edit .env:
#    - JWT_SECRET (required): generate one with
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#    - WSD_WORKSPACES_HOST_DIR (required): the ABSOLUTE host path of this
#      repo's workspaces/ folder, e.g.
#        Windows: D:/WSD-Pro/workspaces   Linux: /home/me/wsd-pro/workspaces

# 4. Build and launch
docker compose up -d --build

# 5. Open the dashboard
#    http://localhost:3000
```

On first visit you'll be asked to **create the admin account** (username + password). This same password unlocks provider management — there is exactly one account.

After signing in: open **Providers**, add at least one LLM provider (a free [Ollama Cloud](https://ollama.com/settings/keys) key or [OpenCode Zen](https://opencode.ai/auth) key works out of the box), then head to **Projects** and create your first project.

> **Windows note:** `WSD_WORKSPACES_HOST_DIR` must be the absolute path as seen by the Docker daemon host (Docker Desktop VM), not a path inside the container. This lets project containers bind-mount the very same files the dashboard sees.

## Default Access

| Service | URL | Password |
| --- | --- | --- |
| Dashboard | http://localhost:3000 | Created by you on first run |
| Web IDE (code-server) | http://localhost:8100 | `admin123` by default — change via `WSD_IDE_PASSWORD`, surfaced in-app via the **Web IDE** button |
| OpenCode UI | http://localhost:4096 | n/a |

## Environment Variables

All values live in `.env` (see [.env.example](.env.example)):

| Variable | Required | Description |
| --- | --- | --- |
| `JWT_SECRET` | ✅ | Secret used to sign login tokens. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `WSD_WORKSPACES_HOST_DIR` | ✅* | Absolute host path of `./workspaces` — used as the bind source when launching project containers (*auto-defaults to `./workspaces` on native Linux daemons; set it explicitly on Docker Desktop*) |
| `OLLAMA_API_KEY` | – | Ollama Cloud API key (free). Local Ollama works without it |
| `OPENCODE_API_KEY` | – | OpenCode Zen key (free, GitHub sign-in) for the OpenCode page |
| `WSD_CHAT_MODEL` | – | Default chat model (default: `qwen3:30b`) |
| `OLLAMA_LOCAL_HOST` | – | Base URL of a local Ollama instance (default: `http://host.docker.internal:11434`) |
| `WSD_IDE_PASSWORD` | – | Fixed code-server password (default: `admin123`) |
| `WSD_OPENCODE_PORT` | – | Host port for the OpenCode UI (default: `4096`) |

Provider keys (Anthropic, Gemini, Azure, custom OpenAI-compatible endpoints) are added later **from the app UI**, never from files.

## Features in Depth

### Projects
Create a project with a name and optional exposed ports (`8080,8081`). WSD-Pro generates `workspaces/<slug>/`, launches container `wsd-<slug>` from the bundled `wsd/workspace` image (Ubuntu 24.04), and wires status polling, CPU/memory stats, live log tailing, and an interactive terminal over WebSocket — all with HTTP-polling fallbacks.

### Project AI Chat & Agents
The **AI Chat** tab inside every project streams answers grounded in that project's files (automatic context injection + file retrieval). The standalone **Agents** page runs tool-using agents that can read/write files, execute commands, and explore project trees — with per-session history and RTL/LTR toggles.

### Providers
Configure multiple backends side by side. Verification distinguishes auth/quota/rate-limit failures; health checks are cached server-side (60s). Optional **security lock**: a separate bcrypt password gates the Providers page itself; unlocking issues a short-lived scoped token, and every sensitive action (lock changes, backups, logout-everywhere, password change) requires re-entering the account password through a unified re-auth modal.

### Security
- bcrypt-hashed account password stored locally in `data/users.json`
- JWT (24h) with token-version revocation — "logout everywhere" kills all sessions instantly
- Rate limiting: global 240 req/min, dedicated stricter scope (10/min) on password verification endpoints
- Path-traversal protection on all file routes; upload sanitization; WebSocket auth via signed token on upgrade; max 8 connections per WS room
- Append-only audit log (last 100 events: logins, lock changes, exports, unlocks…) visible in Settings
- One-click config export/import (provider API keys are stripped from exports by design)

### Auto-logout
Configurable idle timeout (off / 30 / 60 / 120 min) synced across tabs.

## Architecture

| Component | Role |
| --- | --- |
| `app` container | Preact dashboard (served at `/`), Express API, WebSocket services, Docker orchestration for project containers |
| `workspace` image | `wsd/workspace` — Ubuntu 24.04 base used for generated project containers |

```
frontend/            Preact + TypeScript + Vite dashboard
backend/             Express 5 + Node 22 + ws (WebSocket)
docs/                Arabic installation guide
workspaces/          Your project files (created at runtime)
Dockerfile           Multi-stage: frontend build → backend build → runtime
Dockerfile.workspace Ubuntu 24.04 base image for project containers
docker-compose.yml   The whole stack
```

## Useful Commands

```bash
docker compose ps              # stack status
docker compose logs -f app     # follow dashboard logs
docker compose down            # stop (data persists)
docker compose down -v         # stop AND delete volumes (chat/config data)
```

Your data lives in two places: `./workspaces/` (project files) and the named volume `wsd-data` (accounts, providers, chat sessions). Both survive restarts and rebuilds.

## Development

Backend tests run against a live stack on port 3000:

```bash
docker compose up -d
cd backend && npm test
```

Type checks: `npm run typecheck` in `frontend/` and `backend/`. CI (GitHub Actions) builds the full stack and runs the entire backend test suite on every push.

## License

[MIT](LICENSE) © Ahmed M.Ali
