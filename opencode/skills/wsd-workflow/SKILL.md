---
name: wsd-workflow
description: WSD-Pro project conventions — build gates, Docker rebuild rule, test suite, commit discipline
---

# WSD-Pro Workflow skill

Use when working inside the WSD-Pro repository so every change follows house rules.

## The non-negotiables
1. **Docker rebuild rule**: after ANY change to `frontend/` or `backend/`:
   ```
   docker compose build app && docker compose up -d app
   ```
   Every feature must be tested inside the running container. No exceptions.
2. **Local gates before Docker**:
   - `cd frontend && node node_modules\typescript\bin\tsc --noEmit`
   - `cd frontend && node node_modules\vite\bin\vite.js build`
   - `cd backend && node node_modules\typescript\bin\tsc --noEmit`
3. **Full suite** (server up on :3000):
   ```
   cd backend && node --test --test-concurrency=1 "tests/**/*.test.ts"
   ```
   Serial only — parallel runs trip the rate limiter.
4. **Commit discipline**: after task + tests + verification → `git add -A`, descriptive message, push, watch CI to green.

## Area-by-area method (بالقطع)
- One feature/area per round; never jump between unrelated areas
- Understand full context + vertical goal BEFORE any code change
- Ask clarifying questions before starting new work

## House style
- Icons: lucide-preact (`class="icon"`); ConfirmModal for destructive actions; dark mode only; version `2.0.0-beta`
- Security defaults: opt-in CORS, SSRF guards on metadata IPs, scoped JWTs never pass generic auth, secrets sealed with AES-256-GCM

## Windows host quirks
- PowerShell: no `&&` — use `if ($?)`; git stderr prints as PS errors harmlessly
- Container scripts: write to temp file + `docker cp` + exec, never inline-quote complex sh through PowerShell
