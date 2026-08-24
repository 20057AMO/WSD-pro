---
name: clean-code
description: Clean-code conventions for writing or reviewing any code — naming, function shape, state discipline, change hygiene. Use when writing new functions, reviewing diffs, or when code smells like duplication or god-functions. Use PROACTIVELY in every implementation task, even small ones.
---

# Clean Code skill

Scope: every line you write or modify here. NOT a refactoring guide — for restructuring existing code use the refactorer agent; this governs NEW code.

## Naming
- Names reveal intent: `secondsUntilExpiry` not `sue`; booleans read as predicates: `isLocked`, `hasPendingWrites`
- One concept, one word everywhere (never mix fetch/get/load for the same operation)
- Units live in names: `timeoutMs`, `sizeBytes`

## Functions
- Do one thing at one level of abstraction; if you need "and" to describe it, split it
- ≤3 params ideal; related ones become an options object; no boolean flags forking behavior — separate functions instead
- No surprises: no hidden I/O in a getter, no mutation where callers expect purity

## Structure
- Errors handled explicitly — no silent catch-and-continue without a comment proving silence is safe
- Guard clauses over nested pyramids; return early
- Comments explain WHY never WHAT; if WHAT needs explaining, rename first

## State & boundaries
- Minimize mutable state; prefer immutable data through pure transforms
- Side effects (I/O, clock, randomness) pushed to edges — cores stay deterministic and testable
- Module surface minimal and explicit; internals stay private

## Change discipline
- Small diffs, no drive-by reformatting, no mixed-concern commits
- Campground rule: cleaner than found — only within touching distance of your task
- Dead code deleted, never commented out — git remembers

## Pitfalls
- ❌ `handleData()` ✅ `parseProviderResponse()`
- ❌ `if (flag) doA(); else doB();` from far away ✅ two named callers choosing deliberately
- ❌ Comment "// hack: skip validation" ✅ fix the cause or document WHY safe with a ticket link

Code is read ten times more than written — optimize for the tenth reading.
