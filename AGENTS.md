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
| Providers page journey | `tests/providers-page-journey.test.ts` | Live-audit gaps: detection_required shape, duplicate guards, masked-key echo (POST+PUT), chat open while locked, cross-session replay via REAL logins, cooldown bans even the correct password (isolated server only; canary self-skips lock sections while the 15-min ban from a previous run is active) |
| Secret box (at-rest crypto) | `tests/crypto.test.ts` | AES-256-GCM roundtrip, fresh-IV, tamper→empty, mask-without-decrypt + API-level sealing of providers.json (file assertions when `WSD_TEST_PROVIDERS_FILE` points at the server's data dir; set `WSD_DATA_DIR` to the same dir so the test process shares the server's salt) |
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

### Two-Factor Authentication (optional TOTP)
- RFC 6238 TOTP implemented from scratch in `backend/src/services/totp.ts` (HMAC-SHA1, 30s steps, 6 digits, ±1 step drift) — verified against the official Appendix B vectors in `tests/totp.test.ts`; compatible with Google Authenticator/Authy/Aegis
- **Login flow with 2FA on**: `POST /api/auth/login` verifies credentials then returns `{requires2fa:true, pendingToken}` — a 5-min JWT (`scope:'2fa-pending'`), NOT a session. `POST /api/auth/login/verify {pendingToken, code}` exchanges it for a real session; guarded by a dedicated `totp` rate-limit scope (8/min/IP)
- Enrollment: `POST /api/auth/2fa/setup` → `{secret, uri}` (pending secret, disabled until proven); `POST /api/auth/2fa/enable {code}` activates only after a live code verifies; `POST /api/auth/2fa/disable {accountPassword}` requires sudo re-auth
- Frontend: Login shows an authenticator-code step when `pending2fa` is set in AuthProvider; Settings → Two-Factor panel renders the QR (`qrcode` npm pkg) + manual base32 key, activate/cancel, disable via ReAuthModal
- Audit: `2fa-enabled/-failed`, `2fa-disabled/-failed`, `login-2fa-failed`
- **Lost authenticator**: self-hosted recovery = remove `totp` from `data/users.json` and restart (documented in UI copy as admin-level escape hatch)

### Providers Security Lock (optional second layer)
- Separate bcrypt password stored in `users.json` (`providersPasswordHash`) — independent from the account password
- Managed exclusively from Settings → Providers Security via a **two-step sudo-style flow**: pick the new lock password, then confirm identity in `ReAuthModal` (shows the signed-in username, asks for the account password)
- The same `ReAuthModal` pattern authorizes every sensitive op: lock save/remove, backup export/import, logout-everywhere
- Unlock issues a scoped JWT (`scope:'providers'`, 30 min) sent as `X-Providers-Unlock`; version counter (`pv`) invalidates all unlock tokens on password change
- **Session-bound unlock**: login tokens carry a random `jti`; the unlock token embeds it as `sid` and `providersLockMiddleware` requires a match with the requesting session — a stolen unlock token replayed from another session is rejected (legacy tokens without `jti` use `''` consistently on both sides)
- **Strict instant gate (frontend)**: Providers page persists last-known lock state in `localStorage['wsd.providers.lockEnabled']` — when a lock is known-enabled and no valid local token exists, the gate renders on first paint before any network call, so provider content can never flash. Expiry is re-checked every 1s plus on `pageshow`/`visibilitychange` (bfcache/sleep-wake safe)
- **Wrong-password never logs out**: every intentional password-verification call (`unlockProviders`, providers-password set/remove, logout-all, settings export/import, 2FA disable) passes `skipAuthRedirect: true` so its 401 surfaces as an inline message instead of triggering the global session-expiry handler in `api()` (which wipes the token and redirects to `/login`)
- Unlock feedback: success shows an "Unlocked · N min" notice; the no-lock-configured case (`{unlocked:true}` without a token) explains that protection is off instead of silently accepting any word; welcome modal ("Protect your API keys") shows once per browser (`wsd.providers.onboarded` in localStorage)
- **Gate never silent**: when the gate appears it says why — `Auto-relocked after inactivity.` (idle timer breadcrumb in `sessionStorage['wsd.providers.autoRelocked']`, set by auth.tsx) or `Your unlock window ended.` (1s tick expiry detection)
- `POST /api/providers/unlock` is brute-force guarded by a **dedicated `unlock` limiter scope (15/min)** plus a progressive cooldown (5 consecutive failures per IP → 15-min window returning `429` + `Retry-After`, in-memory, reset on success); audited (`providers-unlock` / `providers-unlock-failed` / `providers-unlock-cooldown`)
- **Scoped tokens are never sessions**: `verifyToken` rejects any JWT carrying a `scope` claim, so providers-unlock and 2FA-pending tokens cannot authenticate generic routes even though they share the signing secret
- **Auto-relock**: Settings → Idle security offers an idle timer ('off'/5/15/30 min, stored as `wsd.providersAutoRelock`) that calls relock + clears the local token after inactivity; same activity-throttle + cross-tab storage-sync machinery as auto-logout
- **Unlock badge**: sidebar shows "🔓 Providers · Nm" only while unlocked (countdown from `expiresAt`); click → confirm → instant relock
- Enabling/changing the lock returns a ready-to-use unlock token — the current session stays open on the Providers page (no immediate re-entry)
- `POST /api/providers/relock` ("Lock now") bumps the version server-side — kills every outstanding unlock token across all tabs/devices; audited (`providers-relock`)
- Unlock token lives in `localStorage` (time-boxed by its expiry) so the `storage` event keeps all tabs in sync about lock state
- When enabled, management endpoints return `403 {error:'providers_locked'}` without a valid token
- Always-open endpoints: `GET /api/providers/options` (id/name/type only) and `GET /api/providers/templates`
- Chat/agent LLM usage is server-side and never blocked by the lock
- Providers page UX states: skeleton shimmer (checking) → welcome modal explaining protection (when unconfigured, dismissible per tab session) → centered login-style unlock modal (when locked)

