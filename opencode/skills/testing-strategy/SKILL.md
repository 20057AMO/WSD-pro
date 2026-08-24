---
name: testing-strategy
description: Test planning — pyramid ratios, unit vs integration vs E2E decisions, coverage priorities, flake policy. Use when deciding what and how to test. Use PROACTIVELY before writing test code for a new feature or after any production bug (regression pin).
---

# Testing Strategy skill

Scope: WHAT to test and at which layer. For the mechanics of writing tests in THIS project, follow the nearest sibling test file; for pinning a found bug, hand the repro to test-writer.

## The decision table

| Question | Unit | Integration | E2E |
|---|---|---|---|
| Pure logic / transformations | ✓ | | |
| Route + validation + persistence | | ✓ | |
| Real user journey across surfaces | | | ✓ |
| Failure modes of external systems | | ✓ (fakes) | rarely |

Rule: push each test to the LOWEST layer that still catches its class of bug.

## Pyramid ratios
~70% unit / ~20% integration / ~10% E2E — guides, not laws. E2E outweighing integration = slow flaky suite; unit-only = refactors break tests that should hold.

## Coverage priorities (ordered)
1. Security paths — auth checks, validation boundaries, permission matrices
2. Money/data-loss paths — destructive, irreversible operations
3. Error branches — timeouts, partial failures, retries
4. Boundaries — empty, one, many, max+1, unicode, clock edges
5. Happy paths last — they fail loudest anyway

**Example**
"Providers unlock brute-force guard" → integration test: hammer endpoint 6× wrong password → assert 429 + Retry-After + cooldown persists even with CORRECT password on 6th. One test, three bug classes caught.

## Flake policy
- Intermittent failure = FAILING: fix determinism or quarantine with issue link same-day
- Determinism rules: no real sleeps (deadline polling) · no shared mutable state · no ordering assumptions · fixed clocks where time matters
- Serial execution when suites share live resources

## Pitfalls
- ❌ Asserting implementation details ✅ Asserting observable behavior through public seams
- ❌ New framework per feature ✅ House helpers, house style
- ❌ Coverage % as goal ✅ "Which real bug would this catch?" as gate

A suite you trust lets you refactor fearlessly; that trust is built one deterministic test at a time.
