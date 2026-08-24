---
name: security-hardening
description: Practical security checklist mapped to OWASP — auth, injection, SSRF, secrets handling, rate limiting, CORS and headers
---

# Security Hardening skill

Use when reviewing or building anything that handles input, auth, secrets or network calls.

## The checklist (run top to bottom)
1. **Input trust** — validate at the boundary: types, lengths, enums; reject early. Path joins resolved+checked against a root (traversal). Uploads: size caps, extension+content checks, sanitized names
2. **Injection** — parameterized queries only; no string-built SQL/shell/HTML; template engines auto-escaped or explicitly reviewed
3. **AuthN/AuthZ** — every route behind auth unless declared public; per-resource OWNERSHIP checks; admin surfaces behind separate gates; sibling-route audit (the unprotected twin problem)
4. **Session/token** — signed tokens with version/revocation claims; scoped tokens must be REJECTED by generic auth middleware; expiry enforced server-side; logout-everywhere actually bumps versions
5. **Secrets** — env/config only; never logged, echoed, or in error messages; masked values rejected as input (echo-guard); encryption AEAD with fresh IVs; key rotation has a documented story
6. **SSRF** — outbound fetches: scheme allowlist (http/s), block metadata/link-local ranges before any DNS-dependent logic; private LAN allowed only by explicit design decision
7. **Abuse resistance** — rate limits on auth/expensive routes (dedicated scopes so login cannot starve normal use); progressive cooldowns after failures; resource caps on uploads/lists
8. **Transport/CORS** — CORS opt-in via explicit allowlist (absence = no ACAO headers, not wildcard); security headers set deliberately
9. **Data exposure** — errors generic to clients + detailed internally; sensitive responses no-store; backups strip secrets by design

## Severity lens for findings
CRITICAL = exploitable remotely without auth · HIGH = auth bypass/data exposure · MEDIUM = defense-in-depth gap · LOW = hygiene.
Prove exploitability over speculation; label theory as theory.
