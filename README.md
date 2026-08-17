# WSD-Pro

<p align="center">
  <img src="frontend/public/logo.png" alt="WSD-Pro Logo" width="180" />
</p>

WSD-Pro is a self-hosted workspace platform for developers and AI-assisted workflows. It gives each project its own isolated container, a unified browser-based IDE, an OpenCode experience, and a design/chat assistant for architecture and planning.

It is designed for local or private deployment without requiring a domain, SSL, or complex infrastructure.

## Highlights

- Project dashboard with no login required
- Isolated per-project containers and ports
- Built-in browser IDE via code-server
- OpenCode web interface for AI-assisted development
- Chat and planning assistant for architecture and design
- Project cloning, environment variables, logs, and runtime introspection
- Instant preview and project access through the app UI

## Architecture

| Component | Role |
| --- | --- |
| app | Main dashboard, IDE, OpenCode, chat, and project orchestration |
| workspace | Base image used for generated project containers |
| frontend | Preact + TypeScript dashboard and user interface |
| backend | Express API, Docker orchestration, WebSocket services, and automation |

Projects are created dynamically through Docker from the application runtime and stored under the shared workspaces directory.

## Default access

After startup, use the following:

- Dashboard: http://localhost:3000
- Web IDE: http://localhost:8100
- OpenCode: http://localhost:4096

Default Web IDE password:

- admin123

## Features

### 1. Project workspace management
- Create projects with custom names and optional ports
- Start, stop, restart, and delete project containers
- Inspect project status, runtime data, and logs
- Store project metadata and environment configuration

### 2. Unified development environment
- Open any project directly in a browser-based IDE
- Work across multiple projects from a single interface
- Access project files within the shared /workspaces directory

### 3. AI-assisted workflows
- Chat-based planning and design assistant
- Project-aware context for codebase understanding
- Antigravity support for code-generation and review-oriented assistance
- Provider-based model configuration for multiple AI backends

### 4. Workflow automation
- Smart project scanning for context injection
- Docker-based provisioning for project environments
- Script execution, cloning, and container lifecycle control

## Tech stack

- Frontend: Preact + TypeScript + Vite
- Backend: Node.js + Express + WebSockets
- Runtime: Docker + Docker Compose
- IDE: code-server
- AI: Ollama, Gemini, and provider-based integrations

## Quick start

1. Clone the repository
2. Copy the environment file if needed
3. Build and launch the stack

```bash
docker compose build
docker compose up -d
```

Then open:

```text
http://localhost:3000
```

## Environment notes

The project is designed to run locally without domain or SSL setup. Optional environment values can be supplied as needed for AI providers and runtime configuration.

For detailed installation and troubleshooting guidance, see:

- [docs/INSTALL.md](docs/INSTALL.md)

## Project structure

```text
.
├── backend/
│   ├── src/
│   ├── tests/
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   ├── public/
│   ├── package.json
│   └── vite.config.ts
├── docs/
│   └── INSTALL.md
├── workspaces/
├── docker-compose.yml
├── Dockerfile
├── README.md
└── package.json
```

## Default credentials

- Web IDE password: admin123
- Providers page password: configured through application flow

## Useful commands

```bash
docker compose ps
docker compose logs -f app
docker compose down
```

## Notes

This project is intended to be a practical self-hosted workspace environment for developers and AI-focused workflows. It emphasizes simplicity, local control, and fast project iteration without external service lock-in.

## License

This project is distributed under the MIT license unless otherwise specified in project files.
