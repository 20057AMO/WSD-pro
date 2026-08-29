# AGENTS.md — Madar

> **Naming (2026-08)**: the product was renamed **WSD-Pro → Madar (مدار)**. All user-facing strings, docs and baked opencode content say Madar; the GitHub repo is now `20057AMO/madar` and backup downloads are named `madar-backup-*.json` (legacy `wsd-pro-backup` exports still importable). Deliberately KEPT for data/infra compatibility: `wsd.*` localStorage keys, `WSD_*` env vars, docker resource names (`wsd-pro` container, `wsd-pro-app` image, `wsd-<slug>` project containers, `wsd/workspace` image), JWT default-secret literals, the per-project goals filename `WSD_PROJECT.md`, and the legacy `wsd-pro-backup` import marker alongside the new `madar-backup`.

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
| Project lifecycle | `tests/projects.lifecycle.test.ts` | Real Docker: create → env → files → logs/stats/ports → stop/start → delete → 404; **duplicate** feature (copy source project: workspaces files + developer notes + **planning canvas** carried over, fresh ports applied, owner = duplicator) via `POST /api/projects/:slug/duplicate` |
| Project templates | `tests/project-templates.test.ts` | Runtime recipes CRUD (trim, dup-port collapse, invalid env-key drop, 400s for missing name / privileged / reserved ports), partial-update contract (explicit fields replace, omitted survive), editor-403 writes, real-Docker bootstrap from a template (env+ports inherited, request-level fields win, missing template 404) |
| Project snapshots | `tests/project-snapshots.test.ts` | Real Docker roundtrip: create source (file+notes+**canvas**+env+meta) → `GET /projects/:slug/export` (gzip magic + attachment filename) → `POST /projects/import` multipart → restored copy: files/notes/canvas/env/description preserved (canvas nodes/edges ids survive losslessly), ports fresh while source holds them, **manifest ports reused once the source is gone**, 404 unknown, non-member editor-export 403 + viewer-import 403, garbage/empty uploads 400, hand-crafted `../`-traversal tar 400 |
| Snapshot automation | `tests/project-snapshots-auto.test.ts` | Scheduled server-side backups: defaults + partial-config validation, capture-now (archive on disk + lastSnapshotAt stamp), **retention pruning to `keep`**, download (gzip+filename) → delete → 404, restore filed snapshot into a brand-new project (files/notes/**canvas**/description), member-viewer read-only vs outsider 403 matrix, and pure `computeDueSnapshots` interval rules (import-free `snapshots-schedule.ts`, like janitor-core) |
| Project team & access | `tests/team-access.test.ts` | Real Docker: owner creates project → creates editor+viewer users → adds members → permission matrix (viewer read-only/403s, editor read+write+stop/start, member add denied, **viewer duplicate 403**), remove rules, outsider 403, ownership transfer → deletes project + temp users |
| Providers/Agents/Chat CRUD | `tests/providers-agents-chat.test.ts` | Full CRUD + sessions + templates |
| Providers lock & backup | `tests/providers-lock.test.ts` | Lock flow E2E (needs `WSD_TEST_ACCOUNT_PASSWORD`; self-skips without it) |
| Providers page journey | `tests/providers-page-journey.test.ts` | Live-audit gaps: detection_required shape, duplicate guards, masked-key echo (POST+PUT), chat open while locked, cross-session replay via REAL logins, cooldown bans even the correct password (isolated server only; canary self-skips lock sections while the 15-min ban from a previous run is active) |
| Secret box (at-rest crypto) | `tests/crypto.test.ts` | AES-256-GCM roundtrip, fresh-IV, tamper→empty, mask-without-decrypt + API-level sealing of providers.json (file assertions when `WSD_TEST_PROVIDERS_FILE` points at the server's data dir; set `WSD_DATA_DIR` to the same dir so the test process shares the server's salt) |
| Workspace janitor | `tests/janitor.test.ts` | Orphan archiving, live-project safety, dot-dir skip, archive purge (`WSD_ARCHIVE_DAYS=0`) — offline, temp dirs only |
| Opencode Studio | `tests/opencode-studio.test.ts` | Full baked roster (27 agents / 10 skills / 8 slash commands), agent+skill+command CRUD lifecycles, kebab-name + traversal rejection, frontmatter-required command writes, **roster integrity check** (every baked file: frontmatter present, zero NUL bytes, description non-empty — regression guard after a skill once shipped as pure NULs), config merge preserves keys / rejects junk, version-info shape (against running container) |
| Security | `tests/security.test.ts` | Path traversal, upload sanitization, malformed auth headers |
| Smoke | `tests/smoke.test.ts` | Health, core endpoints, project roundtrip |
| Project notes | `tests/project-notes.test.ts` | Notes CRUD + validation (junk body 400, cap 300, truncation, kind normalization) + AI-context injection (`[Developer notes]` section ordering, done-items omitted) + 'all'-brief per-project counts |
| Project canvas | `tests/project-canvas.test.ts` | Visual-planning whiteboard: GET default-empty vs seeded roundtrip, viewer/editor/outsider 403 matrix, junk body 400 + node/edge caps + bounds normalization, node id churn on alternating writes (fresh ids each save — canvases never merge garbage from stale clients), `PUT` audits `canvas-save`, **`canvasEditedAt` appears on the project list after a save**, the `[Planning canvas]` AI-context block renders sticky notes + task cards flat text (empty canvas → absent section), and the 'all' brief appends `— board: N nodes` once a project has a board |
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
| `/project/:slug` | Project | Detail: overview, AI chat, files, logs, **notes**, **canvas** (visual planning whiteboard), scripts (per-project terminal moved to global Terminals page) |
| `/planner` | Planner | Visual planning hub: cards for every project with canvas state + last-edit recency, filter + sort; card opens the project straight on its Canvas tab (`?tab=canvas` deep link) |
| `/terminals[/:slug]` | Terminals | Global terminal hub: all projects in one page — project picker (live status dots + search + last-used memory) driving the SAME ProjectTerminal component (tabs, project/control modes, history, zoom, reconnect, quick commands); deep-linkable via `/terminals/<slug>` |
| `/agents` | Agents | AI agents with chat, RTL/LTR, presets |
| `/providers` | Providers | LLM provider config |
| `/settings` | Settings | Change password, account info, logout |
| `/ide` | EmbeddedIDE | code-server iframe ("VS Code" branding with official mark) |
| `/opencode` | Opencode | opencode web iframe |
| `/opencode-studio` | OpencodeStudio | subagents/skills/commands/config CRUD + gated update button + bilingual User Guide tab |

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
- **Brand honesty**: sidebar uses the REAL product marks — `components/brand-icons.tsx` embeds the official opencode logo (opencode + OC Studio nav) and the official VS Code mark (nav label "VS Code", formerly "Web IDE"; EmbeddedIDE toolbar/empty-states renamed too)
- **ConfirmModal** replaces native `window.confirm()` for destructive/sensitive actions (project delete single/bulk, container restart/recreate, file delete, provider delete, agent delete, unlock-badge "Lock now") — dark modal matching ReAuthModal; danger variant shows warning avatar + red button and the title always names the exact target; in-app notices replace `alert()` (e.g. IDE-not-running yellow banner)
- App theme: **dark mode only**
- Version string: `2.0.0-beta` (health, server/info, About panel, backups all aligned)

