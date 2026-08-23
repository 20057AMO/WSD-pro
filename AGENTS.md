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

## Testing

Full backend suite against the running container (server must be up on port 3000):

```bash
cd backend && node --test --test-concurrency=1 "tests/**/*.test.ts"
```

| Suite | File | Coverage |
|-------|------|----------|
| Auth & access control | `tests/auth.test.ts` | 401s, forged/tampered/expired tokens, setup guard |
| Session revocation | `tests/auth-revoke.test.ts` | logout-everywhere + token rotation (needs `WSD_TEST_ACCOUNT_PASSWORD`; self-skips) |
| Project lifecycle | `tests/projects.lifecycle.test.ts` | Real Docker: create → env → files → logs/stats/ports → stop/start → delete → 404 |
| Providers/Agents/Chat CRUD | `tests/providers-agents-chat.test.ts` | Full CRUD + sessions + templates |
| Providers lock & backup | `tests/providers-lock.test.ts` | Lock flow E2E (needs `WSD_TEST_ACCOUNT_PASSWORD`; self-skips without it) |
| Security | `tests/security.test.ts` | Path traversal, upload sanitization, malformed auth headers |
| Smoke | `tests/smoke.test.ts` | Health, core endpoints, project roundtrip |
| WebSocket matrix | `tests/websocket.test.ts` | 6 endpoints × {no token→401, valid→open, invalid→401} |

**Test notes:**
- Tests sign their own JWT using `JWT_SECRET` from repo-root `.env` (no real password needed)
- Run serially (`--test-concurrency=1`) — parallel runs + browser polling can trip the rate limiter
- Optional real-login test activates with `WSD_TEST_USER` / `WSD_TEST_PASS` env vars
- Every suite cleans up its own data (projects, agents, providers, sessions)
- Change-password is intentionally NOT auto-tested (would mutate the real account)

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
| `/login` | Login | Setup + login (unauthenticated only) |
| `/` | Dashboard | Minimal overview: stats + quick actions |
| `/projects` | Projects | Cards/table, search, filter, sort, bulk ops |
| `/project/:slug` | Project | Detail: overview, AI chat, files, logs, terminal, scripts |
| `/agents` | Agents | AI agents with chat, RTL/LTR, presets |
| `/providers` | Providers | LLM provider config |
| `/settings` | Settings | Change password, account info, logout |
| `/ide` | EmbeddedIDE | code-server iframe |
| `/opencode` | Opencode | opencode web iframe |

### Authentication
- **Unified auth**: Single user password = providers password
- **Backend**: bcrypt (10 rounds) + JWT (24h expiry) stored in `data/users.json`
- **Frontend**: `auth.tsx` AuthProvider context, token in `localStorage` as `wsd.token`
- **HTTP**: `authMiddleware` on all routes after `/api/auth/*` (returns 401 without Bearer token)
- **WebSocket**: JWT token passed via `?token=` query param on upgrade, validated server-side
- **API helper**: `api()` auto-attaches `Authorization` header; 401 responses redirect to `/login`
- **Routes**: `/login` accessible without auth, all other routes require authenticated user

### Providers Security Lock (optional second layer)
- Separate bcrypt password stored in `users.json` (`providersPasswordHash`) — independent from the account password
- Managed exclusively from Settings → Providers Security via a **two-step sudo-style flow**: pick the new lock password, then confirm identity in `ReAuthModal` (shows the signed-in username, asks for the account password)
- The same `ReAuthModal` pattern authorizes every sensitive op: lock save/remove, backup export/import, logout-everywhere
- Unlock issues a scoped JWT (`scope:'providers'`, 30 min) sent as `X-Providers-Unlock`; version counter (`pv`) invalidates all unlock tokens on password change
- **Session-bound unlock**: login tokens carry a random `jti`; the unlock token embeds it as `sid` and `providersLockMiddleware` requires a match with the requesting session — a stolen unlock token replayed from another session is rejected (legacy tokens without `jti` use `''` consistently on both sides)
- `POST /api/providers/unlock` is brute-force guarded by the shared `auth` limiter (10/min) **plus a progressive cooldown** (5 consecutive failures per IP → 15-min window returning `429` + `Retry-After`, in-memory, reset on success); audited (`providers-unlock` / `providers-unlock-failed` / `providers-unlock-cooldown`)
- **Auto-relock**: Settings → Idle security offers an idle timer ('off'/5/15/30 min, stored as `wsd.providersAutoRelock`) that calls relock + clears the local token after inactivity; same activity-throttle + cross-tab storage-sync machinery as auto-logout
- **Unlock badge**: sidebar shows "🔓 Providers · Nm" only while unlocked (countdown from `expiresAt`); click → confirm → instant relock
- Enabling/changing the lock returns a ready-to-use unlock token — the current session stays open on the Providers page (no immediate re-entry)
- `POST /api/providers/relock` ("Lock now") bumps the version server-side — kills every outstanding unlock token across all tabs/devices; audited (`providers-relock`)
- Unlock token lives in `localStorage` (time-boxed by its expiry) so the `storage` event keeps all tabs in sync about lock state
- When enabled, management endpoints return `403 {error:'providers_locked'}` without a valid token
- Always-open endpoints: `GET /api/providers/options` (id/name/type only) and `GET /api/providers/templates`
- Chat/agent LLM usage is server-side and never blocked by the lock
- Providers page UX states: skeleton shimmer (checking) → welcome modal explaining protection (when unconfigured, dismissible per tab session) → centered login-style unlock modal (when locked)
- **Future work (deliberately deferred)**: at-rest encryption of `providers.json` (AES-256-GCM with an env key — marginal gain while `.env` sits on the same host) and TOTP 2FA on login