### At-rest encryption (secret box)
- Provider API keys in `data/providers.json` are sealed with AES-256-GCM (`backend/src/services/secret-box.ts`): format `enc1:<iv>:<tag>:<ct>:<last4>`
- Key = scrypt(`WSD_ENCRYPTION_KEY` env → falls back to `JWT_SECRET`, salt persisted once in `data/crypto.salt`, mode 0600); rotating the master secret makes old blobs open to `''` (upstream auth failures — re-enter keys from the UI)
- Migration is automatic: on first load any plaintext key is sealed and the file rewritten; masking uses the stored `<last4>` so it never decrypts; duplicate detection opens values transparently
- Backup export strips keys entirely (unchanged), so ciphertext never leaves the server either
- **Lost/rotated key recovery**: delete `crypto.salt` only if starting fresh — otherwise restore the previous env value; plaintext keys pasted by users are re-sealed on next save

### Security hardening (post-audit)
- `WSD_TRUST_PROXY=1` opts into trusting one reverse-proxy hop for `req.ip`; default is OFF so directly-published ports can't spoof `X-Forwarded-For` past the rate limiters
- SSRF guard on provider detection/testing: hosts must be http(s); cloud-metadata endpoints (`169.254.x`, `metadata.google.internal`, `100.100.100.200`, link-local) are refused before any fetch — private LAN/loopback stays allowed (local Ollama is a core feature)
- Masked-key echo guard rejects both pure bullets and the displayed `<8 bullets><last4>` shape
- Provider ids are own-property checked (`__proto__` etc. → 404); `providers.json` / `users.json` / `audit.json` persist with mode 0600
- Startup banner warns when `JWT_SECRET` is missing or a known default
- CORS is **opt-in** via `WSD_CORS_ORIGINS` (comma-separated allowlist) — no env set means no ACAO headers at all; the UI is always same-origin (vite dev proxies `/api` + `/ws`), so a wildcard would only ever help attacker sites read the authenticated API
- Provider health-check cache keys hash the API key with SHA-256 — raw secrets never sit in memory-map keys
- Chat markdown href filter is a scheme **whitelist** (`http:`/`https:`/`mailto:`/`#`/`/`) after stripping control chars, so `java\tscript:` obfuscation can't reach the DOM

### UI conventions
- Icons: **lucide-preact** everywhere (`class="icon"`, spin via `.icon.spin`) — agent preset icons are stored data and stay as-is
- **ConfirmModal** replaces native `window.confirm()` for destructive/sensitive actions (project delete single/bulk, container restart/recreate, file delete, provider delete, agent delete, unlock-badge "Lock now") — dark modal matching ReAuthModal; danger variant shows warning avatar + red button and the title always names the exact target; in-app notices replace `alert()` (e.g. IDE-not-running yellow banner)
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
