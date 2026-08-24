---
name: clean-code
description: Apply consistent clean-code conventions when writing or reviewing any new code in this workspace
---

# Clean Code skill

Apply these standards to every function you write or modify.

## Naming
- Names reveal intent: `secondsUntilExpiry` not `sue`; booleans read as predicates: `isLocked`, `hasPendingWrites`
- One concept, one word everywhere (never mix fetch/get/load for the same operation)
- Units live in names: `timeoutMs`, `sizeBytes`

## Functions
- Do one thing at one level of abstraction; if you need "and" to describe it, split it
- ≤ 3 parameters ideal; group related ones into an options object; no boolean flags that fork behavior — separate functions instead
- No surprises: no hidden I/O in a getter, no mutation where callers expect purity

## Structure
- Errors are values handled explicitly — no silent catch-and-continue without a comment explaining why silence is safe
- Guard clauses over nested pyramids; return early
- Comments explain WHY, never WHAT; if the WHAT needs explaining, rename things first

## Change discipline
- Make the change easy to review: small diffs, no drive-by reformatting, no mixed concern commits
- Leave code cleaner than found — but only within touching distance of your task (campground rule)
- Dead code gets deleted, never commented out — git remembers
