# AGENTS.md — WSD-Pro

## Docker Rebuild Rule

After every code change to `frontend/` or `backend/`, always rebuild and restart the container:

```bash
docker compose build app && docker compose up -d app
```

No exceptions. Every feature, fix, or refactor must be tested inside the running container.

## Build & Verify

### Local (development)
```bash
cd frontend && node node_modules\typescript\bin\tsc --noEmit
cd frontend && node node_modules\vite\bin\vite.js build
```

### Docker (integration)
```bash
docker compose build app && docker compose up -d app
```

## Project Structure

```
frontend/   — Preact + TypeScript + Vite (served at /)
backend/    — Express 5 + Node 22 + WebSocket ws
Dockerfile  — Multi-stage: frontend build → backend build → runtime
Dockerfile.workspace — Ubuntu 24.04 base image for project containers
```
