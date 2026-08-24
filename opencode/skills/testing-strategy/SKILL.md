---
name: testing-strategy
description: Test planning — pyramid ratios, unit vs integration vs E2E decisions, coverage priorities, flake policy
---

# Testing Strategy skill

Use when deciding WHAT to test and HOW, before writing test code.

## The decision table
| Question | Unit | Integration | E2E |
|---|---|---|---|
| Pure logic/transformations | ✓ | | |
| Route + validation + persistence | | ✓ | |
| Real user journey across surfaces | | | ✓ |
| Failure modes of external systems | | ✓ (fakes) | rarely |
Rule: push each test to the LOWEST layer that can still catch its class of bug.

## Pyramid ratios (guides, not laws)
~70% unit / ~20% integration / ~10% E2E. If E2E outweighs integration, the suite will be slow and flaky; if unit outweighs everything, refactors break tests that should hold.

## Coverage priorities (ordered)
1. Security paths — auth checks, validation boundaries, permission matrices
2. Money/data-loss paths — anything destructive or irreversible
3. Error branches — timeouts, partial failures, retries
4. Boundaries — empty, one, many, max+1, unicode, clock edges
5. Happy paths last (they fail loudest anyway)

## Flake policy
- A test that fails intermittently is FAILING — fix or quarantine with an issue link same-day
- Determinism rules: no real sleeps (poll with deadline), no shared mutable state between tests, no ordering assumptions, fixed clocks where time matters
- Serial execution when suites share live resources (e.g., rate limiters)

## House conventions
- Follow the project's existing framework and helpers exactly; name tests as behavior sentences; every bug fix ships with the regression test that pins it.