### Project notes (ideas / bugs / goals)
- Per-project structured notes stored in `data/projects/<slug>/notes.json` (`services/project-notes.ts`): items `{id, text, kind: 'idea'|'bug'|'goal', done, createdAt}` — ≤300 items, text ≤2000 chars, junk rows dropped silently on normalize, unknown kinds default to `idea`
- API: `GET/PUT /api/projects/:slug/notes` (full-document PUT; 400 without `items` array or over cap) — covered by `tests/project-notes.test.ts`
- Project page tab "Notes" (NotesPanel) replaced the per-project terminal: quick composer with kind selector (Ctrl+Enter), filter chips with live counts, done toggle (completed hidden by default + "Show completed"), delete
- **Smart context**: `formatNotesForContext()` renders open bugs → active goals → ideas into the AI context block (section `[Developer notes]`, priority right after WSD_PROJECT.md goals, ~2500 char cap, done items summarized as a count); `noteCounts()` appends `— notes: N open bug(s), M active goal(s)` to every project line in the 'all' brief; the context cache key includes a notes mtime:size signature so edits invalidate immediately
- ws-chat and ws-agent inherit everything automatically via `getProjectContext` — no per-surface wiring

### Settings Backup (export/import)
- `POST /api/settings/export` (JSON body with `accountPassword`) → JSON backup; **provider API keys are stripped by design**
- `POST /api/settings/import` merges by id — existing items always win, secrets are never imported
- Both operations require account-password re-auth

