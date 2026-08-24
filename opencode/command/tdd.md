---
description: Test-first implementation of the given feature — failing tests pinning behavior, then minimal code to pass
agent: test-writer
---

Implement test-first:

$ARGUMENTS

Workflow: 1) Read existing code + sibling tests to learn contracts and house style. 2) Write FAILING tests that pin the requested behavior (happy path, boundaries, error paths, one abuse case). 3) Run them — confirm they fail for the RIGHT reason. 4) Hand off to implementation with the failing suite as the spec: report exactly which tests define done, then implement minimally until green. Never weaken assertions to pass.