### UI conventions
- Icons: **lucide-preact** everywhere (`class="icon"`, spin via `.icon.spin`) — agent preset icons are stored data and stay as-is
- App theme: **dark mode only**
- Version string: `2.0.0-beta` (health, server/info, About panel, backups all aligned)

### Settings Backup (export/import)
- `POST /api/settings/export` (JSON body with `accountPassword`) → JSON backup; **provider API keys are stripped by design**
- `POST /api/settings/import` merges by id — existing items always win, secrets are never imported
- Both operations require account-password re-auth

### Security activity log (audit)
- `data/audit.json` — append-only, capped at the last 100 entries
- Records: setup, login/login-failed, logout-all(+failed), password-change(+failed), providers-lock-change(+failed), providers-unlock/unlock-failed, providers-relock, backup export/import — with timestamp + IP
- `GET /api/auth/audit` → last 50 entries, newest first (auth-protected, supports `limit`/`offset` params)
- Shown in Settings → Security Activity; auditing failures never break request flow

### Brute-force guard
- Dedicated `auth` rate-limit scope: **10 password verifications/min per IP** on login, setup, logout-all, providers-password set/remove, settings export/import
- Separate from the global 240/min budget — login attempts never starve normal API usage
- Exceeding returns `429` with `Retry-After`; verified via isolated-server hammer test

### Session revocation (logout everywhere)
- Every login token carries a `tv` claim matching `users.json → tokenVersion`; `verifyToken` rejects stale versions
- `POST /api/auth/logout-all` (account-password re-auth) bumps the version → all sessions die
- `changePassword` also bumps the version but returns a fresh token so the current session survives
- Legacy tokens without a `tv` claim are treated as version 0

### Beta
- App version: `2.0.0-beta` — badge shown in sidebar footer, login page and Settings → About

### Auto-logout (idle timeout)
- Configurable in Settings: off / 30 min / 60 min / 120 min (stored in `localStorage` as `wsd.idleTimeout`)
- Activity events (mousemove, keydown, click, touchstart, scroll) throttle-refresh the clock (5s cooldown)
- Cross-tab sync via `storage` event — changing the setting in one tab applies immediately in all tabs
- On expiry: clears token, removes user, redirects to `/login`

### Provider types & Azure OpenAI
- Types: `ollama | openai | anthropic | gemini | azure`; OpenAI-compatible providers can switch auth header via `auth: 'bearer' | 'api-key'`
- Azure (`type:'azure'`): `api-key` header enforced; requests go to `{host}/openai/deployments/{deployment}/chat/completions?api-version=…`; the model field carries the **deployment name** and the model dropdown lists deployments (`GET /openai/deployments`)
- Auto-detect recognizes `*.openai.azure.com` hosts and tries the deployment API first (Azure keys have no distinctive prefix)
- API version default `2024-10-21`, override with `WSD_AZURE_API_VERSION`
- Verification distinguishes auth/quota/rate-limit failures; health checks are cached server-side for 60s

### Key Patterns
- **WebSocket with HTTP fallback**: Project status/logs hooks try WS first, fall back to 5s polling; Agents chat uses exponential-backoff reconnect only (2s→16s)
- **Room-based connection limits**: Max 8 connections per WS room
- **ReAuthModal sudo pattern**: All sensitive ops (lock, backup, logout-everywhere, password change) require account-password re-auth via a unified modal

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

## Git Workflow

After every completed task + test + verification, commit to GitHub.
No uncommitted changes should remain after finishing a task.

```bash
git add -A
git commit -m "descriptive message"
git push
```

## Development Phases

The application progresses through three distinct phases:

### Phase 1: New Features
Adding new capabilities and functionality to the application.
Every new feature must be built, tested, and committed.

### Phase 2: Improvements
Enhancing and refining existing features.
Every improvement must be verified to not break existing behavior.

### Phase 3: Full Testing & Production Readiness
End-to-end testing based on real-world scenarios.
Act as a real user configuring the application for deployment.
The goal: a fully working production machine ready for daily use.

## Current Phase

**Phase 1: New Features**