### Project snapshots (export / restore)
- `services/project-snapshots.ts` — hand-rolled POSIX-ustar tar writer (no `tar`/`archiver` dep, streaming via `Readable.from(async generator)` → `zlib.createGzip`) + hardened parser (ustar magic, `../`-traversal rejection, `<root>`-escape proof, cap 200k entries, 1 GiB gunzip bomb guard)
- `GET /api/projects/:slug/export` (editor+ on that project) streams `madar-<slug>-<stamp>.tar.gz` = `manifest.json` (format `madar:1` + name/description/image/ports/env) + `notes.json` + `canvas.json` (only when the board is non-empty; never blank-annotifies a restore) + `workspace/**`; audited `snapshot-export`
- **Heavy regenerable dirs excluded** (`EXCLUDE_DIRS`: `.git`, `node_modules`, `__pycache__`, `.venv`, `.next`, `dist`, `build`, `target`, `vendor`, …) — a snapshot is source + notes + config, keep it lean
- `POST /api/projects/import` (editor+, multer single `file`, ≤200 MB) restores into a **brand-new** project — never overwrites: unique slug (`base-1 …`), manifest ports reused when free else fresh (seeks from 8000), owner = restorer; audited `snapshot-import`; temp upload + staging dir always cleaned
- UI: Project page header "Export" (blob download), Projects toolbar "Restore" (file picker → navigates to the new project); frontend helpers `exportProjectSnapshot`/`importProjectSnapshot` in `api.ts`

### Snapshot automation (scheduled server-side backups)
- Per-project schedule stored in `meta.json` (`snapshot: {enabled, intervalMin, keep}` + `lastSnapshotAt`); archives live at `WSD_DATA_DIR/projects/<slug>/snapshots/madar-<slug>-<stamp>.tar.gz` (same streamed format as browser export) and die with the project (`deleteMeta` removes them too)
- **Scheduler** (`services/project-snapshots-auto.ts`): a `runSnapshotSweep` pass every `WSD_SNAPSHOT_SWEEP_MS` (default 5 min, min 10s) captures every enabled project whose gap since `lastSnapshotAt` ≥ `intervalMin` (allowed: 1h·3h·6h·12h·24h·7d), kept to `keep` newest (≤20); re-entrancy guard, per-project error isolation, deferred 5s sweep when a schedule flips on (and at boot) so the first copy lands promptly
- **Pure rules in `snapshots-schedule.ts`** (import-free, like janitor-core): `computeDueSnapshots` + `sanitizeSchedule` (invalid `intervalMin`/`keep` fall back to previous config, not the junk input)
- API: `GET /projects/:slug/snapshots` (viewer+ list), `GET/PUT …/snapshots/config` (viewer+ read / editor+ write), `POST …/snapshots` (capture-now), `GET …/snapshots/:file` (download), `DELETE …/snapshots/:file`, `POST …/snapshots/:file/restore` → new project; `:file` gated by a strict `madar-<slug>-<17-digit-stamp>.tar.gz` regex (traversal-proof); audited `snapshot-save`/`-download`/`-delete`/`-restore`/`-config-change`
- UI: Project → Snapshots tab (SnapshotsPanel): schedule toggle + frequency/keep selects, "Capture now", stored versions with download / restore-as-new-project (ConfirmModal) / delete (danger ConfirmModal)

### Workspace janitor & IDE/opencode hygiene
- Deleting a project now removes EVERYTHING: container + meta store **and its workspace files from disk** (`removeProject`); opencode sessions for that directory are deleted best-effort (`unregisterOpencodeProject`)
- `services/workspace-janitor.ts` sweeps `/workspaces` at boot (+ every `WSD_JANITOR_INTERVAL_MS`, default 15min, plus an event-driven sweep right after every project create/delete): dirs without a live meta store are MOVED to `/workspaces/.archive/<ts>-<slug>` and purged permanently after `WSD_ARCHIVE_DAYS` (default 7). Pure logic in `janitor-core.ts` (import-free so node --test can load it)
- code-server is rooted at `/workspaces` — archived dot-dir keeps it ghost-free; `entrypoint.sh` registers ONLY live-project dirs into opencode and purges stale rows from its SQLite store (`project`/`project_directory`) BEFORE launching it; `removeProject` and janitor archiving call `purgeOpencodeProjectRows` (`services/opencode-store.ts` → `docker/opencode-purge.py`) so deleted projects vanish from opencode immediately, no restart needed (covered by `tests/opencode-purge.test.ts`, self-skips without host python3). The purge script introspects the SQLite schema (`PRAGMA table_info`) and skips safely with a stderr note when columns don't match expectations — future-proof against opencode major upgrades
- Creating a project whose slug collides with an orphaned non-empty dir returns 409 (janitor archives it within minutes)
- EmbeddedIDE no longer shows the cosmetic code-server password (server runs `--auth none`); Opencode page has a live-project picker (`POST /api/opencode/open` ensures a session exists)

