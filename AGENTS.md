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
cd backend && node node_modules\typescript\bin\tsc --noEmit
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

## Architecture Notes

### WebSocket Endpoints
| Path | Handler | Purpose |
|------|---------|---------|
| `/ws/projects/status` | `ws-projects-status.ts` | Global: broadcasts all project status changes |
| `/ws/projects/:slug/status` | `ws-project-status.ts` | Per-project: status + CPU/memory stats (3s poll) |
| `/ws/projects/:slug/logs` | `ws-project-logs.ts` | Live Docker logs tail |
| `/ws/projects/:slug/terminal` | `ws-terminal.ts` | xterm.js terminal |
| `/ws/chat/:slug/:chatId` | `ws-chat.ts` | AI chat per project |
| `/ws/agent/:id/:chatId` | `ws-agent.ts` | Agent chat with tools |

### Frontend Pages
| Route | Component | Notes |
|-------|-----------|-------|
| `/` | Dashboard | Minimal overview: stats + quick actions |
| `/projects` | Projects | Cards/table, search, filter, sort, bulk ops |
| `/project/:slug` | Project | Detail: overview, files, logs, terminal, scripts |
| `/agents` | Agents | AI agents with chat, RTL/LTR, presets |
| `/providers` | Providers | LLM provider config |
| `/ide` | EmbeddedIDE | code-server iframe |
| `/opencode` | Opencode | opencode web iframe |

### Key Patterns
- **WebSocket with HTTP fallback**: All WS hooks try WS first, fall back to 5s polling
- **Room-based connection limits**: Max 8 connections per WS room
- **No authentication**: Open app, no login required

## Working Methodology

### Area-by-Area (بالقطع)
Work on one feature/page/area at a time. Do not jump between unrelated areas. Example: today's work was on the Agents page — all changes focused there.

### Context & Vertical Goal (السياق والهدف الرأسي)
Before ANY code change:
1. Understand the full context of the feature being worked on
2. Know the vertical goal — the end result the user wants to achieve
3. Never work blindly or make random changes

### Think Like a Senior Engineer
After understanding context and goal:
- Plan thoroughly before touching code
- Consider edge cases, race conditions, security
- Test every change (tsc + vite build + Docker)
- Never break existing functionality
