---
name: security-hardening
description: Practical OWASP-mapped security checklist — auth, injection, SSRF, secrets handling, rate limiting, CORS. Use when building or reviewing anything touching input, auth, secrets or network calls. Use PROACTIVELY before any release and after any auth/data-boundary change.
---

# Security Hardening skill

Scope: finding and fixing weaknesses in THIS application's code/config. For exploit PROOF, hand confirmed findings to pentester; this skill is the builder's checklist.

## The checklist (run top to bottom)
1. **Input trust** — validate at boundary: types/lengths/enums; reject early. Path joins resolved+checked against root. Uploads: size caps, extension+content checks, sanitized names
2. **Injection** — parameterized only; no string-built SQL/shell/HTML; auto-escape or explicitly review templates
3. **AuthN/AuthZ** — every route behind auth unless declared public · per-resource OWNERSHIP checks · sibling-route audit (the unprotected twin problem)
4. **Session/token** — signed tokens with revocation claims · scoped tokens REJECTED by generic auth middleware · expiry enforced server-side · logout-everywhere bumps versions
5. **Secrets** — env/config only · never logged/echoed/in errors · masked values rejected as input · AEAD with fresh IVs · rotation story documented
6. **SSRF** — outbound fetches: scheme allowlist + metadata/link-local ranges blocked BEFORE DNS-dependent logic; private LAN only by explicit design
7. **Abuse resistance** — rate limits on auth/expensive routes in DEDICATED scopes · progressive cooldowns after failures · caps on uploads/lists
8. **Transport/CORS** — opt-in allowlist (absence = no ACAO headers, never wildcard) · deliberate security headers
9. **Data exposure** — generic client errors + detailed internal logs · sensitive responses no-store · backups strip secrets by design

## Severity lens
CRITICAL remote-no-auth · HIGH auth bypass/exposure · MEDIUM defense-in-depth gap · LOW hygiene. Prove > speculate; label theory as theory.

**Example pass**
```
New endpoint POST /api/hooks → checklist hit #3: no auth middleware!
Fix: mount behind authMiddleware + ownership check on hook.resourceId,
+ dedicated limiter scope (it triggers outbound fetches = expensive).
```

## Pitfalls
- ❌ Trusting localhost/private LAN implicitly ✅ Same validation at every boundary
- ❌ Logging tokens "temporarily for debugging" ✅ Masked always, everywhere, forever
- ❌ Wildcard CORS "just for dev" leaking to prod ✅ Opt-in env allowlist

Security is a checklist you run when tired, not a mood you have when inspired.