### Opencode Power Pack (Studio, presets, gated updates)
- **Pinned baseline**: Dockerfile installs `opencode-ai@1.18.22`; repo-root `opencode.json` (copied to `/root/.config/opencode/`) carries `$schema`, provider config and `subagent_depth: 2`
- **Baked roster (v3 — full SDLC coverage, English prompts, trigger-engineered descriptions)**: 27 subagents in `opencode/agents/*.md` — planning/design: architect · ux-designer; implementation: frontend-developer · backend-developer · db-expert · websocket-engineer · data-engineer; quality: code-reviewer · test-writer · refactorer · debugger · perf-optimizer · accessibility-auditor (read-only); security: security-auditor (read-only) + pentester (active, bash-only with hard limits); ops/reliability: devops-engineer · release-manager · incident-responder (bash-only, edit-denied) · log-analyst · observability-engineer; APIs/docs: api-designer · doc-writer; platform: wsd-expert; languages: python-expert · golang-expert · rust-expert; LLM advisory: prompt-engineer. Reviewers are `edit: deny`+`bash: deny`, implementers `allow/allow`, pentester/incident-responder bash-only. Every file follows the authoring template: `Use when…`/`Use PROACTIVELY when…` in description (MISSING_TRIGGER-style), `## When invoked`, one Input→Output few-shot example, `## Handoffs` cross-references (security-auditor→pentester, architect→implementers, reviewer→debugger…), closing principle line
- **10 skills** in `opencode/skills/<name>/SKILL.md`: clean-code, docker-debug, git-release, wsd-workflow (house rules) + planning-methodology, debugging-methodology, testing-strategy, security-hardening, api-design-guidelines, performance-profiling
- **8 slash commands** in `opencode/command/*.md` (`$ARGUMENTS` templates bound to agents): review→code-reviewer, audit-security→security-auditor, plan-feature→architect, tdd→test-writer, fix-issue→debugger, refactor-safely→refactorer, explain-code→doc-writer, release→release-manager
- CRLF stripped at build for ALL of the above so Windows checkouts don't poison frontmatter
- **Unified adapter** (`services/opencode-api.ts`): all opencode session CRUD goes through one facade; `SUPPORTED_MAJORS=[1]` is the capability gate — version probe (`opencode --version`, cached) feeds it, and future v2 enablement means adding V2 impls + flipping the array, NOT touching call sites
- **Opencode Studio page** (`/opencode-studio`): tabs Subagents | Skills | Commands | Config | Guide; full CRUD on `/root/.config/opencode/{agents,skills,command}` via `/api/opencode-studio/*` (kebab-case names enforced, traversal-proof `safeJoin`, CRLF-normalized writes, frontmatter parsed for list descriptions/mode/@agent badges); command saves REQUIRE frontmatter markers (400 without); Config tab edits are MERGED into `opencode.json` with `$schema` protected and unknown keys preserved; deletes audited
- **Studio UX helpers**: list filter box (name+description, client-side), copy-description button per row (paste into chat to summon a specialist by name, check-mark feedback), and a live trigger-lint warning above the editor when a description lacks a `Use when…` phrase (non-blocking — MISSING_TRIGGER standard)
- **User Guide tab**: bilingual AR/EN (`studio-guide.tsx`, toggle persisted in `localStorage['wsd.studio.guideLang']`, RTL for Arabic) teaching how to drive subagents/skills/commands: mental model, auto vs explicit delegation, slash-command table with bound agents, permissions matrix (why reviewers are read-only), workflow recipes (feature/bug/security/incident), effective-prompting rules; the two roster tables pull LIVE agent/skill lists from the existing APIs so the guide never goes stale after Studio edits
- **Update button (Desktop-style)**: `GET /api/opencode-studio/version` → `{current, latest, upToDate, channelUnlocked, supportedMajors}`; `POST /update` single-flights an `npm i -g opencode-ai@<latest>` then SIGTERMs the supervised web process — entrypoint's while-loop revives the new binary in ~2s (child PID published in `data/opencode-web.pid`). **Gotcha fixed**: inherited `set -e` made a bare `wait` fatal on rc=143, silently killing the supervisor exactly when an update killed opencode — status captured via `wait ... || RC=$?`
- **Major-gate UX**: if npm latest is a major outside `SUPPORTED_MAJORS`, the button locks to "{version} needs a Madar update" instead of bricking the install
- **E2E-verified behavior (live runs, 2026-08)**: task-tool delegation enforces subagent permissions structurally — security-auditor spawned with NO write-capable tools (read/grep/glob only) and refused edits by policy; primary correctly picked code-reviewer for post-change security review (trigger descriptions working); on a provider outage mid-subagent, the primary degraded gracefully and self-completed the review citing the security-hardening skill; scrypt+salt+timingSafeEqual implementation shipped with 11/11 passing tests. Known opencode quirk (upstream, harmless here): running an agent DIRECTLY via `opencode run --agent <name>` bypasses its frontmatter permission deny — permissions only bind on task-tool delegation, which is how real sessions use subagents

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
