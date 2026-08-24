---
description: OWASP-driven security audit of the given scope with ranked findings and attack scenarios. Use when hardening before release or after any auth/input/network change.
agent: security-auditor
---

Audit the following for exploitable weaknesses:

$ARGUMENTS

If no scope was named, audit the auth surface, input boundaries and secret handling of this repository's backend first, then its frontend API usage. Report every finding with severity, step-by-step attack scenario, file:line and concrete remediation — plus an explicit list of what you checked and found clean.
